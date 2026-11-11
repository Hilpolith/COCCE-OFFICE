const PRODUCTION_OFFICE_ORIGIN = 'https://cocce-office.vercel.app';
const OFFICE_AUTH_CALLBACK_PATH = '/auth/callback';

type BrowserLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Keep authentication callbacks on the COCCE Office web origin. Local
 * development remains local; deployed Office hosts use the single production
 * callback configured in the shared COCCE Auth redirect allowlist.
 */
export function officeAuthRedirectUrl(location: BrowserLocation): string {
  const hostname = location.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const origin = isLocal ? location.origin : PRODUCTION_OFFICE_ORIGIN;
  return new URL(OFFICE_AUTH_CALLBACK_PATH, origin).toString();
}
