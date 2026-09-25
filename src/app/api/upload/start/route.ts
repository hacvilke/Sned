import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getShare, savePending } from "@/lib/share";
import { prepareUpload, storageMode } from "@/lib/storage";
import { LIMITS } from "@/lib/limits";
import { checkRate } from "@/lib/ratelimit";
import { identityOf } from "@/lib/identity";
import { sanitizeName } from "@/lib/format";
import { fail, ok, readJson, tooManyRequests } from "@/lib/http";

export const dynamic = "force-dynamic";

type StartBody = {
  shareCode?: string;
  name?: string;
  path?: string;
  size?: number;
  type?: string;
};

/**
 * Reserve one slot in a batch and hand back an upload credential.
 *
 * Every limit that could be abused is enforced here, before a single byte is
 * transferred: per-minute and per-day upload counts, per-file size, batch size
 * and batch file count.
 */
export async function POST(request: NextRequest) {
  const { id } = identityOf(request);
  const body = await readJson<StartBody>(request);
  if (!body) return fail(400, "Expected a JSON body.");

  const { shareCode, size } = body;
  const name = sanitizeName(body.name ?? "file");
  const path = sanitizeName(body.path ?? name);
  const type = typeof body.type === "string" ? body.type.slice(0, 200) : "application/octet-stream";

  if (!shareCode) return fail(400, "A transfer code is required.");
  if (!Number.isFinite(size) || (size as number) <= 0) {
    return fail(400, "A positive file size is required.");
  }

  // 1. Per-minute throttle on upload starts.
  const perMinute = await checkRate("upload-minute", id);
  if (!perMinute.allowed) {
    return tooManyRequests("Uploading too fast. Wait a moment and try again.", perMinute);
  }

  // 2. Per-day upload count.
  const perDay = await checkRate("upload-day", id);
  if (!perDay.allowed) {
    return tooManyRequests("Daily upload limit reached. Try again tomorrow.", perDay);
  }

  // 3. Per-file size cap, tightened further when running on the dev store.
  const mode = storageMode();
  const hardCap = mode === "blob" ? LIMITS.maxFileBytes : LIMITS.maxDevFileBytes;
  if ((size as number) > hardCap) {
    const mb = Math.round(hardCap / (1024 * 1024));
    return fail(413, `Files are limited to ${mb} MB on this deployment.`, { rate: perMinute });
  }

  // 4. Batch must exist and belong to this caller.
  const share = await getShare(shareCode);
  if (!share) return fail(404, "That transfer code no longer exists.", { rate: perMinute });
  if (share.ownerId !== id) return fail(403, "You did not open this transfer.", { rate: perMinute });
  if (Date.now() > share.expiresAt) return fail(410, "This transfer has expired.", { rate: perMinute });
  if (share.files.length >= LIMITS.maxFilesPerBatch) {
    return fail(409, `A transfer can hold at most ${LIMITS.maxFilesPerBatch} files.`, {
      rate: perMinute,
    });
  }
  if (share.totalBytes + (size as number) > LIMITS.maxBatchBytes) {
    return fail(413, "That would exceed the size limit for one transfer.", { rate: perMinute });
  }

  const uploadId = randomUUID();
  const pathname = `${share.code}/${uploadId}/${path}`;
  const expiresAt = Math.min(
    share.expiresAt,
    Date.now() + LIMITS.uploadTokenSeconds * 1000,
  );

  await savePending({
    id: uploadId,
    shareCode: share.code,
    name,
    path,
    size: size as number,
    type,
    ownerId: id,
    createdAt: Date.now(),
    expiresAt,
  });

  const prepared = await prepareUpload(pathname, size as number, LIMITS.uploadTokenSeconds);

  return ok(
    {
      uploadId,
      pathname,
      mode: prepared.mode,
      clientToken: prepared.mode === "blob" ? prepared.clientToken : undefined,
      expiresAt,
      rate: {
        limit: perDay.limit,
        remaining: Math.min(perDay.remaining, perMinute.remaining),
      },
    },
    perMinute,
  );
}
