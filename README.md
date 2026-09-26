# File Transfer.

Plain, corporate, no-nonsense file transfer between computers and phones.

One device starts a session and gets a six-character code. The other device
enters the code (or opens the share link). The server introduces them over
WebRTC signalling and then steps out of the way: **file bytes travel directly
between the two devices and never touch the server.** Nothing is stored, and
sessions expire after an hour.

Built with Next.js (App Router) and designed to be deployed on Vercel with no
extra services required beyond one small key-value store for signalling.

## What it does

- **Any file type, up to 1 GB per file** (configurable), transferred as a queue
  with per-file progress, speed and status.
- **Either device can send**, in both directions, in the same session.
- **Receivers choose**: stream straight to disk where the File System Access
  API exists (Chrome/Edge), or buffer and download automatically (Safari,
  Firefox, phones).
- **Queue + rate limits**: the server enforces per-IP budgets (sessions, joins,
  files sent, files received). When a budget runs out the queue pauses, shows a
  countdown and retries automatically; the receiving side can also decline
  individual files before any bytes flow.
- **Sessions are private by construction**: codes are unguessable within the
  join rate limit, one receiver per session, DTLS/SRTP encrypts the transfer,
  and everything is deleted when the session ends.
- **Monochrome corporate UI**: greys only, system fonts, no animation, works
  from 390 px phones to desktops.

## How a transfer happens

```
 Device A (sender)                Server (Vercel)               Device B (receiver)
      |  POST /api/rooms                |                                |
      | ------------------------------> |  code ABCDEF created (1 h TTL) |
      |                                 | <----------------------------- |  POST /join
      |        signalling: hello, offer, answer, ICE candidates          |
      | <===========================>   |   (polls, tiny JSON only)      |
      |                                                                |
      |  WebRTC data channel, 64 KiB chunks with backpressure           |
      | ==============================================================> |
      |                                 |   POST /transfers (rate limit) |
```

The server sees three kinds of tiny JSON documents — the room record, the
SDP/ICE signalling messages, and transfer declarations used for rate limiting.
It never sees file content.

## Quick start (local)

```bash
npm install
npm run dev          # http://localhost:3000
```

Local development needs no configuration: signalling falls back to an
in-process store. Open the app in two browser windows (or a window and a phone
on your LAN) and transfer between them.

For a production-mode run locally:

```bash
npm run build && npm start
```

## Deploy to Vercel

1. Push this repository to GitHub and import it in Vercel
   (**Add New → Project**). The framework is detected automatically.
2. Add **one** signalling store (see below) in **Project → Settings →
   Environment Variables**. Without it, serverless functions cannot share
   sessions and the app shows a setup banner.
3. Deploy. That is the whole deployment — there is no database, no worker and
   no WebSocket server.

### Signalling store options

**Option A — Upstash Redis (recommended).** In Vercel, **Storage → Create
Database → Upstash Redis**, or add *Upstash* from the Marketplace. Vercel sets
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for you. Keys carry a
TTL equal to the session lifetime, so nothing accumulates. The free tier is
comfortably enough — only SDP/ICE messages are stored.

**Option B — Vercel Blob.** Create a Blob store in the Vercel dashboard;
`BLOB_READ_WRITE_TOKEN` is provided automatically. Signalling documents are
written under `ft-signalling/` as private blobs and the daily cron in
`vercel.json` (`/api/cron/cleanup`) deletes expired ones. Set `CRON_SECRET` in
the project settings to protect that endpoint.

**Local / single instance.** With neither configured the app uses an
in-process store. That is fine for development and for a single long-lived
process, but not for Vercel's many short-lived functions.

### TURN relay (optional, recommended for mobile networks)

Most home and office networks connect peer-to-peer with the bundled STUN
server. When *both* devices are behind symmetric NATs — typical for mobile
carrier networks — a TURN relay is required. Point the variables below at any
TURN service (for example Twilio NTS, Metered, or your own coturn); the
credentials are only released to clients that present a valid session code:

```
TURN_URL=turn:relay.example.com:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Signalling store + rate limit counters (recommended). |
| `BLOB_READ_WRITE_TOKEN` | – | Alternative signalling store via Vercel Blob. |
| `BLOB_SIGNALLING_ACCESS` | `private` | `private` or `public` blob access for signalling documents. |
| `SIGNAL_STORE` | auto | Force `redis`, `blob` or `memory`. |
| `ROOM_TTL_SECONDS` | `3600` | Session lifetime. |
| `MAX_FILE_BYTES` | `1GB` | Per-file cap (accepts `500MB`, `2GB`, …). Checked in the browser and on transfer declarations. |
| `MAX_FILES_PER_SESSION` | `50` | Queue length per session. |
| `RATE_LIMIT_PRESET` | `balanced` | `strict`, `balanced` or `relaxed`. |
| `RATE_LIMIT_<BUCKET>` | per preset | Override one bucket, e.g. `RATE_LIMIT_UPLOAD=40`. Buckets: `ROOMS`, `JOIN`, `SIGNALWRITE`, `SIGNALREAD`, `UPLOAD`, `DOWNLOAD`, `CLOSE`, `CONFIG`. |
| `STUN_URL` | Google STUN | Comma separated STUN URLs. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Optional TURN relay, released only with a valid session code. |
| `CRON_SECRET` | – | Protects `/api/cron/cleanup` (Vercel Cron sends it automatically). |

### Rate limits (balanced preset, per IP, per hour)

| Bucket | Limit | What it guards |
| --- | --- | --- |
| New sessions | 5 | Session creation spam. |
| Session joins | 20 | Code guessing / brute force. |
| Files sent | 20 | Each file declared before transfer starts. |
| Files received | 60 | Each file accepted by the receiver. |
| Signalling writes / reads | 300 / 5400 | Per session; polling-friendly. |

When a bucket is exhausted the API answers `429` with `Retry-After`, the client
pauses that queue item, shows the countdown in the UI and retries when the
window resets. Because file bytes never pass through the server, the
send/receive budgets are enforced at the point where each side declares a
transfer — a modified client could bypass them, but it would gain nothing
except its own bandwidth.

## Testing

```bash
npm test            # HTTP API contract: rooms, join, signalling, budgets, close
npm run test:limits # rate limiter, needs a second server with tiny budgets:
                    #   RATE_LIMIT_ROOMS=2 RATE_LIMIT_UPLOAD=2 RATE_LIMIT_DOWNLOAD=2 \
                    #     npx next start --port 3100
npm run test:e2e    # two real browser contexts: connect, decline, transfer
                    # 8 MB + 120 KB + 3 MB in both directions, verify sha256
```

The end-to-end test needs a Chromium. It uses `FT_CHROMIUM_PATH` or
`@sparticuz/chromium` when present, otherwise Playwright's bundled browser
(`npx playwright install chromium`). `FT_LD_LIBRARY_PATH` lets sandboxed CI
runners supply missing NSS/NSPR libraries. Run the E2E test against a fresh
server instance: it creates sessions and would otherwise share the hourly rate
limit budget with your manual testing.

## Project layout

```
app/
  page.tsx                     landing + console (server component)
  layout.tsx                   chrome, footer with live limits/config
  globals.css                  the whole monochrome design system
  api/rooms/route.ts           create session
  api/rooms/[code]/join/       second device joins (one guest per session)
  api/rooms/[code]/signal/     GET poll + POST append of SDP/ICE messages
  api/rooms/[code]/transfers/  declares a transfer, consumes rate budgets
  api/rooms/[code]/close/      ends a session for both devices
  api/cron/cleanup/            Vercel Cron: purges expired Blob signalling
  api/config/, api/health/     client config (ICE servers, limits), smoke test
lib/
  config.ts, ratelimit.ts, redis.ts, codes.ts, protocol.ts
  store/                       signalling stores: redis.ts, blob.ts, memory.ts
  client/session.ts            WebRTC + queue + flow control engine
  client/api.ts, types.ts
components/                    TransferConsole, SessionHeader, Send/Receive
                               sections, notices, primitives
tests/                         api.mjs, p2p.mjs
```

## Security and privacy notes

- File content is end-to-end encrypted by DTLS/SRTP and never leaves the two
  devices.
- Signalling payloads (SDP + ICE candidates) pass through the store; they
  contain network addresses needed to connect. With the Blob store they are
  private blobs; with Redis they expire with the session.
- A session code is the only capability needed to join, so treat the link like
  a one-time password: it admits exactly one receiver until the session ends.
  Join attempts are rate limited per IP and only session members may read or
  write its signalling log.
- No cookies, no accounts, no analytics, no third-party requests.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| “No signalling store is configured” banner on Vercel | Set `UPSTASH_REDIS_REST_URL`/`TOKEN` (or `BLOB_READ_WRITE_TOKEN`) and redeploy. |
| Connection fails after ~45 s | Both devices are behind restrictive NATs. Configure a TURN relay. |
| Transfer stalls on “Waiting” | The receiver has not accepted the file yet (ask-where-to-save mode). |
| `429` in the UI | A per-IP budget ran out. The countdown shows when it resets; presets can be raised via `RATE_LIMIT_*`. |
| Large file fails on a phone | Memory-mode receivers buffer before downloading. Use a desktop browser with a save-location picker, or smaller files. |
