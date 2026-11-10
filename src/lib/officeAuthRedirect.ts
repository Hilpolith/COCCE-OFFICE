const PRODUCTION_OFFICE_ORIGIN = 'https://cocce-office.vercel.app';
const OFFICE_AUTH_CALLBACK_PATH = '/auth/callback';

type BrowserLocation = Pick<Location, 'origin' | 'hostname'>;

/**
 * Keep OAuth and email confirmation callbacks on the Office web origin.
 * Never use the COCCE Android/iOS app's custom URL scheme as a browser callback.
 */
export function officeAuthRedirectUrl(location: BrowserLocation): string {
  const hostname = location.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const isOfficePreview = hostname.startsWith('cocce-office-')
    && hostname.endsWith('-hilpolithrothschild-7822s-projects.vercel.app');
  const origin = isLocal || isOfficePreview
    ? location.origin
    : PRODUCTION_OFFICE_ORIGIN;
  const callback = new URL(OFFICE_AUTH_CALLBACK_PATH, origin);
  callback.searchParams.set('cocce_office_oauth', '1');
  return callback.toString();
}
