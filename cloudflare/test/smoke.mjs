'use strict';
/*
 * Smoke test (Cloudflare edition): boots `wrangler dev` (local workerd with
 * Durable Object emulation) on a test port, then plays a full game over real
 * WebSockets with the `ws` package — host + 3 players, facts, guesses (incl.
 * a duplicate), reveal/scoring, a "fooled the room" round, skip-to-finish,
 * leaderboard + recap, host reclaim, and rejoin-by-name.
 * Run: npm run test:smoke
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }).on('error', reject);
  });
}
async function waitUp() {
  for (let i = 0; i < 75; i++) { try { const r = await get('/healthz'); if (r.status === 200) return; } catch {} await wait(400); }
  throw new Error('wrangler dev did not come up');
}

/* Minimal client speaking the game's {type, payload} JSON protocol. */
function connect(room, role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?room=${room}&role=${role}`);
    const c = {
      ws, state: null, waiters: [], events: {},
      emit(type, payload) { ws.send(JSON.stringify({ type, payload: payload || {} })); },
      once(type, timeout = 5000) {
        if (c.events[type]) return Promise.resolve(c.events[type]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), timeout);
          (c.onceWaiters[type] = c.onceWaiters[type] || []).push((d) => { clearTimeout(t); res(d); });
        });
      },
      onceWaiters: {},
      until(pred, timeout = 5000) {
        if (c.state && pred(c.state)) return Promise.resolve(c.state);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for state')), timeout);
          c.waiters.push((s) => { if (pred(s)) { clearTimeout(t); res(s); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room:state') { c.state = msg.payload; c.waiters = c.waiters.filter(f => !f(msg.payload)); }
      else {
        c.events[msg.type] = msg.payload;
        (c.onceWaiters[msg.type] || []).splice(0).forEach(f => f(msg.payload));
      }
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

let dev;
try {
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stderr.on('data', d => process.stderr.write('[wrangler] ' + d));
  await waitUp();
  check('wrangler dev boots and /healthz returns 200', true);

  const root = await get('/');
  const hostPage = await get('/host');
  check('GET / and /host return 200', root.status === 200 && hostPage.status === 200);
  const extRefs = (html) => (html.match(/(?:src|href)\s*=\s*"https?:\/\/[^"]*"/g) || []).concat(html.match(/https?:\/\/(?!www\.w3\.org)[^\s"'<]+/g) || []);
  check('served pages make no external requests (no http(s) refs)', extRefs(root.body).length === 0 && extRefs(hostPage.body).length === 0,
    [...extRefs(root.body), ...extRefs(hostPage.body)].join(','));

  // Host creates a room
  const { body: codeBody } = await get('/api/code');
  const code = JSON.parse(codeBody).code;
  check('GET /api/code returns a 5-char room code', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(code), code);
  const host = await connect(code, 'host');
  const createdP = host.once('host:created');
  host.emit('host:create', { code, origin: BASE });
  const created = await createdP;
  check('host:create returns join URL + server-generated QR SVG for the request origin',
    created.code === code && created.joinUrl === `${BASE}/?room=${code}` && typeof created.qrSvg === 'string' && created.qrSvg.includes('<svg'),
    created.joinUrl);

  // Joining a non-existent room errors
  const ghost = await connect('ZZZZ9'.replace('9', '8'), 'player'); // ZZZZ8: valid charset, never created
  const ghostErrP = ghost.once('player:error');
  ghost.emit('player:join', { code: 'ZZZZ8', name: 'Ghost' });
  const ghostErr = await ghostErrP;
  check('joining a non-existent room returns player:error', /not found/i.test(String(ghostErr)), String(ghostErr));
  ghost.close();

  const names = ['Alice', 'Bob', 'Carol'];
  const facts = { Alice: 'I once sang on stage in front of 2,000 people', Bob: 'I can solve a Rubik cube in under a minute', Carol: 'I have lived in five countries' };
  const players = {};
  for (const n of names) {
    const c = await connect(code, 'player');
    const joinedP = c.once('player:joined');
    c.emit('player:join', { code, name: n });
    const j = await joinedP;
    players[n] = { c, id: j.playerId };
    c.emit('player:submitFact', { fact: facts[n] });
  }
  await host.until(s => s.players.length === 3 && s.players.every(p => p.hasFact));
  check('3 players join and all facts register in shared lobby state', true);

  const idByName = {}; host.state.players.forEach(p => idByName[p.name] = p.id);
  const ownerOfFact = (fact) => names.find(n => facts[n] === fact);

  host.emit('host:start');
  let st = await host.until(s => s.phase === 'playing' && s.round && s.round.number === 1);
  check('game starts: round 1 of 3, owner hidden pre-reveal', st.round.total === 3 && st.round.ownerId === null, `fact="${st.round.fact}"`);

  // The fact owner (and only the owner) privately receives player:ownRound
  let owner = ownerOfFact(st.round.fact);
  let others = names.filter(n => n !== owner);
  const ownRound = await players[owner].c.once('player:ownRound');
  check('owner privately receives player:ownRound for round 1', ownRound.number === 1);
  check('non-owners receive no ownRound signal', !players[others[0]].c.events['player:ownRound'] && !players[others[1]].c.events['player:ownRound']);

  // Round 1: one correct guess, one wrong guess, one duplicate (must be ignored)
  players[others[0]].c.emit('player:guess', { guessedId: idByName[owner] });     // correct
  players[others[1]].c.emit('player:guess', { guessedId: idByName[others[0]] }); // wrong
  await host.until(s => s.round && s.round.guessesIn === 2);
  players[others[0]].c.emit('player:guess', { guessedId: idByName[others[1]] }); // duplicate attempt
  await wait(400);
  check('duplicate guess in same round is ignored', host.state.round.guessesIn === 2, `guessesIn=${host.state.round.guessesIn}`);

  host.emit('host:reveal');
  st = await host.until(s => s.phase === 'revealed');
  const sc = Object.fromEntries(st.leaderboard.map(p => [p.name, p.score]));
  check('reveal: correct guesser scores 100, wrong guesser 0, owner named',
    sc[others[0]] === 100 && sc[others[1]] === 0 && st.round.ownerName === owner && st.round.fooled === false,
    JSON.stringify(sc));

  // Round 2: everyone guesses wrong on purpose -> fooled the room
  host.emit('host:next');
  st = await host.until(s => s.phase === 'playing' && s.round.number === 2);
  owner = ownerOfFact(st.round.fact);
  others = names.filter(n => n !== owner);
  for (const n of others) players[n].c.emit('player:guess', { guessedId: idByName[others.find(o => o !== n)] });
  await host.until(s => s.round && s.round.guessesIn === 2);
  host.emit('host:reveal');
  st = await host.until(s => s.phase === 'revealed' && s.round && s.round.number === 2);
  check('round 2: nobody correct -> flagged "fooled the room"', st.round.fooled === true);

  // Round 3: host skips the fact -> game finishes, recap holds only played rounds
  host.emit('host:next');
  st = await host.until(s => s.phase === 'playing' && s.round.number === 3);
  host.emit('host:skip');
  st = await host.until(s => s.phase === 'finished');
  check('skip on final round finishes game; recap has 2 played rounds', st.recap.length === 2, `recap=${st.recap.length}`);
  check('final leaderboard present with a 100-point leader', st.leaderboard[0].score === 100);

  // Host reclaim on a fresh connection returns the same room
  const host2 = await connect(code, 'host');
  const reclaimP = host2.once('host:created');
  host2.emit('host:reclaim', { code, origin: BASE });
  const reclaimed = await reclaimP;
  check('host:reclaim on a new connection returns the same room', reclaimed.code === code);
  host2.close();

  // Rejoin by name after "disconnect" reclaims the same player id
  players[names[0]].c.close();
  await wait(300);
  const re = await connect(code, 'player');
  const reJoinedP = re.once('player:joined');
  re.emit('player:join', { code, name: names[0] });
  const rj = await reJoinedP;
  check('rejoin by name+room reclaims the same player id', rj.playerId === players[names[0]].id);
  re.close();

  Object.values(players).forEach(p => p.c.close());
  host.close();
} catch (e) {
  check('smoke test completed without exception', false, e.message);
} finally {
  if (dev) dev.kill('SIGTERM');
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
