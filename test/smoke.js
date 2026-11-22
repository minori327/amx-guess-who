'use strict';
/*
 * Smoke test: boots the real server on a test port, then plays a game with
 * socket.io-client — host + 3 players, facts, guesses (incl. a duplicate),
 * reveal/scoring, a "fooled the room" round, skip, and the finish/podium.
 * Run: npm run test:smoke
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3219;
const BASE = `http://127.0.0.1:${PORT}`;
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
  for (let i = 0; i < 50; i++) { try { const r = await get('/healthz'); if (r.status === 200) return; } catch {} await wait(200); }
  throw new Error('server did not come up');
}
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket', 'polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function once(sock, ev, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), timeout);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}
// Track latest room:state per socket
function track(sock) {
  const h = { state: null, waiters: [] };
  sock.on('room:state', (s) => { h.state = s; h.waiters = h.waiters.filter(f => !f(s)); });
  h.until = (pred, timeout = 4000) => new Promise((resolve, reject) => {
    if (h.state && pred(h.state)) return resolve(h.state);
    const t = setTimeout(() => reject(new Error('timeout waiting for state')), timeout);
    h.waiters.push((s) => { if (pred(s)) { clearTimeout(t); resolve(s); } });
  });
  return h;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
  try {
    await waitUp();
    check('server boots and /healthz returns 200', true);

    const host = await connect(); const hs = track(host);
    host.emit('host:create', { origin: BASE });
    const created = await once(host, 'host:created');
    const code = created.code;
    check('host creates room with 5-char code', /^[A-Z2-9]{5}$/.test(code), code);
    check('QR data URL + join URL returned for request origin',
      created.qrDataUrl.startsWith('data:image/png') && created.joinUrl === `${BASE}/?room=${code}`, created.joinUrl);

    const names = ['Alice', 'Bob', 'Carol'];
    const facts = { Alice: 'I once sang on stage in front of 2,000 people', Bob: 'I can solve a Rubik cube in under a minute', Carol: 'I have lived in five countries' };
    const players = {};
    for (const n of names) {
      const s = await connect(); const st = track(s);
      const joinedP = once(s, 'player:joined');
      s.emit('player:join', { code, name: n });
      const j = await joinedP;
      players[n] = { sock: s, st, id: j.playerId };
      s.emit('player:submitFact', { fact: facts[n] });
    }
    await hs.until(s => s.players.length === 3 && s.players.every(p => p.hasFact));
    check('3 players join and all facts register in shared lobby state', true);

    const idByName = {}; hs.state.players.forEach(p => idByName[p.name] = p.id);
    const ownerOfFact = (fact) => names.find(n => facts[n] === fact);

    host.emit('host:start');
    let st = await hs.until(s => s.phase === 'playing' && s.round && s.round.number === 1);
    check('game starts: round 1 of 3, owner hidden pre-reveal', st.round.total === 3 && st.round.ownerId === null, `fact="${st.round.fact}"`);

    // Round 1: one correct guess, one wrong guess, one duplicate (must be ignored)
    let owner = ownerOfFact(st.round.fact);
    let others = names.filter(n => n !== owner);
    players[others[0]].sock.emit('player:guess', { guessedId: idByName[owner] });       // correct
    players[others[1]].sock.emit('player:guess', { guessedId: idByName[others[0]] });   // wrong
    await hs.until(s => s.round && s.round.guessesIn === 2);
    players[others[0]].sock.emit('player:guess', { guessedId: idByName[others[1]] });   // duplicate attempt
    await wait(300);
    check('duplicate guess in same round is ignored', hs.state.round.guessesIn === 2, `guessesIn=${hs.state.round.guessesIn}`);

    host.emit('host:reveal');
    st = await hs.until(s => s.phase === 'revealed');
    const sc = Object.fromEntries(st.leaderboard.map(p => [p.name, p.score]));
    check('reveal: correct guesser scores 100, wrong guesser 0, owner named',
      sc[others[0]] === 100 && sc[others[1]] === 0 && st.round.ownerName === owner && st.round.fooled === false,
      JSON.stringify(sc));

    // Round 2: everyone guesses wrong on purpose -> fooled the room
    host.emit('host:next');
    st = await hs.until(s => s.phase === 'playing' && s.round.number === 2);
    owner = ownerOfFact(st.round.fact);
    others = names.filter(n => n !== owner);
    for (const n of others) players[n].sock.emit('player:guess', { guessedId: idByName[others.find(o => o !== n)] });
    await hs.until(s => s.round && s.round.guessesIn === 2);
    host.emit('host:reveal');
    st = await hs.until(s => s.phase === "revealed" && s.round && s.round.number === 2);
    check('round 2: nobody correct -> flagged "fooled the room"', st.round.fooled === true);

    // Round 3: host skips the fact -> game finishes, recap holds only played rounds
    host.emit('host:next');
    st = await hs.until(s => s.phase === 'playing' && s.round.number === 3);
    host.emit('host:skip');
    st = await hs.until(s => s.phase === 'finished');
    check('skip on final round finishes game; recap has 2 played rounds', st.recap.length === 2, `recap=${st.recap.length}`);
    check('final leaderboard present with a 100-point leader', st.leaderboard[0].score === 100);

    // Rejoin by name after "disconnect"
    const re = await connect(); const reJoined = once(re, 'player:joined');
    players[names[0]].sock.disconnect();
    re.emit('player:join', { code, name: names[0] });
    const rj = await reJoined;
    check('rejoin by name+room reclaims the same player id', rj.playerId === players[names[0]].id);
    re.disconnect();

    Object.values(players).forEach(p => p.sock.disconnect());
    host.disconnect();
  } catch (e) {
    check('smoke test completed without exception', false, e.message);
  } finally {
    srv.kill();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
