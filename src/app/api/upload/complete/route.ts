import { head } from "@vercel/blob";
import type { NextRequest } from "next/server";
import { attachFile, peekPending, takePending, ShareError } from "@/lib/share";
import { storageMode } from "@/lib/storage";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { fail, ok, readJson, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type CompleteBody = { uploadId?: string };

/**
 * Confirm a direct browser -> Vercel Blob upload and attach it to the batch.
 *
 * The client only supplies `uploadId`. The blob's URL, download URL and true
 * size are read back from Blob storage with `head()` rather than taken from
 * the request, so a caller cannot attach an arbitrary URL or lie about size.
 */
export async function POST(request: NextRequest) {
  const { id } = identityOf(request);
  const body = await readJson<CompleteBody>(request);
  const uploadId = body?.uploadId;
  if (!uploadId) return fail(400, "An uploadId is required.");

  const rate = await checkRate("upload-minute", id);
  if (!rate.allowed) return tooManyRequests("Uploading too fast. Wait a moment.", rate);

  const pending = await peekPending(uploadId);
  if (!pending) return fail(404, "That upload reservation has expired. Retry the file.", { rate });
  if (pending.ownerId !== id) return fail(403, "You did not start this upload.", { rate });

  if (storageMode() !== "blob") {
    return fail(409, "This deployment has no Blob store; use the direct upload endpoint.", { rate });
  }

  let metadata;
  try {
    metadata = await head(`${pending.shareCode}/${pending.id}/${pending.path}`, {
      token: process.env.BLOB_READ_WRITE_TOKEN!,
    });
  } catch {
    // Object is not there yet: the browser upload failed or was cancelled.
    // The reservation stays live so the client can retry the same file.
    return fail(409, "The file did not finish uploading. Retry it.", { rate });
  }

  if (metadata.size !== pending.size) {
    return fail(
      409,
      `Upload size mismatch (expected ${pending.size} bytes, stored ${metadata.size}). Retry the file.`,
      { rate },
    );
  }

  try {
    const share = await attachFile(pending.shareCode, {
      id: pending.id,
      name: pending.name,
      path: pending.path,
      size: metadata.size,
      type: metadata.contentType || pending.type,
      url: metadata.url,
      downloadUrl: metadata.downloadUrl,
      createdAt: Date.now(),
    });
    // Only consume the reservation once the file is durably attached.
    await takePending(pending.id);
    return ok({ file: { id: pending.id, name: pending.name, size: metadata.size }, share: {
      code: share.code,
      status: share.status,
      fileCount: share.files.length,
      totalBytes: share.totalBytes,
    } }, rate);
  } catch (error) {
    if (error instanceof ShareError) return fail(409, error.message, { rate });
    throw error;
  }
}
