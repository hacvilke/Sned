import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, type PreflightLimits } from "../src/lib/preflight";

const MB = 1024 * 1024;

const limits: PreflightLimits = {
  maxFileBytes: 250 * MB,
  maxBatchBytes: 500 * MB,
  maxFilesPerBatch: 3,
  effectiveMaxFileBytes: 250 * MB,
  localOnly: false,
};

const empty = { count: 0, bytes: 0 };

test("accepts files that fit every limit", () => {
  const { accepted, rejected } = preflight(
    [
      { name: "a.pdf", size: 1 * MB },
      { name: "b.zip", size: 2 * MB },
    ],
    limits,
    empty,
  );
  assert.equal(accepted.length, 2);
  assert.deepEqual(rejected, []);
});

test("rejects empty files", () => {
  const { accepted, rejected } = preflight([{ name: "empty", size: 0 }], limits, empty);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /empty/i);
});

test("rejects a file over the per-file cap", () => {
  const { accepted, rejected } = preflight(
    [{ name: "huge.bin", size: 251 * MB }],
    limits,
    empty,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /per-file limit/i);
});

test("rejects when the batch file count is already full", () => {
  const { accepted, rejected } = preflight([{ name: "d.bin", size: MB }], limits, {
    count: 3,
    bytes: 3 * MB,
  });
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /batch is full/i);
});

test("rejects a file that would overflow the batch byte budget", () => {
  // 200 MB is inside the 250 MB per-file cap but pushes the batch past 500 MB,
  // so the batch check is the one that must fire.
  const { accepted, rejected } = preflight([{ name: "big.bin", size: 200 * MB }], limits, {
    count: 2,
    bytes: 400 * MB,
  });
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /batch limit/i);
});

test("stops at the file-count cap mid-list but keeps accepting until then", () => {
  const entries = [
    { name: "1.bin", size: MB },
    { name: "2.bin", size: MB },
    { name: "3.bin", size: MB },
    { name: "4.bin", size: MB },
    { name: "5.bin", size: MB },
  ];
  const { accepted, rejected } = preflight(entries, limits, { count: 1, bytes: MB });
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 3);
  assert.deepEqual(
    accepted.map((entry) => entry.name),
    ["1.bin", "2.bin"],
  );
});

test("cumulative bytes across one intake are counted against the batch budget", () => {
  // Raise the file-count cap so the byte budget is what binds.
  const byteBound = { ...limits, maxBatchBytes: 10 * MB, maxFilesPerBatch: 20 };
  const entries = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, size: 2 * MB }));
  const { accepted, rejected } = preflight(entries, byteBound, empty);
  assert.equal(accepted.length, 5);
  assert.equal(rejected.length, 1);
  assert.equal(accepted.reduce((sum, entry) => sum + entry.size, 0), 10 * MB);
});

test("the file-count cap binds before the byte budget when it is tighter", () => {
  const countBound = { ...limits, maxBatchBytes: 10 * MB, maxFilesPerBatch: 3 };
  const entries = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, size: 2 * MB }));
  const { accepted, rejected } = preflight(entries, countBound, empty);
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 3);
  assert.match(rejected[0].reason, /batch is full/i);
});

test("local-only mode applies the tightened dev cap and says so", () => {
  const local: PreflightLimits = {
    ...limits,
    effectiveMaxFileBytes: 25 * MB,
    localOnly: true,
  };
  const { rejected } = preflight([{ name: "movie.mp4", size: 100 * MB }], local, empty);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /local-storage cap/i);
});
