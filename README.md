# AMX Guess Who — real-time multiplayer party game

A clean-room "Guess Who" game for team meetings (inspired by the mechanics of
CrowdParty's Guess Who — no code, assets, or text copied). Everyone submits one
surprising fact about themselves; each round a fact appears anonymously and
everyone guesses whose it is. Great for getting to know each other.

- **Host screen** (laptop / shared screen): creates the room, shows the QR code
  and room code, controls rounds, reveals, leaderboard, podium.
- **Players** (phones): scan the QR, enter a name, submit a fact, tap a name to
  guess each round. No app install, no account.
- One small Node.js server holds the shared room state in memory. No database,
  no external services, no data collected — when the server stops, everything
  is gone.

## How to play (5–15 minutes)

1. Host opens the game URL + `/host`, clicks **Create room**.
2. Players scan the QR (or open the URL and type the 5-letter room code),
   enter their name, and submit ONE surprising, work-safe fact about themselves.
3. Host clicks **Start game** once everyone shows "✓ fact in".
4. Each round: a fact appears. Everyone except its owner taps who they think
   it belongs to (one locked guess each). Host clicks **Reveal answer** —
   correct guesses score **100 points**. A fact nobody gets is flagged
   **"fooled the room"**.
5. Rounds = number of facts (max 12, shuffled). Host can **Skip** a fact,
   and after the last round the podium and a full "who was who" recap appear.
   **Back to lobby** keeps players and facts for a rematch.

If a phone disconnects or refreshes, rejoining with the same name and room
code reclaims the same player and score.

---

## Deploy to Render (free) — the recommended way

This is a one-time setup. You need a free Render account and this folder in a
GitHub repo. No credit card is needed for Render's free plan.

### Step 1 — Put this folder on GitHub

1. Create a free account at https://github.com if you don't have one.
2. Create a **new repository** (e.g. `amx-guess-who`), and upload/commit all
   files in this folder — including `render.yaml` — to it.
   (Easiest no-command-line route: on the new repo page, "uploading an
   existing file", drag in the folder's contents. Don't upload `node_modules`
   — it's in `.gitignore` and Render installs dependencies itself.)

### Step 2 — Create the service on Render

1. Sign up / sign in at https://render.com (free).
2. In the Render dashboard: **New → Blueprint**.
3. Connect your GitHub account and pick the `amx-guess-who` repo.
4. Render reads `render.yaml`: one web service named `amx-guess-who`,
   **plan: free**, build `npm install`, start `npm start`. Confirm / **Apply**.
   (Equivalent manual route: **New → Web Service**, pick the repo, runtime
   Node, same build/start commands, instance type **Free**.)
5. Wait for the first deploy to finish (a few minutes). Render gives you a
   public URL like `https://amx-guess-who.onrender.com`.

### Step 3 — Play

- Host screen: `https://<your-url>.onrender.com/host`
- Players: scan the QR on the host screen — it points at the same public URL,
  so **any phone on any network** (mobile data or WiFi) can join. Nobody needs
  to be on the same WiFi, and nothing needs to run on a company laptop.

### Pre-meeting checklist (important — free plan sleeps!)

- [ ] **Wake it up early:** free Render services sleep after ~15 minutes idle
      and take **about 1 minute** to wake. Open the game URL **at least 5
      minutes before** the meeting and click around so it's warm.
- [ ] **Two-phone test:** with two phones, join the same room, submit facts,
      and confirm both names appear in the host lobby.
- [ ] **Company WiFi is fine:** because the game lives on the public internet,
      the meeting room only needs ordinary outbound internet. Personal phones
      on mobile data work too — no same-network requirement.
- [ ] Keep the host tab open during the game; if the host refreshes, use
      **Reclaim room** with the room code (rooms live in server memory —
      a server restart/deploy clears them, so don't redeploy mid-game).

Free-plan notes: the service may restart occasionally; room state is
in-memory by design (a restart ends any live room). For a one-off meeting
this is fine. If it becomes a regular thing, Render's first paid tier
removes the sleep behaviour.

---

## Run locally (fallback / testing)

Needs Node.js 18+ — or use the included portable runtime (below).

```bash
npm install   # once
npm start     # then open http://localhost:3000/host
```

The server listens on `process.env.PORT` (default 3000) on all interfaces.
Set `PORT` if 3000 is taken.

### Windows, no install: `start-windows.bat`

Double-click `start-windows.bat`. It uses a portable Node from a `runtime\`
folder if one is included in the copy you received, otherwise Node from PATH;
it installs nothing and explains itself if something is missing. Copy the
folder **with** its `node_modules` included for this mode.

If you run it on a laptop in the room instead of Render: phones must be able
to reach that laptop — same WiFi segment (corporate vs guest WiFi are usually
separate and won't work), or turn on the laptop's Mobile Hotspot, connect
everyone to it, restart the server, and pick the new address in the host
screen's QR selector.

## Files

| File | What it is |
|---|---|
| `server.js` | Express + Socket.IO server; all game state and rules |
| `public/host.html` | Host big-screen UI (QR, lobby, rounds, podium) |
| `public/index.html` | Player phone UI (join, fact, guess, score) |
| `render.yaml` | Render Blueprint (free web service) |
| `start-windows.bat` | Double-click local starter for Windows |
| `test/smoke.js` | Automated end-to-end smoke test (`npm run test:smoke`) |

Game rules in code: room codes are 5 characters (no look-alike letters);
correct guess = 100 points; one locked guess per player per round (duplicates
ignored); the fact owner sits out their own round and is only named at the
reveal; rounds are capped at 12.
