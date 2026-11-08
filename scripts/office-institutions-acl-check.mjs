import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Supabase owner defaults cannot leave Institutions browser table/sequence grants or service audit mutation privileges', async () => {
  const db = new PGlite();
  try {
    const bootstrap = await readFile(new URL('../supabase/tests/university-bootstrap.sql', import.meta.url), 'utf8');
    await db.exec(bootstrap.replace(/^\\.*$/gm, '') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
    await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role; alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;');
    const directory = new URL('../supabase/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^2026110810.*_office_institutions_.*\.sql$/.test(name)).sort()) {
      await db.exec((await readFile(new URL(name, directory), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    const tables = (await db.query("select c.relname,c.relrowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'office_institutions_%' order by c.relname")).rows;
    assert.equal(tables.length, 8);
    assert(tables.every(row => row.relrowsecurity && !row.auth && !row.anon));
    const audit = (await db.query("select has_table_privilege('service_role','public.office_institutions_audit','SELECT') as read,has_table_privilege('service_role','public.office_institutions_audit','INSERT') as append,has_table_privilege('service_role','public.office_institutions_audit','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as mutation")).rows[0];
    assert.deepEqual(audit, { read: true, append: true, mutation: false });
    const endpoints = (await db.query("select p.proname,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('office_institutions_command','office_institutions_read')")).rows;
    assert.equal(endpoints.length, 2);
    assert(endpoints.every(row => row.auth && !row.anon));
    const exposed = (await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='office_private' and left(p.proname,5)='inst_' and (has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('anon',p.oid,'EXECUTE'))")).rows[0];
    assert.equal(exposed.n, 0);
  } finally { await db.close(); }
});
