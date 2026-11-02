// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  COCCE_SUPABASE_PROJECT_REF,
  COCCE_SUPABASE_URL,
  getOfficeTeamClient,
  resolveOfficeTeamConfig,
} from './officeTeamSupabase';

const publishableKey = 'sb_publishable_test-public-key';
const validEnvironment = {
  VITE_COCCE_SUPABASE_URL: COCCE_SUPABASE_URL,
  VITE_COCCE_SUPABASE_ANON_KEY: publishableKey,
  VITE_OFFICE_TEAM_SCHEMA_READY: 'true',
};

function jwtWithRole(role: string) {
  const payload = globalThis.btoa(JSON.stringify({ role })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `header.${payload}.signature`;
}

describe('Office-owned COCCE Auth client', () => {
  it('accepts only the exact existing COCCE Supabase project and an HTTPS URL', () => {
    expect(resolveOfficeTeamConfig(validEnvironment)).toMatchObject({
      status: 'ready', url: COCCE_SUPABASE_URL, projectRef: COCCE_SUPABASE_PROJECT_REF, schemaReady: true,
    });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_URL: 'https://another-project.supabase.co' }))
      .toEqual({ status: 'wrong-project', actualProjectRef: 'another-project' });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_URL: 'http://localhost:54321' }))
      .toEqual({ status: 'invalid-url' });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_URL: 'not-a-url' }))
      .toEqual({ status: 'invalid-url' });
  });

  it('requires a public anon or publishable key and rejects service-role/secret keys', () => {
    expect(resolveOfficeTeamConfig({ VITE_COCCE_SUPABASE_URL: COCCE_SUPABASE_URL }))
      .toEqual({ status: 'missing-public-key' });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_ANON_KEY: jwtWithRole('service_role') }))
      .toEqual({ status: 'invalid-public-key' });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_ANON_KEY: 'sb_secret_do-not-use' }))
      .toEqual({ status: 'invalid-public-key' });
    expect(resolveOfficeTeamConfig({ ...validEnvironment, VITE_COCCE_SUPABASE_ANON_KEY: jwtWithRole('anon') }).status)
      .toBe('ready');
  });

  it('requires the COCCE project URL and does not create a client when configuration is incomplete', () => {
    const missingUrl = resolveOfficeTeamConfig({ VITE_COCCE_SUPABASE_ANON_KEY: publishableKey });
    expect(missingUrl).toEqual({ status: 'missing-url' });
    expect(getOfficeTeamClient(missingUrl)).toBeNull();
  });

  it('creates an Office-local Auth client even while the Office schema gate remains disabled', () => {
    const config = resolveOfficeTeamConfig({ ...validEnvironment, VITE_OFFICE_TEAM_SCHEMA_READY: 'false' });
    expect(config.status).toBe('ready');
    if (config.status !== 'ready') return;
    expect(config.schemaReady).toBe(false);
    const client = getOfficeTeamClient(config);
    expect(client).not.toBeNull();
    expect(typeof client?.auth.signInWithPassword).toBe('function');
    expect(typeof client?.auth.signOut).toBe('function');
  });

  it('reuses one Office client instance for the same project and public key', () => {
    const config = resolveOfficeTeamConfig(validEnvironment);
    expect(config.status).toBe('ready');
    if (config.status !== 'ready') return;
    expect(getOfficeTeamClient(config)).toBe(getOfficeTeamClient(config));
  });
});
