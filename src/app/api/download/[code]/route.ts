import type { NextRequest } from "next/server";
import { getShare } from "@/lib/share";
import { isPlausibleCode } from "@/lib/share";
import { getMemory, memoryKey } from "@/lib/storage";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { sanitizeName } from "@/lib/format";
import { fail, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";

function contentDisposition(name: string): string {
  const ascii = sanitizeName(name).replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(sanitizeName(name));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function serve(request: NextRequest, code: string, method: "GET" | "HEAD") {
  if (!isPlausibleCode(code)) return fail(400, "That is not a valid transfer code.");

  const { id } = identityOf(request);
  const rate = await checkRate("download", id);
  if (!rate.allowed) return tooManyRequests("Too many downloads at once. Wait a moment.", rate);

  const share = await getShare(code);
  if (!share) return fail(404, "No transfer with that code. It may have expired.", { rate });
  if (Date.now() > share.expiresAt) return fail(410, "This transfer has expired.", { rate });

  const fileId = new URL(request.url).searchParams.get("file");
  const file = fileId ? share.files.find((candidate) => candidate.id === fileId) : undefined;
  if (!file) return fail(404, "That file is not part of this transfer.", { rate });

  // Dev store: stream the buffer with an explicit attachment disposition.
  const key = memoryKey(file.url);
  if (key) {
    const stored = getMemory(key);
    if (!stored) return fail(410, "This file is no longer available in local storage.", { rate });
    return new Response(method === "HEAD" ? null : new Uint8Array(stored.data), {
      status: 200,
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": contentDisposition(file.name),
        "Content-Length": String(stored.data.byteLength),
        "Cache-Control": "private, no-store",
        "X-RateLimit-Remaining": String(rate.remaining),
      },
    });
  }

  // Blob: hand the browser the download-forcing URL. The bytes never touch a
  // function, so file size is bounded by Blob, not by the 60s limit.
  return new Response(null, {
    status: 302,
    headers: {
      Location: file.downloadUrl || file.url,
      "Cache-Control": "private, no-store",
      "X-RateLimit-Remaining": String(rate.remaining),
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  return serve(request, code, "GET");
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  return serve(request, code, "HEAD");
}
