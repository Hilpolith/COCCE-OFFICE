import { describe, expect, it } from 'vitest';
import { officeAuthRedirectUrl } from './officeAuthRedirect';

describe('officeAuthRedirectUrl', () => {
  it('returns the stable Office web callback in production', () => {
    expect(officeAuthRedirectUrl({
      hostname: 'cocce-office.vercel.app',
      origin: 'https://cocce-office.vercel.app',
    })).toBe('https://cocce-office.vercel.app/auth/callback');
  });

  it('keeps localhost callbacks local for development', () => {
    expect(officeAuthRedirectUrl({
      hostname: 'localhost',
      origin: 'http://localhost:5173',
    })).toBe('http://localhost:5173/auth/callback');
  });

  it('uses the exact allowlisted production callback from Office previews', () => {
    expect(officeAuthRedirectUrl({
      hostname: 'cocce-office-git-feature-hilpolithrothschild-7822s-projects.vercel.app',
      origin: 'https://cocce-office-git-feature-hilpolithrothschild-7822s-projects.vercel.app',
    })).toBe('https://cocce-office.vercel.app/auth/callback');
  });

  it('never accepts an unrelated host as an OAuth callback', () => {
    expect(officeAuthRedirectUrl({
      hostname: 'attacker.example',
      origin: 'https://attacker.example',
    })).toBe('https://cocce-office.vercel.app/auth/callback');
  });
});
