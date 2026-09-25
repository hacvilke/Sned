import { createHash } from "node:crypto";

/**
 * Best-effort client identity. On Vercel `x-forwarded-for` is set by the
 * platform edge; `x-real-ip` is the fallback. Values are hashed before they
 * touch the rate limiter so we never persist a raw IP.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export function identityOf(request: Request): { ip: string; id: string } {
  const ip = clientIp(request);
  return { ip, id: `ip:${hashIp(ip)}` };
}

export function userAgentIsMobile(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua);
}
