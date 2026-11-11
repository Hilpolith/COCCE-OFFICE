import { describe, expect, it } from 'vitest';
import { officeAuthRedirectUrl } from './officeAuthRedirect';

describe('officeAuthRedirectUrl', () => {
  it('uses the stable Office callback in production', () => {
    expect(officeAuthRedirectUrl({ hostname: 'cocce-office.vercel.app', origin: 'https://cocce-office.vercel.app' })).toBe('https://cocce-office.vercel.app/auth/callback');
  });
  it('keeps localhost callbacks local', () => {
    expect(officeAuthRedirectUrl({ hostname: 'localhost', origin: 'http://localhost:5173' })).toBe('http://localhost:5173/auth/callback');
  });
  it('uses the production callback from Office preview hosts', () => {
    expect(officeAuthRedirectUrl({ hostname: 'cocce-office-git-feature-hilpolithrothschild-7822s-projects.vercel.app', origin: 'https://cocce-office-git-feature-hilpolithrothschild-7822s-projects.vercel.app' })).toBe('https://cocce-office.vercel.app/auth/callback');
  });
  it('rejects unrelated hosts as callback origins', () => {
    expect(officeAuthRedirectUrl({ hostname: 'attacker.example', origin: 'https://attacker.example' })).toBe('https://cocce-office.vercel.app/auth/callback');
  });
});
