# COCCE Office cloud auto-sync: implementation and release status

**Status: database migration applied; backend Edge Function deployed.** The approved SQL is recorded as migration `20261106180419_office_cloud_sync_revisions_20261106` on COCCE Super App (`nresyncmhdybucenhxbw`). The `office-cloud-files` Edge Function is active at version 4 with JWT verification enabled. No Bunny transfer was performed.

## What is implemented

Docs, Sheets and Slides have a per-item **Enable sync for this item** control. Nothing is sent until the user confirms the first upload for that specific local item. After opt-in, later saved changes can upload as immutable cloud revisions. Local originals remain in place, other browser-local records are not copied, and stale cloud versions stop with a conflict instead of being overwritten. Interrupted uploads reuse the existing metadata-only pending journal and recovery flow; document bytes are not put in that journal.

This does **not** provide cloud sync for Drive, PDF, Vault, or other local-only formats. There is no automatic migration of existing device-local records. The signed Bunny path follows the COCCE Office workspace/private-storage convention and Frankfurt region from the COCCE Super App reference.

## Applied SQL and verification

The applied SQL is [`office-cloud-sync-revisions-20261106.sql`](./office-cloud-sync-revisions-20261106.sql), SHA-256 `2650231a5b14a7aea7d8e644e3f6684ae004315831077ccbc44f0f7ece1e39ce`. It adds a self-referencing base-revision link and chain constraints, allows only one pending revision per file, guards revision-pointer advances so they must be available children of the current revision, and adds service-role-only RPCs for metadata-only sync-state lookup and conflict-checked revision reservations. It does not upload data, change wallet/coin or quota policy, expose object keys through the browser API, or copy local records.

Production verification confirmed the migration record, revision column/constraints, and SECURITY DEFINER RPCs with an empty `search_path` and service-role-only grants. The deployed Edge Function reports version 4, retains JWT verification, and returned a successful `204` CORS preflight for `https://cocce-office.vercel.app`. No live Bunny PUT/GET/HEAD was attempted.

## Tests and remaining limits

`npm run test:office-cloud` passed: 38 Edge tests plus 24 disposable PostgreSQL acceptance tests, including immutable revision history, stale-base conflicts, membership isolation, idempotency and grants. The focused consent/control plus Docs/Sheets/Slides regression tests passed 47/47; the isolated Vault suite passed 10/10. The production build passed. The final full `npm test` run reported 661/662 passing, with one unrelated encrypted-Vault metadata test exceeding its five-second timeout under parallel load; that test passed on its own. Lint has zero errors and three existing filename-validation warnings in `docsCloudSnapshot.ts`, `officeCloudFiles.ts` and `officeCloudPending.ts`.

The client code has not yet been pushed or deployed to Vercel. Vercel sign-in is required to finish the selected `cocce-office` deployment. Bunny credits were reported exhausted, so live cloud transfers remain unverified; after credits are restored, a real transfer smoke test is still required. The School timetable SQL remains an unapplied timetable-only draft and is not a substitute for the expanded School Management System (admissions, students/guardians, attendance, grades, fees, communications, teacher/class management and timetable).
