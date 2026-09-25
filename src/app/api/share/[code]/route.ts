import type { NextRequest } from "next/server";
import { getShare } from "@/lib/share";
import { isPlausibleCode } from "@/lib/share";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { fail, ok, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  if (!isPlausibleCode(code)) return fail(400, "That is not a valid transfer code.");

  const { id } = identityOf(request);
  const rate = await checkRate("share-read", id);
  if (!rate.allowed) return tooManyRequests("Too many requests. Slow down a little.", rate);

  const share = await getShare(code);
  if (!share) return fail(404, "No transfer with that code. It may have expired.", { rate });

  const now = Date.now();
  if (now > share.expiresAt) return fail(410, "This transfer has expired.", { rate });

  return ok(
    {
      code: share.code,
      status: share.status,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      totalBytes: share.totalBytes,
      files: share.files.map((file) => ({
        id: file.id,
        name: file.name,
        path: file.path,
        size: file.size,
        type: file.type,
      })),
    },
    rate,
  );
}
