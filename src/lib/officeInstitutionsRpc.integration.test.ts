// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createOfficeRecordsKeyConfig, unlockOfficeRecordsKeyConfig, encryptOfficePrivateRecord, decryptOfficePrivateRecord } from './officePrivateRecordsCrypto';
import { officeInstitutionsManagementApi as api } from './officeInstitutionsManagement';
import type { InstitutionsRpcClient } from './officeInstitutionsManagement';
import type { InstitutionsAction, InstitutionsRow } from './officeInstitutionsTypes';

const w = '10000000-0000-4000-8000-000000000011';
const owner = '20000000-0000-4000-8000-000000000011';
const reviewer = '20000000-0000-4000-8000-000000000012';
const safeOfficer = '20000000-0000-4000-8000-000000000013';
let db: PGlite;
let actor = owner;
const client = {
  async rpc(name: string, args: Record<string, unknown>) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec('set role authenticated');
    try {
      const result = name === 'office_institutions_read'
        ? await db.query<{ r: unknown }>('select public.office_institutions_read($1,$2,$3,$4,$5) r', [args.p_workspace_id, args.p_resource, args.p_filter, args.p_limit, args.p_offset])
        : await db.query<{ r: unknown }>('select public.office_institutions_command($1,$2,$3) r', [args.p_workspace_id, args.p_action, args.p_payload]);
      return { data: result.rows[0].r, error: null };
    } catch (cause) {
      return { data: null, error: { message: (cause as Error).message } };
    } finally { await db.exec('reset role'); }
  },
} as unknown as InstitutionsRpcClient;
const command = (action: InstitutionsAction, payload: InstitutionsRow = {}) => api.command(client, w, action, { ...payload, idempotency_key: randomUUID() });

beforeAll(async () => {
  db = new PGlite();
  const root = new URL('../../', import.meta.url);
  const bootstrap = await readFile(new URL('supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm, '') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
  await db.query('insert into auth.users(id) values($1),($2),($3)', [owner, reviewer, safeOfficer]);
  await db.query('insert into public.office_workspaces(id) values($1)', [w]);
  await db.query("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church')", [w]);
  await db.query("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active')", [w, owner, reviewer, safeOfficer]);
  for (const name of (await readdir(new URL('supabase/migrations/', root))).filter(name => /^2026110810.*_office_institutions_.*\.sql$/.test(name)).sort()) {
    const sql = await readFile(new URL(`supabase/migrations/${name}`, root), 'utf8');
    await db.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  }
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('Institutions production adapter with the complete real SQL chain', () => {
  it('initializes as the owner and assigns new roles without fictitious existing versions', async () => {
    expect((await api.bootstrap(client, w)).settings.initialized).toBe(false);
    await command('initialize');
    await command('assign_role', { user_id: reviewer, role: 'privacy_officer', active: true });
    await command('assign_role', { user_id: safeOfficer, role: 'safeguarding_officer', active: true });
    const state = await api.bootstrap(client, w);
    expect(state.role).toBe('institution_admin');
    expect(state.capabilities.safeguarding).toBe(false);
    expect(state.settings.private_data_enabled).toBe(false);
    expect((await api.keys(client, w)).people.configured).toBe(false);
  });

  it('configures before approval, returns real verifier metadata only to its authorized kind, and completes encrypted/private workflows', async () => {
    const peoplePassphrase = 'SYNTHETIC people passphrase 42';
    const safePassphrase = 'SYNTHETIC safeguarding passphrase 84';
    const peopleConfig = await createOfficeRecordsKeyConfig(peoplePassphrase, `institutions/${w}/people`);
    const safeConfig = await createOfficeRecordsKeyConfig(safePassphrase, `institutions/${w}/safeguarding`);
    await command('configure_private_key', { kind: 'people', ...peopleConfig.payload, expected_version: 1 });
    await command('configure_private_key', { kind: 'safeguarding', ...safeConfig.payload, expected_version: 2 });
    const adminKeys = await api.keys(client, w);
    expect(adminKeys.people.salt).toBe(peopleConfig.payload.salt);
    expect(adminKeys.safeguarding).toEqual({ configured: true, accessible: false });
    const peopleKey = await unlockOfficeRecordsKeyConfig(peoplePassphrase, adminKeys.people, `institutions/${w}/people`);
    await command('record_storage_review', { reference: 'SYNTHETIC-REVIEW-RECORD', expected_version: 3 });
    actor = reviewer;
    await command('review_storage', { decision: 'approved', reference: 'SYNTHETIC-INDEPENDENT-REVIEW', expected_version: 4 });
    const reviewerKeys = await api.keys(client, w);
    const safeKey = await unlockOfficeRecordsKeyConfig(safePassphrase, reviewerKeys.safeguarding, `institutions/${w}/safeguarding`);
    actor = owner;
    const approved = await api.bootstrap(client, w);
    expect(approved.settings.storage_review_recorded_by).toBe(owner);
    expect(approved.settings.storage_reviewed_by).toBe(reviewer);
    await command('set_private_gate', { enabled: true, expected_version: 5 });

    const person = randomUUID();
    const personPlain = { details: 'SYNTHETIC PERSON ONLY', contact: 'SYNTHETIC-NO-REAL-CONTACT' };
    const personCipher = await encryptOfficePrivateRecord(peopleKey, personPlain, `institutions/${w}/people/${person}`);
    await command('save_private', { resource: 'people', id: person, data: { code: 'SYNTHETIC-PERSON', lawful_basis: 'consent', notice_reference: 'SYNTHETIC-NOTICE', retention_until: '2030-01-01', ...personCipher } });
    const peopleIndex = await api.page(client, w, 'people_index');
    expect(peopleIndex.rows[0]).not.toHaveProperty('ciphertext');
    const exact = await api.page(client, w, 'people', { id: person, purpose: 'administration' });
    expect(exact.rows[0].notice_reference).toBe('SYNTHETIC-NOTICE');
    expect(await decryptOfficePrivateRecord(peopleKey, exact.rows[0] as { nonce: string; ciphertext: string }, `institutions/${w}/people/${person}`)).toEqual(personPlain);
    const deactivated = await command('transition_record', { resource: 'people', id: person, expected_version: 1, to_state: 'inactive', data: {} });
    expect(deactivated.status).toBe('inactive');

    actor = safeOfficer;
    expect((await api.keys(client, w)).people.configured).toBe(false);
    const caseId = randomUUID();
    const caseMeta = { code: 'SYNTHETIC-CASE', lawful_basis: 'legal_obligation', notice_reference: 'SYNTHETIC-SAFE-NOTICE', retention_until: '2030-01-01' };
    const initial = await encryptOfficePrivateRecord(safeKey, { intake: 'SYNTHETIC INTAKE', risk: 'SYNTHETIC RISK' }, `institutions/${w}/safeguarding/${caseId}`);
    await command('save_private', { resource: 'safeguarding', id: caseId, data: { ...caseMeta, ...initial } });
    const exactCase = await api.page(client, w, 'safeguarding', { id: caseId, purpose: 'safeguarding_response' });
    expect(await decryptOfficePrivateRecord(safeKey, exactCase.rows[0] as { nonce: string; ciphertext: string }, `institutions/${w}/safeguarding/${caseId}`)).toEqual({ intake: 'SYNTHETIC INTAKE', risk: 'SYNTHETIC RISK' });
    const revised = await encryptOfficePrivateRecord(safeKey, { intake: 'SYNTHETIC INTAKE', risk: 'SYNTHETIC REVIEWED RISK' }, `institutions/${w}/safeguarding/${caseId}`);
    await command('save_private', { resource: 'safeguarding', id: caseId, expected_version: 1, data: { ...caseMeta, ...revised } });
    expect((await command('transition_record', { resource: 'safeguarding', id: caseId, expected_version: 2, to_state: 'triaged', data: {} })).status).toBe('triaged');

    actor = owner;
    const privacy = await command('save_record', { resource: 'privacy_requests', data: { code: 'SYNTHETIC-PRIVACY', request_type: 'access', received_on: '2026-01-01', due_on: '2026-02-01', reference: 'SYNTHETIC-REQUEST' } });
    actor = reviewer;
    const reviewed = await command('transition_record', { resource: 'privacy_requests', id: privacy.id, expected_version: 1, to_state: 'reviewed', data: { reference: 'SYNTHETIC-REVIEW' } });
    expect((await command('transition_record', { resource: 'privacy_requests', id: privacy.id, expected_version: reviewed.version, to_state: 'fulfilled', data: { reference: 'SYNTHETIC-FULFILLMENT' } })).status).toBe('fulfilled');

    actor = owner;
    await expect(api.page(client, w, 'safeguarding', { id: caseId, purpose: 'compliance_review' })).rejects.toThrow();
    await command('set_private_gate', { enabled: false, expected_version: 6 });
    await expect(command('transition_record', { resource: 'people', id: person, expected_version: 2, to_state: 'active', data: {} })).rejects.toThrow(/gate closed/);
  }, 30_000);

  it('exports the real immutable snapshot with canonical id, purpose and exact version', async () => {
    actor = owner;
    const report = await command('create_report', { report_type: 'finance', period_start: '2026-01-01', period_end: '2026-12-31', title: 'SYNTHETIC ANNUAL REPORT' });
    const exported = await command('export_report', { id: report.id, expected_version: report.version, purpose: 'compliance_review' });
    expect(exported.row).toEqual(expect.objectContaining({ id: report.id, title: 'SYNTHETIC ANNUAL REPORT', snapshot: expect.objectContaining({ inflow: 0, outflow: 0, net: 0 }) }));
    await expect(command('export_report', { id: report.id, expected_version: 999, purpose: 'compliance_review' })).rejects.toThrow();
    actor = safeOfficer;
    expect((await api.page(client, w, 'reports')).total_count).toBe(0);
    await expect(command('create_report', { report_type: 'finance', period_start: '2026-01-01', period_end: '2026-12-31', title: 'SYNTHETIC UNAUTHORIZED' })).rejects.toThrow(/capability/);
    await expect(command('export_report', { id: report.id, expected_version: report.version, purpose: 'compliance_review' })).rejects.toThrow();
    actor = owner;
  });
});
