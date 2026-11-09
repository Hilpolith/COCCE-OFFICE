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

The package's explicit scripts include Postgres-oriented checks for School SMS, Accounting, Manufacturing, Healthcare Administration, Healthcare residency approvals, NGO, Hospitality, and Institutions. The package scripts do not list a dedicated Government correspondence Postgres suite or a dedicated University Management Postgres suite. School's named Postgres script is specifically the SMS check, not a full School Management acceptance suite. Business also has no dedicated Business Management Postgres script listed in the package scripts. General Vitest coverage may exist, but this audit did not establish end-to-end coverage for those three/four sectors.

## Security and data-access observations

- Every inspected sector table has RLS enabled.
- The Supabase security advisor reports many RLS-enabled tables without direct policies, including sector tables. These tables are accessed through `SECURITY DEFINER` RPCs, so the critical boundary is the full chain of authenticated-user, active Office Team membership, sector role, capability, workspace scoping, and mutation validation inside the RPC and its private helpers.
- Direct table access should remain denied unless an explicitly reviewed policy is introduced. Do not add broad `authenticated` policies as a shortcut.
- The security advisor also reports unrelated legacy COCCE `orders` and `order_items` tables with policies while RLS is disabled. They were not changed because this task is scoped to Office and those tables are outside these sector modules.
- Do not use real patient, student, beneficiary, donor, or other regulated personal data in synthetic acceptance tests.

## Next implementation and verification gates

1. Add dedicated Postgres acceptance coverage for Government, University, and Business; expand School coverage beyond SMS.
2. For each sector, exercise authenticated non-member denial, active member access, unassigned-role denial, role/capability denial, workspace isolation, create/update/delete or archive semantics, optimistic-version conflicts, idempotent retries, approval transitions, audit events, and report totals.
3. Verify dashboards against the underlying records and check pagination boundaries, empty/loading/error states, and exports against source data.
4. Test privacy-key setup, unlock, lock-on-scope-change, and private-field non-disclosure for each module that handles protected records.
5. Run the full package test command and production build in a network-enabled checkout, then verify the matching Vercel deployment. The current audit environment could inspect GitHub and Vercel but could not clone the repository for local execution because outbound DNS resolution to github.com failed.
6. Keep schema changes separate from UI changes. Before any migration, inspect the exact table constraints, policies, helper functions, grants, and migration history; use a reviewed migration and run Supabase advisors.

## Deployment baseline at audit time

The latest inspected production deployment for `main` is READY and corresponds to commit `d1e9e89c1f03d13d857f21168c8647094dcde306` (`Polish authentication glass surfaces`). This confirms the production build was deployed, not that all ten sector workflows passed end-to-end tests.
