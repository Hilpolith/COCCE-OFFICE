// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import OfficePersonIdentity from './OfficePersonIdentity';

afterEach(cleanup);

const now = Date.parse('2026-11-01T12:00:00.000Z');

describe('OfficePersonIdentity', () => {
  it('renders an online label and the badge for an active server-reported VIP', () => {
    render(<OfficePersonIdentity
      name="Asha"
      isVip
      vipExpiresAt="2026-12-01T00:00:00.000Z"
      presenceStatus="online"
      lastSeenAt="2026-11-01T11:59:50.000Z"
      now={now}
    />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByTestId('vip-badge')).toBeTruthy();
  });

  it('does not show an expired VIP and treats stale presence as offline', () => {
    render(<OfficePersonIdentity
      name="Juma"
      isVip
      vipExpiresAt="2026-10-31T00:00:00.000Z"
      presenceStatus="online"
      lastSeenAt="2026-11-01T11:58:00.000Z"
      now={now}
    />);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.queryByTestId('vip-badge')).toBeNull();
  });

  it('does not disclose an identifier or invent status when profile visibility is denied', () => {
    render(<OfficePersonIdentity name="" presenceStatus={null} lastSeenAt={null} now={now} />);
    expect(screen.getByText('COCCE member')).toBeTruthy();
    expect(screen.getByText('Status unavailable')).toBeTruthy();
    expect(screen.queryByTestId('vip-badge')).toBeNull();
  });
});
