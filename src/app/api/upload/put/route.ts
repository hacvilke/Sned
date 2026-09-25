import type { NextRequest } from "next/server";
import { attachFile, peekPending, takePending, ShareError } from "@/lib/share";
import { putMemory, storageMode, toMemoryUrl } from "@/lib/storage";
import { LIMITS } from "@/lib/limits";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { fail, ok, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Local-development upload path.
 *
 * Used only when BLOB_READ_WRITE_TOKEN is absent. Bytes are buffered in
 * process memory, so this is capped well below the Blob limit and must never
 * be the production path: Vercel rejects function request bodies over 4.5 MB
 * and recycles the memory between invocations.
 */
export async function POST(request: NextRequest) {
  if (storageMode() === "blob") {
    return fail(409, "Blob storage is configured; uploads must go directly to Blob.");
  }

  const { id } = identityOf(request);
  const uploadId = request.headers.get("x-upload-id") ?? new URL(request.url).searchParams.get("uploadId");
  if (!uploadId) return fail(400, "An x-upload-id header is required.");

  const rate = await checkRate("upload-minute", id);
  if (!rate.allowed) return tooManyRequests("Uploading too fast. Wait a moment.", rate);

  const pending = await peekPending(uploadId);
  if (!pending) return fail(404, "That upload reservation has expired. Retry the file.", { rate });
  if (pending.ownerId !== id) return fail(403, "You did not start this upload.", { rate });
  if (pending.size > LIMITS.maxDevFileBytes) {
    return fail(413, "Too large for local in-memory storage.", { rate });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMITS.maxDevFileBytes) {
    return fail(413, "Too large for local in-memory storage.", { rate });
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.byteLength !== pending.size) {
    return fail(409, `Received ${buffer.byteLength} bytes, expected ${pending.size}.`, { rate });
  }

  const key = `${pending.shareCode}/${pending.id}/${pending.path}`;
  await putMemory(key, buffer);

  try {
    const url = toMemoryUrl(key);
    const share = await attachFile(pending.shareCode, {
      id: pending.id,
      name: pending.name,
      path: pending.path,
      size: buffer.byteLength,
      type: pending.type,
      url,
      downloadUrl: url,
      createdAt: Date.now(),
    });
    await takePending(pending.id);
    return ok(
      {
        file: { id: pending.id, name: pending.name, size: buffer.byteLength },
        share: {
          code: share.code,
          status: share.status,
          fileCount: share.files.length,
          totalBytes: share.totalBytes,
        },
      },
      rate,
    );
  } catch (error) {
    if (error instanceof ShareError) return fail(409, error.message, { rate });
    throw error;
  }
}
