import { NextResponse } from "next/server";
import { rateHeaders, type RateResult } from "@/lib/ratelimit";

export function json<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

export function fail(
  status: number,
  message: string,
  extra?: { rate?: RateResult; headers?: Record<string, string> },
): NextResponse {
  const headers: Record<string, string> = { ...extra?.headers };
  if (extra?.rate) Object.assign(headers, rateHeaders(extra.rate));
  return json(
    {
      error: message,
      ...(extra?.rate ? { retryAfterSeconds: Math.ceil(extra.rate.resetMs / 1000) } : {}),
    },
    { status, headers },
  );
}

export function tooManyRequests(message: string, rate: RateResult): NextResponse {
  return fail(429, message, { rate });
}

export function ok<T>(body: T, rate?: RateResult): NextResponse {
  const headers: Record<string, string> = {};
  if (rate) Object.assign(headers, rateHeaders(rate));
  return json(body, { headers });
}

/** Read a JSON body without letting a malformed payload throw a 500. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
