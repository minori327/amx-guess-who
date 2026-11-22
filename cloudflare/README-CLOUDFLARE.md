# AMX Guess Who — Cloudflare Edition (free plan, no credit card)

Same game as the Node version in the parent folder — same look, wording and
rules — re-platformed onto **Cloudflare Workers + Durable Objects** so it can
run on Cloudflare's free plan: no server to babysit, no credit card, and
players can join from any network (the Render free tier turned out to require
a card just to verify identity; Cloudflare's free plan does not).

- Host page: `https://amx-guess-who.<your-subdomain>.workers.dev/host`
- Player page: `https://amx-guess-who.<your-subdomain>.workers.dev/`
  (the QR on the host screen encodes `…/?room=CODE`)

## How it maps from the Node version

| Node version (parent folder) | Cloudflare version (this folder) |
|---|---|
| Express + `server.js`, one process | Single-file Worker `src/worker.js` (fetch handler + pages) |
| `rooms` Map in server memory | One `Room` Durable Object per room code (`env.ROOMS.idFromName(code)`), state persisted to DO storage after every change |
| Socket.IO rooms + events | Native WebSocket to `/ws?room=CODE&role=host\|player`, JSON messages `{type, payload}` (event names unchanged — see table below) |
| `socket.id` identity | Per-socket attachment (`serializeAttachment`: `{role, playerId}`), survives WebSocket hibernation |
| `qrcode` npm package → PNG data URL | Same QR content, generated **server-side in the DO** with a vendored pure-JS encoder (Kazuhiko Arase's qrcode-generator, MIT, inlined in `worker.js`) and returned as an **SVG string** (`qrSvg`) |
| `/api/addresses` (LAN candidates) + QR address picker | Gone — on workers.dev there is one public origin, and the QR encodes the origin the host page was opened with |
| `PORT` env / `start-windows.bat` | Not applicable — Cloudflare hosts it |

### Socket.IO events → WebSocket messages

Every message is JSON: `{ "type": "<event name>", "payload": { … } }`.
Event names and payload fields are the same as the Socket.IO version.

| Direction | Socket.IO event | WS message type | Notes |
|---|---|---|---|
| host → server | `host:create` | `host:create` | Now sent over a WS already routed by `/ws?room=CODE`; payload `{code, origin}` (code comes from `GET /api/code`) |
| host → server | `host:reclaim` | `host:reclaim` | Same semantics: room persists in DO storage, new host socket takes over |
| host → server | `host:qr` | `host:qr` | Response payload carries `qrSvg` instead of `qrDataUrl` |
| host → server | `host:start` / `host:reveal` / `host:next` / `host:skip` / `host:restart` / `host:end` | same names | Host-only: enforced by the socket attachment's `role: 'host'` |
| player → server | `player:join` / `player:submitFact` / `player:guess` | same names | Room code travels in the WS URL; duplicate guess in a round is ignored, exactly as before |
| server → all | `room:state` | `room:state` | Same public-state shape; owner never exposed before reveal |
| server → owner | `player:ownRound` | `player:ownRound` | Private signal to the fact owner's socket only |
| server → host | `host:created` / `host:qr` / `host:error` | same names | `host:created` payload: `{code, joinUrl, qrSvg}` |
| server → player | `player:joined` / `player:error` / `room:ended` | same names | — |

Game rules are unchanged: 5-char room codes, one fact per player, rounds =
facts (cap 12, shuffled), correct guess = 100 pts, all-wrong round = "fooled
the room", skip gives no points and no recap entry, rejoin by name reclaims
the player, host disconnect never deletes the room.

One deliberate difference: the pages open their WebSocket lazily (host on
Create/Reclaim, player on Join) and auto-reconnect with reclaim/rejoin if the
socket drops — Socket.IO did this invisibly before.

## Local development

```bash
cd cloudflare
npm install          # installs wrangler + ws (test client)
npm run dev          # wrangler dev — local workerd with DO emulation
npm run test:smoke   # boots wrangler dev on port 8797 and plays a full game
                     # with host + 3 simulated players over real WebSockets
```

Then open `http://localhost:8787/host` in one browser tab and
`http://localhost:8787/` in another to play by hand.

## Deploy (owner steps — free, no card)

You need a free Cloudflare account: sign up at <https://dash.cloudflare.com>
(email + password is enough; **no credit card** on the free plan).

### Option A — Workers Git integration (recommended, no local tools)

1. Push this repo to GitHub (it already lives at
   `github.com/minori327/amx-guess-who`; the Cloudflare edition is the
   `cloudflare/` folder).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Workers →
   Import a repository** (Connect to Git), pick `minori327/amx-guess-who`.
3. Set the **root directory** to `cloudflare` (the folder containing
   `wrangler.toml`). Build command: leave empty / `npm install`; deploy
   command: `npx wrangler deploy`.
4. Deploy. Cloudflare reads `wrangler.toml`, creates the SQLite Durable
   Object migration (`v1`), and publishes to
   `https://amx-guess-who.<your-subdomain>.workers.dev`.
5. Open `…/host`, create a room, and have two phones join by QR to test.

### Option B — Wrangler CLI from your computer

```bash
cd cloudflare
npm install
npx wrangler login   # opens the browser, authorize once
npx wrangler deploy
```

The resulting URL is printed by the deploy:
`https://amx-guess-who.<your-subdomain>.workers.dev` — host page at `/host`.

## Free-plan limits that matter

- **Workers: 100,000 requests/day** (resets midnight UTC). Page loads and
  `/api/code` count; WebSocket *messages* after the upgrade do not count as
  requests — one upgrade request per connection. A meeting uses a few
  hundred requests at most.
- **Durable Objects (free plan requires the SQLite backend — configured):**
  100,000 requests/day and 13,000 GB-s/day duration across all DOs; storage
  5 GB total / 1 MB per value (a room's state is a few KB). One game's room
  is a single DO; a meeting is nowhere near these numbers.
- **Overage = hard stop, not a bill.** On the free plan, exceeding a quota
  returns errors (HTTP 429 / failed requests) until the daily reset — there
  is no card on file and nothing can be charged. The failure mode during a
  meeting would be "game stops responding", never a surprise invoice.
- **Worker script size:** this Worker is ~92 KB source — far under the free
  plan's 1 MB (compressed) limit.
- Rooms live in DO storage and persist until the host ends them; there is no
  automatic expiry. End rooms after meetings (`End room` button) to keep
  storage tidy.

## Files

```
cloudflare/
  wrangler.toml        # name, DO binding ROOMS -> Room, SQLite migration v1
  package.json         # wrangler devDependency; scripts: dev / deploy / test:smoke
  src/worker.js        # EVERYTHING: pages, Worker router, Room DO, QR encoder
  test/smoke.mjs       # full-game WebSocket smoke test against wrangler dev
  README-CLOUDFLARE.md # this file
```
