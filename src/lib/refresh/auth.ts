import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 16;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project has
 * a CRON_SECRET environment variable. Without a configured secret the endpoint
 * refuses every request, so it can never run unauthenticated.
 */
export function isAuthorizedRefreshRequest(authorization: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH || !authorization) return false;
  // Compare fixed-length digests so the check does not leak length or prefix timing.
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
