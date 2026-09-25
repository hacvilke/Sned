import type { NextRequest } from "next/server";
import { getShare, sealShare, ShareError } from "@/lib/share";
import { identityOf } from "@/lib/identity";
import { checkRate } from "@/lib/ratelimit";
import { fail, ok, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Mark a batch finished so the download page stops polling for more files. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const { id } = identityOf(request);

  const rate = await checkRate("batch", id);
  if (!rate.allowed) return tooManyRequests("Slow down and try again in a moment.", rate);

  const existing = await getShare(code);
  if (!existing) return fail(404, "No transfer with that code.", { rate });
  // Check ownership before mutating, so a third party cannot seal a batch
  // that is still mid-transfer.
  if (existing.ownerId !== id) return fail(403, "You did not open this transfer.", { rate });

  try {
    const share = await sealShare(code);
    return ok({ code: share.code, status: share.status, fileCount: share.files.length }, rate);
  } catch (error) {
    if (error instanceof ShareError) return fail(404, error.message, { rate });
    throw error;
  }
}
