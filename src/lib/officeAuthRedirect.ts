const PRODUCTION_OFFICE_ORIGIN = 'https://cocce-office.vercel.app';
const OFFICE_AUTH_CALLBACK_PATH = '/auth/callback';

type BrowserLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Use the one exact callback URL configured in the shared COCCE Supabase Auth
 * allowlist for every deployed Office environment. Only local development
 * stays local. This prevents previews or untrusted hosts from becoming OAuth
 * redirect targets and never uses the COCCE mobile app's custom URL scheme.
 */
export function officeAuthRedirectUrl(location: BrowserLocation): string {
  const hostname = location.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const origin = isLocal ? location.origin : PRODUCTION_OFFICE_ORIGIN;
  return new URL(OFFICE_AUTH_CALLBACK_PATH, origin).toString();
}
