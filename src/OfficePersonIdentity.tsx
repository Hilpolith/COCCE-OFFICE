import VipBadge from './VipBadge';
import { getOfficePresenceStatus, isActiveCocceVip, type OfficeLocalTimestamp, type OfficePresenceStatus } from './lib/officePersonStatus';

type OfficePersonIdentityProps = {
  name: string;
  avatarUrl?: string | null;
  isVip?: boolean | null;
  vipExpiresAt?: OfficeLocalTimestamp | null;
  presenceStatus?: OfficePresenceStatus | null;
  lastSeenAt?: string | null;
  now: number;
  compact?: boolean;
};

export default function OfficePersonIdentity({
  name, avatarUrl, isVip, vipExpiresAt, presenceStatus, lastSeenAt, now, compact = false,
}: OfficePersonIdentityProps) {
  const presence = getOfficePresenceStatus(presenceStatus, lastSeenAt, now);
  const displayName = name.trim() || 'COCCE member';
  const initial = displayName.slice(0, 1).toLocaleUpperCase();
  const isVipActive = isActiveCocceVip(isVip, vipExpiresAt, now);
  const statusLabel = presence === 'online' ? 'Online' : presence === 'away' ? 'Away' : presence === 'unknown' ? 'Status unavailable' : 'Offline';

  return <div className={`office-person-identity${compact ? ' is-compact' : ''}`}>
    <span className="office-avatar" aria-hidden="true">{avatarUrl ? <img src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initial}</span>
    <span className="office-person-copy">
      <span className="office-person-name" title={displayName}>{displayName}{isVipActive && <VipBadge size={14} />}</span>
      <span className={`office-presence-label is-${presence}`} aria-label={`${displayName}: ${statusLabel}`}><i aria-hidden="true" />{statusLabel}</span>
    </span>
  </div>;
}
