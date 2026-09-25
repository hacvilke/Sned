import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  attachFile,
  collectExpired,
  createShare,
  destroyShare,
  getShare,
  isPlausibleCode,
  newCode,
  peekPending,
  savePending,
  sealShare,
  ShareError,
  takePending,
  type StoredFile,
} from "../src/lib/share";
import { __resetKvForTests, kv } from "../src/lib/kv";

const OWNER = "ip:test-owner";

function makeFile(id: string, size: number): StoredFile {
  return {
    id,
    name: `${id}.bin`,
    path: `${id}.bin`,
    size,
    type: "application/octet-stream",
    url: `memory:${id}`,
    downloadUrl: `memory:${id}`,
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  __resetKvForTests();
});

test("codes use only unambiguous characters and are case-safe to validate", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = newCode();
    assert.equal(code.length, 6);
    assert.doesNotMatch(code, /[01IO]/, `code ${code} contains an ambiguous character`);
    assert.ok(isPlausibleCode(code));
  }
});

test("isPlausibleCode rejects malformed input", () => {
  assert.equal(isPlausibleCode(""), false);
  assert.equal(isPlausibleCode("AB"), false, "shorter than any issued code");
  assert.equal(isPlausibleCode("../../etc"), false);
  assert.equal(isPlausibleCode("ABC234"), true);
  assert.equal(isPlausibleCode("abc234"), true, "lowercase is accepted and upper-cased on lookup");
  // 0, 1, I and O are never issued, so a code containing one is not ours.
  assert.equal(isPlausibleCode("ABC123"), false, "contains 1");
  assert.equal(isPlausibleCode("ABC0IO"), false, "contains 0, I and O");
});

test("a created share round-trips through the store", async () => {
  const share = await createShare(OWNER);
  const loaded = await getShare(share.code);
  assert.ok(loaded);
  assert.equal(loaded.code, share.code);
  assert.equal(loaded.status, "open");
  assert.equal(loaded.ownerId, OWNER);
  assert.deepEqual(loaded.files, []);
  assert.equal(loaded.totalBytes, 0);
  assert.ok(loaded.expiresAt > Date.now());
});

test("getShare returns null for an unknown code", async () => {
  assert.equal(await getShare("ZZZZZZ"), null);
});

test("attaching files accumulates them and the batch total", async () => {
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("f1", 100));
  const after = await attachFile(share.code, makeFile("f2", 250));
  assert.equal(after.files.length, 2);
  assert.equal(after.totalBytes, 350);
  assert.deepEqual(
    after.files.map((file) => file.id),
    ["f1", "f2"],
  );
});

test("re-attaching the same upload id is idempotent", async () => {
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("f1", 100));
  const after = await attachFile(share.code, makeFile("f1", 100));
  assert.equal(after.files.length, 1);
  assert.equal(after.totalBytes, 100);
});

test("attaching past the file-count cap is refused", async () => {
  const share = await createShare(OWNER);
  // Default MAX_FILES_PER_BATCH is 50.
  for (let i = 0; i < 50; i += 1) await attachFile(share.code, makeFile(`f${i}`, 10));
  await assert.rejects(() => attachFile(share.code, makeFile("overflow", 10)), ShareError);
});

test("attaching past the batch byte cap is refused", async () => {
  const share = await createShare(OWNER);
  // Default MAX_BATCH_BYTES is 1 GiB.
  await assert.rejects(
    () => attachFile(share.code, makeFile("huge", 1024 * 1024 * 1024 + 1)),
    /size limit/,
  );
});

test("sealing flips the status once and is repeatable", async () => {
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("f1", 10));
  const sealed = await sealShare(share.code);
  assert.equal(sealed.status, "sealed");
  assert.ok(sealed.sealedAt);
  const again = await sealShare(share.code);
  assert.equal(again.status, "sealed");
  assert.equal(again.files.length, 1);
});

test("pending reservations are consumed exactly once", async () => {
  const pending = {
    id: "upload-1",
    shareCode: "AAAAAA",
    name: "a.bin",
    path: "a.bin",
    size: 42,
    type: "application/octet-stream",
    ownerId: OWNER,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  await savePending(pending);
  assert.equal((await peekPending("upload-1"))?.size, 42);
  assert.equal((await takePending("upload-1"))?.id, "upload-1");
  assert.equal(await takePending("upload-1"), null, "second take must miss");
  assert.equal(await peekPending("upload-1"), null);
});

test("expired reservations are not returned", async () => {
  await savePending({
    id: "upload-old",
    shareCode: "AAAAAA",
    name: "a.bin",
    path: "a.bin",
    size: 1,
    type: "application/octet-stream",
    ownerId: OWNER,
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 60_000,
  });
  assert.equal(await peekPending("upload-old"), null);
});

test("cleanup finds attached blobs whose transfer has expired", async () => {
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("f1", 10));

  // Nothing is due yet.
  assert.deepEqual(await collectExpired(Date.now()), []);

  // Simulate the TTL elapsing.
  const due = await collectExpired(share.expiresAt + 1000);
  assert.deepEqual(due, ["memory:f1"]);

  // And it is removed from the index so the next sweep does not repeat it.
  assert.deepEqual(await collectExpired(share.expiresAt + 1000), []);
});

test("cleanup still finds blobs after the share record has been evicted", async () => {
  // This is the normal production case: the share record and the expiry index
  // carry the same TTL, so the record is gone well before the daily cron runs.
  // Indexing the blob URL rather than a reference to the record is what makes
  // the blob deletable instead of permanently orphaned.
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("orphan", 10));

  await kv().del(`sned:share:${share.code}`);
  assert.equal(await getShare(share.code), null, "precondition: record is gone");

  const due = await collectExpired(share.expiresAt + 1000);
  assert.deepEqual(due, ["memory:orphan"], "the blob must still be recoverable");
});

test("destroyShare removes every file and the share record", async () => {
  const share = await createShare(OWNER);
  await attachFile(share.code, makeFile("f1", 10));
  await attachFile(share.code, makeFile("f2", 20));

  const removed = await destroyShare(share.code);
  assert.equal(removed, 2);
  assert.equal(await getShare(share.code), null);
  assert.equal(await destroyShare(share.code), 0);
});
