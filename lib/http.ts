import { NextResponse } from 'next/server';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
    details?: unknown;
  };
}

export function json<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra?: { retryAfterSeconds?: number; details?: unknown },
): NextResponse<ApiErrorBody> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (extra?.retryAfterSeconds && extra.retryAfterSeconds > 0) {
    headers['retry-after'] = String(Math.ceil(extra.retryAfterSeconds));
  }
  return NextResponse.json(
    {
      error: {
        code,
        message,
        retryAfterSeconds: extra?.retryAfterSeconds,
        details: extra?.details,
      },
    },
    { status, headers },
  );
}

/** Best-effort client IP. Vercel sets `x-forwarded-for`; local dev falls back. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real;
  return 'local';
}

export async function readJsonBody<T>(request: Request): Promise<Partial<T> | null> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === 'object') return body as Partial<T>;
    return null;
  } catch {
    return null;
  }
}

export function asString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}
