import type { NextRequest } from "next/server";
import { createShare } from "@/lib/share";
import { LIMITS } from "@/lib/limits";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { fail, ok, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Open a transfer batch. The code is issued before any bytes move so the
 * recipient can have the link in hand while the sender's queue is still
 * running - files appear on the download page as each one lands.
 */
export async function POST(request: NextRequest) {
  const { id } = identityOf(request);

  const rate = await checkRate("batch", id);
  if (!rate.allowed) {
    return tooManyRequests(
      "You are opening transfers too quickly. Wait a moment and try again.",
      rate,
    );
  }

  const share = await createShare(id);
  return ok(
    {
      code: share.code,
      expiresAt: share.expiresAt,
      ttlHours: LIMITS.ttlHours,
      limits: {
        maxFileBytes: LIMITS.maxFileBytes,
        maxBatchBytes: LIMITS.maxBatchBytes,
        maxFilesPerBatch: LIMITS.maxFilesPerBatch,
      },
    },
    rate,
  );
}

export function GET() {
  return fail(405, "Use POST to open a transfer.");
}
