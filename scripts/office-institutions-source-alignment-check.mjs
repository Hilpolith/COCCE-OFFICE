import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const md5 = text => createHash('md5').update(text).digest('hex');
const cases = [
  { signature: 'public.office_institutions_read(uuid,text,jsonb,integer,integer)', file: '20261108104001_office_institutions_read_rpc.sql', expected: '2938d50a1f2e8e72b46fcd9b506f2991', observed: 'a27a8839e98dce6ef9ffcadb81bafb40', offset: 1142, insertion: '_reference:=NULL;s.storage_review_recorded_by:=NULL;s.storage_reviewed_by:=NULL;s.storage_review_decision' },
  { signature: 'office_private.inst_reports(uuid,text,jsonb)', file: '20261108104002_office_institutions_reports.sql', expected: '8a653b602ae369ff4325d61bbf5ff709', observed: '62fe99b0a0c6ffe2da80707c7cef59bc', offset: 2840, insertion: "bid::text) AND(office_private.inst_actor_branch(w) IS NULL OR z.data->>'branch_id'=" },
];

test('source alignment repairs only the known deployment copies, is idempotent, preserves ACLs, and rejects unknown bodies', async () => {
  const db = new PGlite();
  try {
    const bootstrap = await readFile(new URL('../supabase/tests/university-bootstrap.sql', import.meta.url), 'utf8');
    await db.exec(bootstrap.replace(/^\\.*$/gm, '') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
    const directory = new URL('../supabase/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^2026110810.*_office_institutions_.*\.sql$/.test(name)).sort()) {
      await db.exec((await readFile(new URL(name, directory), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    const migration = await readFile(new URL('20261108105000_office_institutions_source_alignment.sql', directory), 'utf8');
    const source = async signature => (await db.query('select prosrc,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::regprocedure', [signature])).rows[0];
    for (const item of cases) {
      const frozen = (await readFile(new URL(item.file, directory), 'utf8')).match(/AS \$\$([\s\S]*?)\$\$/)[1];
      assert.equal(md5(frozen), item.expected);
      const observed = frozen.slice(0, item.offset) + item.insertion + frozen.slice(item.offset);
      assert.equal(md5(observed), item.observed, 'the fixture must exactly reproduce the verified live body');
      const row = await source(item.signature);
      assert.equal(md5(row.prosrc), item.expected);
      await db.exec(row.definition.replace(row.prosrc, () => observed));
    }
    await db.exec(migration);
    for (const item of cases) assert.equal(md5((await source(item.signature)).prosrc), item.expected);
    await db.exec(migration);
    for (const item of cases) assert.equal(md5((await source(item.signature)).prosrc), item.expected);
    const grants = (await db.query("select has_function_privilege('authenticated','public.office_institutions_read(uuid,text,jsonb,integer,integer)','execute') as auth_read,has_function_privilege('anon','public.office_institutions_read(uuid,text,jsonb,integer,integer)','execute') as anon_read,has_function_privilege('authenticated','office_private.inst_reports(uuid,text,jsonb)','execute') as helper")).rows[0];
    assert.deepEqual(grants, { auth_read: true, anon_read: false, helper: false });
    const last = cases[1];
    const before = await source(last.signature);
    await db.exec(before.definition.replace(before.prosrc, () => before.prosrc + ' '));
    await assert.rejects(() => db.exec(migration), /Unexpected Institutions source before alignment/);
    await db.exec('rollback');
    assert.equal((await source(last.signature)).prosrc, before.prosrc + ' ');
    const counts = (await db.query('select (select count(*)::int from public.office_institutions_settings) settings,(select count(*)::int from public.office_institutions_records) records')).rows[0];
    assert.deepEqual(counts, { settings: 0, records: 0 });
  } finally { await db.close(); }
});
