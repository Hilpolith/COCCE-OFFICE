import { useId } from 'react';

type VipBadgeProps = { size?: number };

/** Vector adaptation of COCCE Super App's VipBadge painter in lib/widgets/vip_badge.dart. */
export default function VipBadge({ size = 20 }: VipBadgeProps) {
  const gradientId = `cocce-vip-${useId().replaceAll(':', '')}`;
  const actualSize = Number.isFinite(size) && size > 0 ? size : 20;
  return <svg
    className="office-vip-badge"
    width={actualSize}
    height={actualSize}
    viewBox="0 0 100 100"
    role="img"
    aria-label="COCCE VIP badge"
    data-testid="vip-badge"
    focusable="false"
  >
    <defs>
      <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#FFD700" />
        <stop offset="100%" stopColor="#FFA500" />
      </linearGradient>
    </defs>
    <path d="M50 4 L90 18 L90 58 Q90 82 50 98 Q10 82 10 58 L10 18 Z" fill={`url(#${gradientId})`} />
    <path d="M50 4 L90 18 L90 58 Q90 82 50 98 Q10 82 10 58 L10 18 Z" transform="translate(50 50) scale(0.78412) translate(-50 -50)" fill="#65582B" />
    <path d="M33 51 L46 64 L70 38" fill="none" stroke="#FFD700" strokeWidth="8.267" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
