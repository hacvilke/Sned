/**
 * HTTP API tests: session lifecycle, signalling, transfer budgets, rate limits.
 *
 *   node tests/api.mjs [baseUrl] [--limits <rooms> <upload> <download>]
 *
 * Two modes:
 *   default   verifies the API contract against a normally configured server
 *   --limits  verifies the rate limiter; needs a server started with matching
 *             small budgets, because the two modes would consume each other's
 *             allowance:
 *
 *     RATE_LIMIT_ROOMS=2 RATE_LIMIT_UPLOAD=2 RATE_LIMIT_DOWNLOAD=2 \
 *       npx next dev --port 3100
 *     node tests/api.mjs http://127.0.0.1:3100 --limits 2 2 2
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const limitsArg = process.argv.indexOf('--limits');
const limits =
  limitsArg > -1
    ? {
        rooms: Number(process.argv[limitsArg + 1]),
        upload: Number(process.argv[limitsArg + 2]),
        download: Number(process.argv[limitsArg + 3]),
      }
    : null;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n  ${title}`);
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload, headers: response.headers };
}

async function basicTests() {
  section('health and config');

  const health = await call('GET', '/api/health');
  check('GET /api/health returns 200', health.status === 200, `status ${health.status}`);
  check('health reports a store', Boolean(health.body?.store), JSON.stringify(health.body));
  check('health store is reachable', health.body?.storeOk === true);
  console.log(`       store=${health.body?.store} rateLimitBackend=${health.body?.rateLimitBackend}`);

  const config = await call('GET', '/api/config');
  check('GET /api/config returns 200', config.status === 200);
  check(
    'config exposes limits',
    Array.isArray(config.body?.limits) && config.body.limits.length > 0,
  );
  check('config exposes ice servers', Array.isArray(config.body?.iceServers));
  check(
    'config hides TURN credentials without a session code',
    !JSON.stringify(config.body).includes('credential'),
  );

  const cron = await call('GET', '/api/cron/cleanup');
  check(
    'cron cleanup is protected on Vercel, open locally',
    process.env.VERCEL === '1' ? cron.status === 401 : cron.status === 200,
    `status ${cron.status}`,
  );
}

async function lifecycleTests() {
  section('session lifecycle');

  const room = await call('POST', '/api/rooms', { name: 'Test sender' });
  check('POST /api/rooms returns 200', room.status === 200, `status ${room.status}`);
  const code = room.body?.room?.code;
  const hostPeerId = room.body?.peerId;
  check(
    'room has a six character code from the safe alphabet',
    typeof code === 'string' && /^[A-HJKMNP-Z2-9]{6}$/.test(code),
    String(code),
  );
  check(
    'room expires about an hour out',
    Math.abs((room.body?.room?.expiresAt ?? 0) - (Date.now() + 3600_000)) < 60_000,
  );

  const malformed = await call('POST', '/api/rooms/zz/join', { name: 'x' });
  check('join with a malformed code returns 400', malformed.status === 400, `status ${malformed.status}`);

  const unknown = await call('POST', '/api/rooms/ZZZZZZ/join', { name: 'x' });
  check('join with an unknown code returns 404', unknown.status === 404, `status ${unknown.status}`);

  const join = await call('POST', `/api/rooms/${code}/join`, { name: 'Test receiver' });
  check('POST join returns 200', join.status === 200, `status ${join.status}`);
  const guestPeerId = join.body?.peerId;
  check('join returns a distinct guest peer id', Boolean(guestPeerId) && guestPeerId !== hostPeerId);
  check('join records the guest on the room', join.body?.room?.guestPeerId === guestPeerId);

  const intruder = await call('POST', `/api/rooms/${code}/join`, { name: 'Intruder' });
  check('a second guest is rejected with 409', intruder.status === 409, `status ${intruder.status}`);

  const reclaim = await call('POST', `/api/rooms/${code}/join`, {
    name: 'Test receiver',
    peerId: guestPeerId,
  });
  check(
    'the same guest can reclaim its slot after a reload',
    reclaim.status === 200 && reclaim.body.peerId === guestPeerId,
    `status ${reclaim.status}`,
  );

  section('signalling');

  const hostRead = await call('GET', `/api/rooms/${code}/signal?peerId=${hostPeerId}&cursor=`);
  check('host can read the signalling log', hostRead.status === 200);
  const hello = (hostRead.body?.messages ?? []).find((message) => message.kind === 'hello');
  check('host sees the guest hello', Boolean(hello), JSON.stringify(hostRead.body?.messages));
  check('hello carries the guest device name', hello?.data?.name === 'Test receiver');
  const cursor = hostRead.body?.cursor;

  const offer = await call('POST', `/api/rooms/${code}/signal`, {
    peerId: hostPeerId,
    kind: 'offer',
    data: { type: 'offer', sdp: 'v=0 fake sdp for tests' },
  });
  check('host can post an offer', offer.status === 200, `status ${offer.status}`);

  const guestRead = await call('GET', `/api/rooms/${code}/signal?peerId=${guestPeerId}&cursor=`);
  check('guest reads the offer', (guestRead.body?.messages ?? []).some((m) => m.kind === 'offer'));

  const hostAgain = await call(
    'GET',
    `/api/rooms/${code}/signal?peerId=${hostPeerId}&cursor=${encodeURIComponent(cursor)}`,
  );
  check(
    'the cursor excludes already-read messages',
    !(hostAgain.body?.messages ?? []).some((message) => message.kind === 'hello'),
  );
  check(
    'a peer never reads back its own messages',
    !(hostAgain.body?.messages ?? []).some((message) => message.from === hostPeerId),
  );

  const stranger = await call('POST', `/api/rooms/${code}/signal`, {
    peerId: 'peer_notinvited',
    kind: 'ice',
    data: {},
  });
  check('a non-member cannot post signalling', stranger.status === 403, `status ${stranger.status}`);

  const badKind = await call('POST', `/api/rooms/${code}/signal`, {
    peerId: hostPeerId,
    kind: 'rm-rf',
    data: {},
  });
  check('unknown signalling kinds are rejected', badKind.status === 400, `status ${badKind.status}`);

  const huge = await call('POST', `/api/rooms/${code}/signal`, {
    peerId: hostPeerId,
    kind: 'ice',
    data: { blob: 'x'.repeat(64 * 1024) },
  });
  check('oversized signalling payloads are rejected', huge.status === 413, `status ${huge.status}`);

  section('transfer budgets');

  const upload = await call('POST', `/api/rooms/${code}/transfers`, {
    peerId: hostPeerId,
    direction: 'upload',
    fileName: 'report.pdf',
    fileSize: 1024,
  });
  check('an upload can be declared', upload.status === 200, `status ${upload.status}`);
  check('the upload response reports a budget', typeof upload.body?.remaining === 'number');

  const download = await call('POST', `/api/rooms/${code}/transfers`, {
    peerId: guestPeerId,
    direction: 'download',
    fileName: 'report.pdf',
    fileSize: 1024,
  });
  check('a download can be declared', download.status === 200, `status ${download.status}`);

  const tooBig = await call('POST', `/api/rooms/${code}/transfers`, {
    peerId: hostPeerId,
    direction: 'upload',
    fileName: 'huge.bin',
    fileSize: 5 * 1024 ** 3,
  });
  check('files over the size cap are refused', tooBig.status === 413, `status ${tooBig.status}`);

  const outsider = await call('POST', `/api/rooms/${code}/transfers`, {
    peerId: 'peer_nobody',
    direction: 'upload',
  });
  check('a non-member cannot declare transfers', outsider.status === 403, `status ${outsider.status}`);

  section('closing a session');

  const closed = await call('POST', `/api/rooms/${code}/close`, { peerId: hostPeerId });
  check('the host can close the session', closed.status === 200, `status ${closed.status}`);

  const afterClose = await call('POST', `/api/rooms/${code}/join`, { name: 'Late joiner' });
  check(
    'joining a closed session fails',
    afterClose.status === 410 || afterClose.status === 404,
    `status ${afterClose.status}`,
  );

  const signalAfter = await call('GET', `/api/rooms/${code}/signal?peerId=${hostPeerId}&cursor=`);
  check(
    'signalling a closed session fails',
    signalAfter.status === 410 || signalAfter.status === 404,
    `status ${signalAfter.status}`,
  );
}

async function rateLimitTests(budgets) {
  section('rate limits');

  // Keep the first room open: closing it would not return the budget anyway,
  // and the upload/download checks below need a live session.
  let kept = null;
  const statuses = [];
  for (let index = 0; index < budgets.rooms; index += 1) {
    const created = await call('POST', '/api/rooms', { name: `Limit test ${index}` });
    statuses.push(created.status);
    if (created.status !== 200) continue;
    if (index === 0) {
      kept = { code: created.body.room.code, peerId: created.body.peerId };
      continue;
    }
    await call('POST', `/api/rooms/${created.body.room.code}/close`, {
      peerId: created.body.peerId,
    });
  }
  check(
    `the first ${budgets.rooms} session creations succeed`,
    statuses.every((status) => status === 200),
    statuses.join(','),
  );

  const extra = await call('POST', '/api/rooms', { name: 'One too many' });
  check('the next session creation is rate limited', extra.status === 429, `status ${extra.status}`);
  check('the 429 carries a retry-after header', Number(extra.headers.get('retry-after')) > 0);
  check('the 429 names the bucket', extra.body?.error?.details?.bucket === 'rooms');
  check(
    'the 429 explains the wait in the message',
    /try again in \d+s/i.test(extra.body?.error?.message ?? ''),
    extra.body?.error?.message,
  );

  return kept;
}

async function budgetTests(budgets, room) {
  section('upload and download budgets');

  if (!room) {
    check('a live room is available for budget tests', false);
    return;
  }
  const join = await call('POST', `/api/rooms/${room.code}/join`, { name: 'Budget receiver' });
  if (join.status !== 200) {
    check('the receiver can join the room', false, `status ${join.status}`);
    return;
  }
  const guestPeerId = join.body.peerId;

  const uploadStatuses = [];
  for (let index = 0; index <= budgets.upload; index += 1) {
    const result = await call('POST', `/api/rooms/${room.code}/transfers`, {
      peerId: room.peerId,
      direction: 'upload',
      fileSize: 10,
    });
    uploadStatuses.push(result.status);
  }
  check(
    `uploads are allowed ${budgets.upload} time(s), then rate limited`,
    uploadStatuses.slice(0, budgets.upload).every((status) => status === 200) &&
      uploadStatuses[budgets.upload] === 429,
    uploadStatuses.join(','),
  );

  const downloadStatuses = [];
  for (let index = 0; index <= budgets.download; index += 1) {
    const result = await call('POST', `/api/rooms/${room.code}/transfers`, {
      peerId: guestPeerId,
      direction: 'download',
      fileSize: 10,
    });
    downloadStatuses.push(result.status);
  }
  check(
    `downloads are allowed ${budgets.download} time(s), then rate limited`,
    downloadStatuses.slice(0, budgets.download).every((status) => status === 200) &&
      downloadStatuses[budgets.download] === 429,
    downloadStatuses.join(','),
  );

  await call('POST', `/api/rooms/${room.code}/close`, { peerId: room.peerId });
}

async function main() {
  console.log(`\nAPI tests against ${BASE}`);
  await basicTests();
  if (limits) {
    const room = await rateLimitTests(limits);
    await budgetTests(limits, room);
  } else {
    await lifecycleTests();
    console.log('\n  rate limit checks skipped (pass --limits <rooms> <upload> <download>)');
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
