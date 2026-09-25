import { NextResponse } from "next/server";
import { hasBlob, hasRedis, LIMITS } from "@/lib/limits";
import { kv } from "@/lib/kv";
import { memoryStoreSize, storageMode } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Deployment self-check. Confirms which backends are actually wired up. */
export async function GET() {
  const driver = kv();
  let kvReachable: boolean | "n/a" = "n/a";
  try {
    await driver.set("sned:health", String(Date.now()), 30);
    kvReachable = (await driver.get("sned:health")) !== null;
  } catch {
    kvReachable = false;
  }

  const warnings: string[] = [];
  if (!hasBlob) {
    warnings.push(
      "BLOB_READ_WRITE_TOKEN is not set - uploads are buffered in memory and capped at " +
        Math.round(LIMITS.maxDevFileBytes / (1024 * 1024)) +
        " MB. Set it before deploying.",
    );
  }
  if (!hasRedis) {
    warnings.push(
      "No Upstash Redis credentials - rate limits are enforced per serverless instance only, which is far weaker than intended.",
    );
  }

  return NextResponse.json(
    {
      status: warnings.length === 0 ? "ok" : "degraded",
      storage: storageMode(),
      kv: driver.kind,
      kvReachable,
      limits: {
        maxFileBytes: LIMITS.maxFileBytes,
        maxBatchBytes: LIMITS.maxBatchBytes,
        maxFilesPerBatch: LIMITS.maxFilesPerBatch,
        ttlHours: LIMITS.ttlHours,
        bytesPerDay: LIMITS.bytesPerDay,
      },
      devStoreBytes: memoryStoreSize(),
      warnings,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
