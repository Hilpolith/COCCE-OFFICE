import { describe, expect, it, vi } from 'vitest';
import { getOfficePresenceStatus, isActiveCocceVip, OFFICE_PRESENCE_STALE_AFTER_MS } from './officePersonStatus';

const now = Date.parse('2026-11-01T12:00:00.000Z');

describe('COCCE VIP and Office presence presentation rules', () => {
  it('shows VIP only for a true server field whose expiry is absent or in the future', () => {
    expect(isActiveCocceVip(true, null, now)).toBe(true);
    expect(isActiveCocceVip(true, '2026-11-01T12:00:00.001Z', now)).toBe(true);
    expect(isActiveCocceVip(true, '2026-11-01T12:00:00.000Z', now)).toBe(false);
    expect(isActiveCocceVip(true, '2026-10-31T23:59:59.000Z', now)).toBe(false);
    expect(isActiveCocceVip(true, 'not-a-date', now)).toBe(false);
    expect(isActiveCocceVip(false, null, now)).toBe(false);
    expect(isActiveCocceVip(null, null, now)).toBe(false);
  });

  it('interprets a COCCE timestamp without an offset as local time at the expiry boundary', () => {
    vi.stubEnv('TZ', 'Africa/Dar_es_Salaam');
    try {
      const expiry = '2026-11-01T12:00:00';
      const localBeforeExpiry = new Date(2026, 10, 1, 11, 59, 59, 999).getTime();
      const localAtExpiry = new Date(2026, 10, 1, 12, 0, 0).getTime();

      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Africa/Dar_es_Salaam');
      expect(Date.parse(expiry)).toBe(localAtExpiry);
      expect(isActiveCocceVip(true, expiry, localBeforeExpiry)).toBe(true);
      expect(isActiveCocceVip(true, expiry, localAtExpiry)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows only fresh heartbeats as online or away; stale/missing/invalid entries are offline', () => {
    const fresh = new Date(now - 25_000).toISOString();
    const stale = new Date(now - OFFICE_PRESENCE_STALE_AFTER_MS - 1).toISOString();
    expect(getOfficePresenceStatus('online', fresh, now)).toBe('online');
    expect(getOfficePresenceStatus('away', fresh, now)).toBe('away');
    expect(getOfficePresenceStatus('offline', fresh, now)).toBe('offline');
    expect(getOfficePresenceStatus('online', stale, now)).toBe('offline');
    expect(getOfficePresenceStatus('online', 'not-a-date', now)).toBe('offline');
    expect(getOfficePresenceStatus('online', null, now)).toBe('offline');
    expect(getOfficePresenceStatus(null, fresh, now)).toBe('unknown');
  });
});
