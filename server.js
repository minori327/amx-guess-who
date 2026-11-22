'use strict';
/*
 * AMX Guess Who — single-server real-time multiplayer party game.
 * Clean-room implementation. All state lives in memory on this server.
 * No database, no external requests at runtime.
 */
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = 12;
const POINTS_CORRECT = 100;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/join', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* All candidate addresses players/host can use on this machine. */
function lanAddresses() {
  const out = [{ label: 'This laptop only (localhost)', origin: `http://localhost:${PORT}` }];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ label: `${name} — http://${a.address}:${PORT}`, origin: `http://${a.address}:${PORT}`, ip: a.address });
      }
    }
  }
  return out;
}
app.get('/api/addresses', (_req, res) => res.json({ port: PORT, addresses: lanAddresses() }));

/* ---------------- state ---------------- */
const rooms = new Map(); // code -> room

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function newRoom(code) {
  return {
    code,
    hostSocketId: null,
    phase: 'lobby', // lobby | playing | revealed | finished
    players: new Map(), // playerId -> {id,name,socketId,fact,score,connected}
    order: [], // playerIds whose facts will be played, shuffled, capped
    roundIndex: -1,
    guesses: new Map(), // playerId -> guessedPlayerId (current round)
    revealed: false,
    lastRound: null, // {ownerId, ownerName, fact, fooled, correctPlayerIds[]}
    recap: [], // completed rounds: {fact, ownerName, fooled}
  };
}
function currentOwnerId(room) {
  return room.roundIndex >= 0 ? room.order[room.roundIndex] : null;
}
function publicState(room) {
  const ownerId = currentOwnerId(room);
  const owner = ownerId ? room.players.get(ownerId) : null;
  const eligible = [...room.players.values()].filter(p => p.connected && p.id !== ownerId).length;
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, hasFact: Boolean(p.fact), score: p.score, connected: p.connected,
  }));
  return {
    code: room.code,
    phase: room.phase,
    players,
    leaderboard: [...players].sort((a, b) => b.score - a.score),
    round: (room.phase === 'playing' || room.phase === 'revealed') && owner ? {
      number: room.roundIndex + 1,
      total: room.order.length,
      fact: owner.fact,
      guessesIn: room.guesses.size,
      eligible,
      // Owner is only exposed after reveal — never before.
      ownerId: room.revealed ? ownerId : null,
      ownerName: room.revealed ? owner.name : null,
      fooled: room.revealed ? room.lastRound.fooled : null,
      correctNames: room.revealed ? room.lastRound.correctNames : [],
    } : null,
    recap: room.phase === 'finished' ? room.recap : [],
  };
}
function broadcast(room) {
  io.to(room.code).emit('room:state', publicState(room));
  // Privately tell the fact owner it is their round (owner is never named publicly pre-reveal).
  if (room.phase === 'playing') {
    const owner = room.players.get(currentOwnerId(room));
    if (owner && owner.socketId) {
      io.to(owner.socketId).emit('player:ownRound', { number: room.roundIndex + 1 });
    }
  }
}

/* ---------------- sockets ---------------- */
io.on('connection', (socket) => {
  let hostCode = null;   // room this socket hosts
  let playerCtx = null;  // {code, playerId}

  async function qrFor(origin, code) {
    const base = (origin || '').replace(/\/$/, '');
    const joinUrl = `${base}/?room=${code}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 360, margin: 1 });
    return { joinUrl, qrDataUrl };
  }

  socket.on('host:create', async ({ origin } = {}) => {
    const code = makeCode();
    const room = newRoom(code);
    room.hostSocketId = socket.id;
    rooms.set(code, room);
    hostCode = code;
    socket.join(code);
    const { joinUrl, qrDataUrl } = await qrFor(origin, code);
    socket.emit('host:created', { code, joinUrl, qrDataUrl });
    broadcast(room);
  });

  // Host refreshed the page: reclaim the same room (room persists while server runs).
  socket.on('host:reclaim', async ({ code, origin } = {}) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('host:error', 'Room not found — it may have ended or the server restarted.');
    room.hostSocketId = socket.id;
    hostCode = room.code;
    socket.join(room.code);
    const { joinUrl, qrDataUrl } = await qrFor(origin, room.code);
    socket.emit('host:created', { code: room.code, joinUrl, qrDataUrl });
    broadcast(room);
  });

  // Host picked a different address for the QR (e.g. after switching WiFi/hotspot).
  socket.on('host:qr', async ({ origin } = {}) => {
    const room = hostRoomSafe();
    if (!room) return;
    const { joinUrl, qrDataUrl } = await qrFor(origin, room.code);
    socket.emit('host:qr', { joinUrl, qrDataUrl });
  });
  function hostRoomSafe() {
    if (!hostCode) return null;
    const room = rooms.get(hostCode);
    return room && room.hostSocketId === socket.id ? room : null;
  }

  socket.on('player:join', ({ code, name } = {}) => {
    const room = rooms.get((code || '').trim().toUpperCase());
    const cleanName = (name || '').trim().slice(0, 30);
    if (!room) return socket.emit('player:error', 'Room code not found. Check the code on the host screen.');
    if (!cleanName) return socket.emit('player:error', 'Please enter your name.');
    if (room.phase === 'playing' || room.phase === 'revealed') {
      // Late join is allowed only as a rejoin of an existing player.
      const existing = [...room.players.values()].find(p => p.name.toLowerCase() === cleanName.toLowerCase());
      if (!existing) return socket.emit('player:error', 'This game has already started. Ask the host about the next game.');
      existing.socketId = socket.id; existing.connected = true;
      playerCtx = { code: room.code, playerId: existing.id };
      socket.join(room.code);
      socket.emit('player:joined', { playerId: existing.id, code: room.code });
      return broadcast(room);
    }
    // Rejoin by name (refresh / reconnect) reclaims the same player slot.
    let player = [...room.players.values()].find(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (!player) {
      player = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: cleanName, socketId: socket.id, fact: '', score: 0, connected: true };
      room.players.set(player.id, player);
    } else {
      player.socketId = socket.id; player.connected = true;
    }
    playerCtx = { code: room.code, playerId: player.id };
    socket.join(room.code);
    socket.emit('player:joined', { playerId: player.id, code: room.code });
    broadcast(room);
  });

  socket.on('player:submitFact', ({ fact } = {}) => {
    if (!playerCtx) return;
    const room = rooms.get(playerCtx.code); if (!room) return;
    const player = room.players.get(playerCtx.playerId); if (!player) return;
    if (room.phase !== 'lobby') return socket.emit('player:error', 'Facts are locked — the game has started.');
    player.fact = (fact || '').trim().slice(0, 280);
    broadcast(room);
  });

  socket.on('player:guess', ({ guessedId } = {}) => {
    if (!playerCtx) return;
    const room = rooms.get(playerCtx.code); if (!room) return;
    if (room.phase !== 'playing' || room.revealed) return;
    const ownerId = currentOwnerId(room);
    if (playerCtx.playerId === ownerId) return; // owner sits out their own round
    if (guessedId === playerCtx.playerId) return; // cannot guess yourself
    if (!room.players.has(guessedId)) return;
    if (room.guesses.has(playerCtx.playerId)) return; // one locked guess per round
    room.guesses.set(playerCtx.playerId, guessedId);
    broadcast(room);
  });

  function hostRoom() {
    if (!hostCode) return null;
    const room = rooms.get(hostCode);
    return room && room.hostSocketId === socket.id ? room : null;
  }

  socket.on('host:start', () => {
    const room = hostRoom(); if (!room) return;
    const withFacts = [...room.players.values()].filter(p => p.fact);
    if (withFacts.length < 2) return socket.emit('host:error', 'Need at least 2 players who have submitted a fact.');
    room.order = shuffle(withFacts.map(p => p.id)).slice(0, MAX_ROUNDS);
    room.roundIndex = 0;
    room.guesses.clear();
    room.revealed = false;
    room.lastRound = null;
    room.recap = [];
    room.players.forEach(p => { p.score = 0; });
    room.phase = 'playing';
    broadcast(room);
  });

  socket.on('host:reveal', () => {
    const room = hostRoom(); if (!room) return;
    if (room.phase !== 'playing' || room.revealed) return;
    const ownerId = currentOwnerId(room);
    const owner = room.players.get(ownerId);
    const correctNames = [];
    room.guesses.forEach((guessedId, pid) => {
      if (guessedId === ownerId) {
        const p = room.players.get(pid);
        p.score += POINTS_CORRECT;
        correctNames.push(p.name);
      }
    });
    const fooled = correctNames.length === 0;
    room.lastRound = { ownerId, ownerName: owner.name, fact: owner.fact, fooled, correctNames };
    room.recap.push({ fact: owner.fact, ownerName: owner.name, fooled });
    room.revealed = true;
    room.phase = 'revealed';
    broadcast(room);
  });

  socket.on('host:next', () => {
    const room = hostRoom(); if (!room) return;
    if (room.phase !== 'revealed') return;
    if (room.roundIndex + 1 >= room.order.length) {
      room.phase = 'finished';
    } else {
      room.roundIndex += 1;
      room.guesses.clear();
      room.revealed = false;
      room.lastRound = null;
      room.phase = 'playing';
    }
    broadcast(room);
  });

  // Skip the current fact entirely: no points, no recap entry.
  socket.on('host:skip', () => {
    const room = hostRoom(); if (!room) return;
    if (room.phase !== 'playing' || room.revealed) return;
    if (room.roundIndex + 1 >= room.order.length) {
      room.phase = 'finished';
    } else {
      room.roundIndex += 1;
      room.guesses.clear();
      room.revealed = false;
      room.lastRound = null;
    }
    broadcast(room);
  });

  socket.on('host:restart', () => {
    const room = hostRoom(); if (!room) return;
    room.phase = 'lobby';
    room.order = []; room.roundIndex = -1;
    room.guesses.clear(); room.revealed = false; room.lastRound = null; room.recap = [];
    room.players.forEach(p => { p.score = 0; }); // facts & players kept for a fast rematch
    broadcast(room);
  });

  socket.on('host:end', () => {
    const room = hostRoom(); if (!room) return;
    io.to(room.code).emit('room:ended');
    rooms.delete(room.code);
    hostCode = null;
  });

  socket.on('disconnect', () => {
    if (playerCtx) {
      const room = rooms.get(playerCtx.code);
      const player = room && room.players.get(playerCtx.playerId);
      if (player && player.socketId === socket.id) { player.connected = false; broadcast(room); }
    }
    // Host disconnect does NOT delete the room — host can reclaim it after a refresh.
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================================');
  console.log('  AMX Guess Who server is running. Keep this window open.');
  console.log('============================================================');
  console.log('  Open the HOST screen at any of these addresses:');
  for (const a of lanAddresses()) console.log(`    ${a.origin}/host   (${a.label})`);
  console.log('');
  console.log('  Players join at the same address WITHOUT /host');
  console.log('  (or by scanning the QR code on the host screen).');
  console.log('  Phones must be on a network that can reach this laptop —');
  console.log('  see README: same WiFi segment, or use a hotspot.');
  console.log('============================================================');
});
