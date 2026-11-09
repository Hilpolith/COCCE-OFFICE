# COCCE Office sector-management audit — 2026-11-09

## Scope and safety

- Repository: `Hilpolith/COCCE-OFFICE`
- Branch: `main` only
- Supabase project inspected: existing `COCCE Super App` project (`nresyncmhdybucenhxbw`)
- No schema, auth-provider, RLS-policy, or data changes were made during this audit.
- Existing VisionOS styling and account/onboarding work were left untouched.

## Verified integration baseline

The industry selector routes all ten destinations to dedicated management components. The generic shared work-item board is an additional operational-notes surface, not a substitute for the specialist modules.

| Sector | Dedicated UI component | Existing public tables | RLS enabled |
|---|---|---:|---:|
| Government / public administration | `GovernmentCorrespondenceWorkspace` | 11 | 11/11 |
| School | `SchoolManagementWorkspace` | 21 | 21/21 |
| University | `UniversityManagementWorkspace` | 21 | 21/21 |
| Business | `BusinessManagementWorkspace` | 28 | 28/28 |
| Accounting | `AccountingManagementWorkspace` | 21 | 21/21 |
| Manufacturing | `ManufacturingManagementWorkspace` | 24 | 24/24 |
| Healthcare administration | `HealthAdminManagementWorkspace` | 47 | 47/47 |
| NGO | `NgoManagementWorkspace` | 26 | 26/26 |
| Hospitality | `HospitalityManagementWorkspace` | 31 | 31/31 |
| Institutional / church | `InstitutionsManagementWorkspace` | 8 | 8/8 |
| **Total** | **10 specialist components** | **238** | **238/238** |

The connected database has corresponding sector migrations and dedicated read/command RPC functions. The main sector RPC functions inspected are executable by `authenticated` and not by `anon`; the Government connector workspace guard is service-role-only. The inspected definer functions use an empty search path. This is a positive baseline, not proof that every internal helper, command branch, or role/capability predicate is correct.

## Test coverage visible in package scripts

The package now includes dedicated PostgreSQL acceptance suites for Government, School, University, Business, Accounting, Manufacturing, Healthcare Administration, Healthcare residency approvals, NGO, Hospitality, and Institutions. The School Postgres script is named for SMS, but its fixture is byte-for-byte identical to the integrated production School migration and its eight tests cover bootstrap, terms/classes/subjects, timetable, encrypted student identity, admissions, enrollment, attendance, grading, receipts, parent notices, and role/workspace isolation. Business and University have isolated PostgreSQL schema validators; Institutions has an isolated schema/RLS/grant validator. The new Government suite runs the actual migration chain in PGlite and passes 11 tests. A clean network-enabled sandbox run of the full Vitest suite passed 127 test files and 1,052 tests (one skipped); `tsc -b` and `vite build` also passed. The focused navigation/Government/account/glass regression subset passed 26/26 tests. The university and business PostgreSQL validators are wired into CI, but their PG16 CI run has not yet completed.

## Security and data-access observations

- Every inspected sector table has RLS enabled.
- The Supabase security advisor reports many RLS-enabled tables without direct policies, including sector tables. These tables are accessed through `SECURITY DEFINER` RPCs, so the critical boundary is the full chain of authenticated-user, active Office Team membership, sector role, capability, workspace scoping, and mutation validation inside the RPC and its private helpers.
- Direct table access should remain denied unless an explicitly reviewed policy is introduced. Do not add broad `authenticated` policies as a shortcut.
- The security advisor also reports unrelated legacy COCCE `orders` and `order_items` tables with policies while RLS is disabled. They were not changed because this task is scoped to Office and those tables are outside these sector modules.
- Do not use real patient, student, beneficiary, donor, or other regulated personal data in synthetic acceptance tests.

## Next implementation and verification gates

1. Complete the first full CI run after the new package scripts and PostgreSQL binary path are wired. The workflow is currently queued/in progress; targeted UI regressions (26/26) and the Government PGlite suite (11/11) have passed locally in an isolated Vercel sandbox.
2. For each sector, keep exercising authenticated non-member denial, active member access, unassigned-role denial, role/capability denial, workspace isolation, create/update/delete or archive semantics, optimistic-version conflicts, idempotent retries, approval transitions, audit events, and report totals.
3. Verify dashboards against underlying records and check pagination boundaries, empty/loading/error states, and exports against source data.
4. Test privacy-key setup, unlock, lock-on-scope-change, and private-field non-disclosure for each module that handles protected records.
5. Keep schema changes separate from UI changes. Before any migration, inspect exact constraints, policies, helper functions, grants, and migration history; use a reviewed migration and run Supabase advisors.

## Deployment baseline at audit time

The latest code deployment for `main` is READY and corresponds to commit `dc63aa98bf5f26b78a5d615b90827ae63dcdaebe` (`Code-split all ten sector management workspaces`). The audit-document-only follow-up commit is `aea960365a6a2a41ed8f4d813ad92496efb68279` and does not change application code. All ten specialist sector components are now lazy-loaded. The main application JavaScript chunk fell from approximately 1,711.81 kB (gzip 451.92 kB) to 885.04 kB (gzip 249.73 kB), about a 48% reduction in the main chunk. The build still reports separate large Docs/PDF chunks; this is a performance warning, not a failed build. Production READY confirms deployability, not completion of all ten sector workflows.
