import type { NextRequest } from "next/server";
import { collectExpired } from "@/lib/share";
import { deleteStored } from "@/lib/storage";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deletes blobs whose transfer has expired.
 *
 * A transfer stops being *reachable* the moment its KV record TTLs out, but
 * the blob object itself keeps sitting in the store. Vercel Cron hits this
 * route to reclaim that storage. See vercel.json.
 *
 * Guarded by CRON_SECRET; Vercel sends it automatically on scheduled runs.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(request.url).searchParams.get("secret");

  if (secret) {
    if (provided !== secret) return fail(401, "Invalid cron secret.");
  } else if (!process.env.VERCEL_CRON) {
    // No secret configured: only allow it when Vercel itself scheduled the run.
    return fail(401, "Set CRON_SECRET to allow manual cleanup runs.");
  }

  const expired = await collectExpired();
  let deleted = 0;
  for (const url of expired) {
    await deleteStored(url);
    deleted += 1;
  }

  return json({ deleted, scanned: expired.length, at: new Date().toISOString() });
}
