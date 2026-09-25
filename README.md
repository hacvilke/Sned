# Sned

Send files between your computers and phones. Queue as many files as you like, get one link,
open it on the other device. Any file type. No account, no software to install.

Plain on purpose: no animations, no gradients, one accent colour. Built to be readable on a
phone screen and to cost nothing to run.

---

## Quick start (local)

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no environment variables set, Sned runs in **memory mode**:
files are buffered in the server process and capped at 25 MB. That is enough to develop and
demo against, but it is not a real deployment — see below.

```bash
npm test        # unit tests (queue validation, share lifecycle, rate limiting)
npm run typecheck
npm run build
```

---

## Deploying to Vercel

Sned needs two external services. Both have free tiers that comfortably cover personal use.

### 1. Storage — Vercel Blob

File bytes go straight from the browser to Blob storage. They never pass through a serverless
function, which is what lets a transfer be far larger than the 4.5 MB function request-body cap.

```bash
npx vercel blob stores create
```

Then link the store to your project (the Vercel dashboard does this automatically if you
create the store from the project's Storage tab):

```bash
npx vercel env add BLOB_READ_WRITE_TOKEN
```

### 2. Rate limiting + share records — Upstash Redis

Share records, upload reservations and rate-limit counters all live in Redis. Without it,
limits are enforced per serverless instance, which a load balancer defeats almost immediately.

Create an Upstash Redis database (or use Vercel's "Upstash for Redis" integration), then:

```bash
npx vercel env add UPSTASH_REDIS_REST_URL
npx vercel env add UPSTASH_REDIS_REST_TOKEN
```

### 3. Cron secret

The daily cleanup job authenticates with a secret. Vercel sends it automatically on scheduled
runs; setting it also lets you trigger a sweep by hand.

```bash
npx vercel env add CRON_SECRET
```

### 4. Deploy

```bash
npx vercel --prod
```

Check it came up correctly:

```bash
curl https://your-domain/api/health
```

`"status":"ok"` means both Blob and Redis are wired up. `"degraded"` lists exactly what is
missing.

### 5. Set a Blob lifecycle rule

Share records expire on their own, and the cleanup cron deletes the matching blobs. As a
backstop, set a lifecycle rule on the store (Blob settings → Lifecycle) to delete objects
older than your `TTL_HOURS`. This catches anything written before the cron existed.

---

## How it works

```
sender                      Vercel                       storage
  |  POST /api/share          |                              |
  |-------------------------->| code issued immediately      |
  |  POST /api/upload/start   |  rate limits + size checks   |
  |-------------------------->| returns a one-path token     |
  |                           |                              |
  |  PUT <file bytes> ────────|──────────────────────────────>|  (direct to Blob)
  |                           |                              |
  |  POST /api/upload/complete|  head() verifies size/url    |
  |-------------------------->| attaches file to the batch   |
  |                           |                              |
recipient  GET /d/<code>  --->|  file list, live-updating    |
           GET /api/download  |  302 -> Blob downloadUrl     |
```

**The link exists before the first byte lands.** The recipient can open it on their phone
immediately and watch files appear as each one finishes. That is what makes phone-to-computer
transfers usable: you are not waiting for the whole batch before you can start.

**Uploads are queued client-side**, two at a time by default. You can add files while the queue
is running, pause, cancel individual files, and retry failures. When the server returns 429, the
queue backs off for the stated `Retry-After` period instead of hammering.

**Nothing about the upload is taken on trust.** `/api/upload/complete` receives only an
`uploadId`; it reads the object back from Blob with `head()` to get the authoritative URL and
size, and refuses the file if the size does not match what was reserved.

---

## Rate limits

All limits are per IP address over a rolling window, and every one is overridable by an
environment variable.

| Limit                        | Default  | Env var                 |
| ---------------------------- | -------- | ----------------------- |
| Max file size                | 250 MB   | `MAX_FILE_BYTES`        |
| Max per transfer             | 1 GB     | `MAX_BATCH_BYTES`       |
| Files per transfer           | 50       | `MAX_FILES_PER_BATCH`   |
| Transfers opened per minute  | 8        | `BATCHES_PER_MINUTE`    |
| Uploads started per minute   | 20       | `UPLOADS_PER_MINUTE`    |
| Uploads per day              | 300      | `UPLOADS_PER_DAY`       |
| Data uploaded per day        | 5 GB     | `BYTES_PER_DAY`         |
| Downloads per minute         | 60       | `DOWNLOADS_PER_MINUTE`  |
| Link lifetime                | 24 h     | `TTL_HOURS`             |
| Concurrent uploads           | 2        | `UPLOAD_CONCURRENCY`    |

A throttled request returns `429` with `Retry-After`, plus `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset` on every response.

---

## API

| Method | Path                            | Purpose                                        |
| ------ | ------------------------------- | ---------------------------------------------- |
| `POST` | `/api/share`                    | Open a transfer batch, get a code              |
| `GET`  | `/api/share/:code`              | List files in a batch                          |
| `POST` | `/api/share/:code/seal`         | Mark the batch finished (owner only)           |
| `POST` | `/api/upload/start`             | Reserve a slot, get a one-path upload token    |
| `POST` | `/api/upload/complete`          | Verify the object and attach it to the batch   |
| `POST` | `/api/upload/put`               | Dev-only: buffer bytes in memory               |
| `GET`  | `/api/download/:code?file=<id>` | 302 to the Blob download URL                   |
| `GET`  | `/api/config`                   | Public limits                                  |
| `GET`  | `/api/health`                   | Deployment self-check                          |
| `GET`  | `/api/cron/cleanup`             | Delete expired blobs (Vercel Cron)             |

---

## Notes and limits worth knowing

- **A transfer code is a bearer secret.** Anyone with the link can download. Codes are 6
  characters from a 32-symbol alphabet with `0`, `1`, `I` and `O` removed, so they cannot be
  mistyped or guessed quickly. Download pages are `noindex`.
- **Blob objects are `access: 'public'`.** The object URL itself is unguessable and short-lived,
  but if you need hard access control, switch to private blobs and proxy reads through
  `/api/download`. That trades the 60s function limit for real authorisation.
- **Upload tokens are pinned to one pathname** and one size, and expire in 30 minutes
  (`UPLOAD_TOKEN_SECONDS`). A leaked token can write exactly one object.
- **Memory mode is not a deployment.** Without `BLOB_READ_WRITE_TOKEN`, uploads are buffered in
  the process, capped at `MAX_DEV_FILE_BYTES`, and lost on restart. `/api/health` warns loudly.
- **Inline preview.** Downloads are served from Blob's `downloadUrl`, which sets
  `Content-Disposition: attachment`, so browsers save rather than open.
- **Vercel Hobby cron runs once per day**, which is the finest schedule `vercel.json` requests.
  Pro plans can run `/api/cron/cleanup` more often.

---

## Layout

```
src/
  app/
    page.tsx                 send page
    d/page.tsx               enter a code
    d/[code]/page.tsx        recipient view (server-rendered, then live-updating)
    api/...                  the routes above
  lib/
    limits.ts                every tunable, with env override
    kv.ts                    Redis, or an in-process fallback
    ratelimit.ts             Upstash sliding window, or an in-process fallback
    share.ts                 share records, upload reservations, expiry index
    storage.ts               Vercel Blob, or an in-process fallback
    preflight.ts             queue validation (pure, unit tested)
  components/                TransferPanel, DropZone, FileRow, ShareLinkCard, ...
tests/                       unit tests against the real modules
```

Both `kv.ts` and `ratelimit.ts` fall back to in-process stores so the app runs with zero
configuration. The fallbacks are honest about it: `/api/health` reports `"degraded"` and names
what is missing.
