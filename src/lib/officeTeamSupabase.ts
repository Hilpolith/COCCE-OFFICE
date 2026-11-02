import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const COCCE_SUPABASE_PROJECT_REF = 'nresyncmhdybucenhxbw';
export const COCCE_SUPABASE_URL = `https://${COCCE_SUPABASE_PROJECT_REF}.supabase.co`;

export type OfficeTeamEnvironment = {
  VITE_COCCE_SUPABASE_URL?: string;
  VITE_COCCE_SUPABASE_ANON_KEY?: string;
  VITE_OFFICE_TEAM_SCHEMA_READY?: string;
};

export type OfficeTeamConfigState =
  | { status: 'missing-url' }
  | { status: 'invalid-url' }
  | { status: 'wrong-project'; actualProjectRef: string }
  | { status: 'missing-public-key' }
  | { status: 'invalid-public-key' }
  | { status: 'ready'; url: string; projectRef: string; anonKey: string; schemaReady: boolean };

function hasAnonRole(key: string): boolean {
  const segments = key.split('.');
  if (segments.length !== 3) return false;
  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const claims = JSON.parse(globalThis.atob(paddedPayload)) as { role?: unknown };
    return claims.role === 'anon';
  } catch {
    return false;
  }
}

function isPublicSupabaseKey(key: string): boolean {
  if (/^sb_secret_/i.test(key)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  return hasAnonRole(key);
}

export function resolveOfficeTeamConfig(env: OfficeTeamEnvironment): OfficeTeamConfigState {
  const url = env.VITE_COCCE_SUPABASE_URL?.trim() ?? '';
  if (!url) return { status: 'missing-url' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'invalid-url' };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co') || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    return { status: 'invalid-url' };
  }

  const actualProjectRef = parsed.hostname.slice(0, -'.supabase.co'.length);
  if (actualProjectRef !== COCCE_SUPABASE_PROJECT_REF || parsed.origin !== COCCE_SUPABASE_URL) {
    return { status: 'wrong-project', actualProjectRef };
  }

  const anonKey = env.VITE_COCCE_SUPABASE_ANON_KEY?.trim() ?? '';
  if (!anonKey) return { status: 'missing-public-key' };
  if (!isPublicSupabaseKey(anonKey)) return { status: 'invalid-public-key' };

  return {
    status: 'ready',
    url: COCCE_SUPABASE_URL,
    projectRef: COCCE_SUPABASE_PROJECT_REF,
    anonKey,
    schemaReady: env.VITE_OFFICE_TEAM_SCHEMA_READY === 'true',
  };
}

let cachedConfigKey = '';
let cachedOfficeClient: SupabaseClient | null = null;

/** Create one Office-local browser session against the existing COCCE Auth project; never use service-role credentials. */
export function getOfficeTeamClient(config: OfficeTeamConfigState): SupabaseClient | null {
  if (config.status !== 'ready') return null;
  const nextConfigKey = `${config.url}\u0000${config.anonKey}`;
  if (cachedOfficeClient && cachedConfigKey === nextConfigKey) return cachedOfficeClient;

  cachedOfficeClient = createClient(config.url, config.anonKey, {
    auth: {
      storageKey: 'cocce-office-auth-session',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  });
  cachedConfigKey = nextConfigKey;
  return cachedOfficeClient;
}
