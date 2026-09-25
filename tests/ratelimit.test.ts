import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRate, rateHeaders } from "../src/lib/ratelimit";
import { LIMITS } from "../src/lib/limits";

// No Upstash credentials are set in the test environment, so these assertions
// exercise the in-process sliding window that the app falls back to.

test("allows requests up to the limit, then blocks", async () => {
  const id = "ip:unit-test-batch";
  const limit = LIMITS.batchesPerMinute;

  for (let i = 0; i < limit; i += 1) {
    const result = await checkRate("batch", id);
    assert.equal(result.allowed, true, `request ${i + 1} of ${limit} should pass`);
    assert.equal(result.degraded, true, "must be the local limiter without Redis");
  }

  const blocked = await checkRate("batch", id);
  assert.equal(blocked.allowed, false, `request ${limit + 1} must be blocked`);
  assert.equal(blocked.limit, limit);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.resetMs > 0, "must tell the client how long to wait");
  assert.ok(blocked.resetMs <= 60_000, "window is one minute");
});

test("buckets are independent of each other", async () => {
  const blockedId = "ip:unit-test-independent";
  for (let i = 0; i < LIMITS.batchesPerMinute; i += 1) await checkRate("batch", blockedId);
  assert.equal((await checkRate("batch", blockedId)).allowed, false);

  // A different bucket for the same identity is untouched.
  assert.equal((await checkRate("download", blockedId)).allowed, true);
  // The same bucket for a different identity is untouched.
  assert.equal((await checkRate("batch", "ip:someone-else")).allowed, true);
});

test("remaining counts down as the window fills", async () => {
  const id = "ip:unit-test-remaining";
  const limit = LIMITS.downloadsPerMinute;
  for (let i = 0; i < 3; i += 1) await checkRate("download", id);
  const result = await checkRate("download", id);
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, limit - 4);
});

test("rateHeaders exposes limit, remaining, reset and Retry-After only when blocked", () => {
  const allowed = rateHeaders({
    allowed: true,
    limit: 10,
    remaining: 7,
    resetMs: 30_000,
    degraded: false,
  });
  assert.equal(allowed["X-RateLimit-Limit"], "10");
  assert.equal(allowed["X-RateLimit-Remaining"], "7");
  assert.equal(allowed["X-RateLimit-Reset"], "30");
  assert.equal(allowed["Retry-After"], undefined);

  const blocked = rateHeaders({
    allowed: false,
    limit: 10,
    remaining: 0,
    resetMs: 1200,
    degraded: false,
  });
  assert.equal(blocked["Retry-After"], "2", "rounds 1.2s up to a whole second");
});
