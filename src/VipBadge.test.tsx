// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VipBadge from './VipBadge';

describe('VipBadge', () => {
  it('renders the reusable vector shield/check artwork accessibly at the requested size', () => {
    render(<VipBadge size={16} />);
    const badge = screen.getByTestId('vip-badge');
    expect(badge.getAttribute('width')).toBe('16');
    expect(badge.getAttribute('height')).toBe('16');
    expect(badge.getAttribute('aria-label')).toBe('COCCE VIP badge');
    expect(badge.querySelector('linearGradient')).not.toBeNull();
    expect(badge.querySelector('path[stroke="#FFD700"]')).not.toBeNull();
  });
});
