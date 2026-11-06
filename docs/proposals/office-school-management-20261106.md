# COCCE Office School Management System

## Status

The integrated School Management schema is applied to the COCCE Super App database as migration `20261106214240_office_school_management` (version `20261106214240`). The exact applied SQL is in `office-school-management-20261106.sql`; its SHA-256 is `76c5afe9328f18e8928c33ff9eaed33bd1feed377009f820175379e7a9e485e3`.

The School dashboard is deployed to the selected Vercel project `cocce-office` at [cocce-office.vercel.app](https://cocce-office.vercel.app). The verified production deployment is `dpl_CpMLB9NDEquSXWMUS7zWKNDzo5v5`, built from application commit `488291bdcfab58dbcdc8838b9cc15ecf70ece42c`. The public alias returned HTTP 200, and its shipped JavaScript includes the School Management, Admissions, Attendance, Fees, Timetable, and School RPC integration.

The first database attempt rolled back before commit because the draft referenced a nonexistent `office_workspaces.workspace_id`. The live Office workspace table uses `id`; all six School foreign keys and the disposable fixture were corrected and revalidated before the successful application. The failed attempt left no School objects or migration-history entry.

## Included workflows

The School workspace brings admissions, student enrollment, teacher and class assignments, attendance, assessments and grades, fee charges and receipts, encrypted notices, and a timetable with managed terms/classes/subjects, conflict checks, optimistic versions, and append-only audit history into one SMS dashboard.

## Student-data privacy

Operational codes are random and non-identifying. Student/guardian identity and contact details are encrypted in the browser with AES-256-GCM before they reach Supabase. The passphrase-derived key stays in memory; only key-setup parameters and encrypted identity ciphertext are stored remotely. All 21 School tables have RLS enabled, client roles have no direct table read/write grants, and the exposed workflows go through authenticated SECURITY DEFINER RPCs pinned to an empty `search_path`. No device-local browser records were copied into the School workspace.

School communications are encrypted drafts that can be approved; there is no configured messaging transport in this release, so approval does not mean a message was sent or delivered.

## Validation

The corrected migration passed all 8 synthetic PGlite acceptance tests. Focused School dashboard, encryption/API, role/privacy, and timetable tests passed 20/20. The full `npm test` suite passed, and `npm run build` succeeded. `npm run lint` reported 3 existing control-character-regex warnings in cloud filename/snapshot validation files and no errors; none are in the new School files.

Production verification confirmed the migration history row, RLS on all 21 tables, no direct `anon` or `authenticated` table SELECT/INSERT access, and SECURITY DEFINER plus empty `search_path` on the School RPCs/private helpers. Only authenticated clients can execute the public School RPCs.

## Storage and delivery limits

This School record path does not upload student/guardian records to Bunny.net. The separate Docs/Sheets/Slides cloud auto-sync path is opt-in per item, but live Bunny transfers remain unverified while Bunny credits are exhausted. No automatic migration of device-local documents or student records is performed.