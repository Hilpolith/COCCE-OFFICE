export type OfficePresenceStatus = 'online' | 'away' | 'offline';
export type OfficePresenceDisplayStatus = OfficePresenceStatus | 'unknown';
export const OFFICE_PRESENCE_STALE_AFTER_MS = 90_000;

/**
 * COCCE profiles.vip_expires_at is PostgreSQL timestamp without time zone.
 * PostgREST returns it without an offset; the Office client interprets it as local time.
 */
export type OfficeLocalTimestamp = string;

/** Mirrors Profile.isVipActive: expiry is a COCCE local timestamp, compared with local time. */
export function isActiveCocceVip(isVip: boolean | null | undefined, vipExpiresAt: OfficeLocalTimestamp | null | undefined, now = Date.now()) {
  if (isVip !== true) return false;
  if (vipExpiresAt == null) return true;
  const expiry = Date.parse(vipExpiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

/** Status is workspace-scoped; a missing, stale, or future-dated heartbeat fails closed to offline. */
export function getOfficePresenceStatus(status: OfficePresenceStatus | null | undefined, lastSeenAt: string | null | undefined, now = Date.now()): OfficePresenceDisplayStatus {
  if (status == null) return 'unknown';
  if (!lastSeenAt) return 'offline';
  const lastSeen = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeen)) return 'offline';
  const age = now - lastSeen;
  if (age < -300_000 || age > OFFICE_PRESENCE_STALE_AFTER_MS) return 'offline';
  if (status === 'online' || status === 'away') return status;
  return 'offline';
}
