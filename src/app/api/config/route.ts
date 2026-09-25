import { NextResponse } from "next/server";
import { publicLimits } from "@/lib/limits";
import { hasBlob, hasRedis } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** Public configuration the client needs before it queues anything. */
export function GET() {
  return NextResponse.json(
    {
      limits: publicLimits,
      storage: hasBlob ? "blob" : "memory",
      distributedRateLimiting: hasRedis,
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
