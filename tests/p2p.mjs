/**
 * End-to-end peer-to-peer test in two real browser contexts.
 *
 *   node tests/p2p.mjs [baseUrl]
 *
 * Covers: session creation, joining through a share link, WebRTC negotiation
 * over the signalling API, the accept/decline handshake, queued transfers in
 * both directions, byte-for-byte integrity of what the receiving browser
 * downloads, the rate limit budget surfacing in the UI, and session teardown.
 *
 * Browser resolution order:
 *   1. FT_CHROMIUM_PATH — explicit executable
 *   2. @sparticuz/chromium, when installed
 *   3. the Chromium bundled with Playwright (`npx playwright install chromium`)
 *
 * FT_LD_LIBRARY_PATH is prepended to LD_LIBRARY_PATH when set, for sandboxed
 * runners that ship their own NSS/NSPR libraries.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] ?? process.env.FT_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const CONNECT_TIMEOUT = Number(process.env.FT_CONNECT_TIMEOUT ?? 90_000);
const TRANSFER_TIMEOUT = Number(process.env.FT_TRANSFER_TIMEOUT ?? 120_000);

if (process.env.FT_LD_LIBRARY_PATH) {
  process.env.LD_LIBRARY_PATH = [process.env.FT_LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(':');
}

const { chromium } = await import('playwright');

let passed = 0;
let failed = 0;
const failures = [];
const pageErrors = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function heading(title) {
  console.log(`\n  ${title}`);
}

async function resolveExecutablePath() {
  if (process.env.FT_CHROMIUM_PATH) return process.env.FT_CHROMIUM_PATH;
  try {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    return await sparticuz.executablePath();
  } catch {
    return undefined; // fall back to Playwright's bundled browser
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const workDir = mkdtempSync(join(tmpdir(), 'ft-e2e-'));

function makeFile(name, bytes) {
  const path = join(workDir, name);
  const chunks = [];
  let remaining = bytes;
  while (remaining > 0) {
    const slice = randomBytes(Math.min(remaining, 64 * 1024));
    chunks.push(slice);
    remaining -= slice.length;
  }
  const buffer = Buffer.concat(chunks, bytes);
  writeFileSync(path, buffer);
  return { path, name, bytes, hash: sha256(buffer) };
}

const browser = await chromium.launch({
  executablePath: await resolveExecutablePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

async function newDevice(label) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
  return { label, page, downloads };
}

async function waitForCount(list, count, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (list.length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return list.length >= count;
}

const phaseSelector = (phase) => `[data-testid="session-card"][data-phase="${phase}"]`;
const rowSelector = (direction, file, status) =>
  `tr[data-testid="${direction}-row"][data-file="${file}"][data-status="${status}"]`;

async function waitForPhase(device, phase, timeout = CONNECT_TIMEOUT) {
  await device.page.waitForSelector(phaseSelector(phase), { timeout });
}

async function waitForRow(device, direction, file, status, timeout = TRANSFER_TIMEOUT) {
  await device.page.waitForSelector(rowSelector(direction, file, status), { timeout });
}

async function errorText(device) {
  return device.page.locator('.notice-error').allInnerTexts().then((items) => items.join(' | '));
}

/** Start a session on `host` and connect `guest` to it through the share link. */
async function openSession(host, guest) {
  await host.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await host.page.fill('#device-name', `${host.label} device`);
  await host.page.click('[data-testid="start-session"]');
  await host.page.waitForSelector('[data-testid="session-code"]', { timeout: 20_000 });
  const code = (await host.page.locator('[data-testid="session-code"]').innerText())
    .replace(/\s+/g, '')
    .trim();

  await guest.page.goto(`${BASE}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await waitForPhase(guest, 'connected');
  await waitForPhase(host, 'connected');
  return code;
}

async function setAutoDownload(device, enabled) {
  const box = device.page.locator('#auto-save');
  if ((await box.isChecked()) !== enabled) await box.setChecked(enabled);
  return box.isChecked();
}

try {
  console.log(`\nPeer-to-peer tests against ${BASE}`);

  heading('fixtures');
  const bigFile = makeFile('quarterly-report.bin', 8 * 1024 * 1024);
  const smallFile = makeFile('notes.txt', 120 * 1024);
  const reverseFile = makeFile('photo-upload.bin', 3 * 1024 * 1024);
  console.log(
    `       ${bigFile.name} 8.0 MB · ${smallFile.name} 120 KB · ${reverseFile.name} 3.0 MB`,
  );

  const host = await newDevice('host');
  const guest = await newDevice('guest');

  // ------------------------------------------------------- decline handshake
  heading('accept / decline handshake');
  const firstCode = await openSession(host, guest);
  check('a six character session code is issued', /^[A-HJKMNP-Z2-9]{6}$/.test(firstCode), firstCode);
  check(
    'both devices report a direct connection',
    (await host.page.locator('.status-cell >> nth=2').innerText()).includes('Direct'),
  );
  // Ask-where-to-save is the default wherever the browser supports it; set it
  // explicitly so this phase behaves the same in every browser.
  await setAutoDownload(guest, false);
  console.log(
    `       showSaveFilePicker: ${await guest.page.evaluate(() => typeof window.showSaveFilePicker)}`,
  );

  await host.page.setInputFiles('[data-testid="file-input"]', smallFile.path);
  await waitForRow(guest, 'in', smallFile.name, 'awaiting-save', 30_000);
  check('the receiver is asked before any bytes flow', true);
  await waitForRow(host, 'out', smallFile.name, 'awaiting-accept', 30_000);
  check('the sender waits for that decision', true);
  const sentBeforeDecline = await host.page
    .locator(rowSelector('out', smallFile.name, 'awaiting-accept'))
    .locator('.file-sub.num')
    .innerText();
  check(
    'no bytes moved while the receiver was deciding',
    sentBeforeDecline.trim().startsWith('0 B'),
    sentBeforeDecline,
  );

  await guest.page
    .locator(rowSelector('in', smallFile.name, 'awaiting-save'))
    .locator('button', { hasText: 'Decline' })
    .click();
  await waitForRow(guest, 'in', smallFile.name, 'declined', 30_000);
  check('the receiver can decline a file', true);
  await waitForRow(host, 'out', smallFile.name, 'skipped', 30_000);
  const skipNote = await host.page
    .locator(rowSelector('out', smallFile.name, 'skipped'))
    .locator('[data-testid="out-detail"]')
    .innerText();
  check('the sender is told it was declined', /declin/i.test(skipNote), skipNote);
  check('no download was produced by a declined file', host.downloads.length === 0 && guest.downloads.length === 0);

  await host.page.locator('button', { hasText: 'End session' }).click();
  await waitForPhase(host, 'closed', 20_000);
  await waitForPhase(guest, 'closed', 30_000);
  check('ending the session reaches both devices', true);

  // A closed session must refuse new devices.
  const late = await newDevice('late');
  await late.page.goto(`${BASE}/?r=${firstCode}`, { waitUntil: 'domcontentloaded' });
  await late.page.waitForSelector('.notice-error', { timeout: 20_000 }).catch(() => undefined);
  const lateErrors = await errorText(late);
  check(
    'a closed session refuses new devices',
    /ended|expired|not active|closed|already joined/i.test(lateErrors),
    lateErrors.slice(0, 160),
  );

  // ------------------------------------------------------------- real transfer
  heading('queued transfer, sender to receiver');
  const second = await newDevice('host2');
  const third = await newDevice('guest2');
  await openSession(second, third);
  check('a second session connects', true);
  check('receiver: automatic download enabled', await setAutoDownload(third, true));
  check('sender: automatic download enabled', await setAutoDownload(second, true));

  await second.page.setInputFiles('[data-testid="file-input"]', [bigFile.path, smallFile.path]);

  await waitForRow(third, 'in', bigFile.name, 'complete');
  check('the 8 MB file completed on the receiver', true);
  await waitForRow(second, 'out', bigFile.name, 'confirmed');
  check('the sender received a delivery confirmation', true);

  await waitForRow(third, 'in', smallFile.name, 'complete');
  await waitForRow(second, 'out', smallFile.name, 'confirmed');
  check('the queue sent both files in order', true);

  check(
    'the receiver browser produced two downloads',
    await waitForCount(third.downloads, 2, TRANSFER_TIMEOUT),
    `${third.downloads.length} of 2`,
  );

  const saved = [];
  for (const download of third.downloads) {
    const target = join(workDir, `received-${saved.length}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    saved.push({ target, name: download.suggestedFilename() });
  }
  const byName = new Map(saved.map((entry) => [entry.name, entry.target]));
  for (const fixture of [bigFile, smallFile]) {
    const target = byName.get(fixture.name);
    if (!target) {
      check(`${fixture.name} downloaded`, false, 'missing download');
      continue;
    }
    const actual = sha256(readFileSync(target));
    check(
      `${fixture.name} arrived byte-for-byte (${(fixture.bytes / 1024).toFixed(0)} KB)`,
      actual === fixture.hash,
      `expected ${fixture.hash.slice(0, 12)}… got ${actual.slice(0, 12)}…`,
    );
  }

  heading('reverse transfer, receiver to sender');
  await third.page.setInputFiles('[data-testid="file-input"]', reverseFile.path);
  await waitForRow(second, 'in', reverseFile.name, 'complete');
  check('the joining device can send as well', true);
  await waitForRow(third, 'out', reverseFile.name, 'confirmed');
  check('the reverse direction confirms delivery', true);
  check(
    'the sender browser downloaded the reverse file',
    await waitForCount(second.downloads, 1, TRANSFER_TIMEOUT),
  );
  const reversePath = join(workDir, 'received-reverse.bin');
  await second.downloads[0].saveAs(reversePath);
  check(
    'the reverse transfer arrived byte-for-byte',
    sha256(readFileSync(reversePath)) === reverseFile.hash,
  );

  heading('rate limit budget in the UI');
  const budgetText = (await second.page.locator('.card-foot').first().innerText()).replace(/\n/g, ' ');
  check(
    'the remaining send budget is shown',
    /Send budget:\s*\d+ of \d+ remaining/.test(budgetText),
    budgetText.slice(0, 120),
  );

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  failed += 1;
  failures.push(`test run aborted: ${error.message}`);
  console.log(`\n  ABORT ${error.message}`);
  if (error.stack) console.log(error.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(
  `\n${passed} passed, ${failed} failed${failures.length ? `\nfailed: ${failures.join('; ')}` : ''}\n`,
);
process.exit(failed > 0 ? 1 : 0);
