# COCCE OFFICE — MASTER COMPLETION DIRECTIVE
## Full Production Implementation, Integration, Testing and Deployment

**Repository:** https://github.com/Hilpolith/COCCE-OFFICE  
**Production:** https://cocce-office.vercel.app  
**Branch:** `main` ONLY  
**Owner:** HILPOLITH ROTHSCHILD  
**Project:** COCCE Office — VisionOS-inspired enterprise management and productivity ecosystem.

---

# 1. YOUR MISSION

You are responsible for completing the entire COCCE Office application.
some work has been completed. 

This is not a request for another audit, a roadmap, a list of recommendations, a prototype, or a partial implementation

I want you to CONTINUE FROM THE EXISTING IMPLEMENTATION, inspect what has already been completed, identify what remains, implement every outstanding capability, integrate all components, test everything, fix discovered problems, and deliver a fully functional production application.

**Your objective is 100% completion of the agreed scope.**

Do not stop after completing one milestone.

Do not stop after writing a plan.

Do not stop because one feature is difficult.

Do not repeatedly ask me for permission to continue implementing requirements already authorized in this directive.

Do not declare features complete merely because their buttons, database tables, UI components, or RPC functions exist.

A feature is complete only when its entire workflow works, its security is verified, and its relevant tests pass.

Work progressively and continuously until the entire application is completed.

# 2. STRICT PROJECT BOUNDARIES

Only work on:

`Hilpolith/COCCE-OFFICE`

Rules:

1. Work exclusively on the existing `main` branch.
2. Do not create feature branches.
3. Do not work on unrelated COCCE repositories.
4. Do not rebuild the application from scratch.
5. Preserve existing working functionality.
6. Preserve existing Supabase schemas, authentication, RLS policies, and data.
7. Do not introduce unnecessary dependencies.
8. Do not disable tests to make CI pass.
9. Do not weaken security to make features work.
10. Do not change Vercel project settings, deployment configuration, domains, or unrelated production applications.
11. Do not modify COCCE Super App wallet transactions or its production wallet implementation.

You may inspect the public COCCE Super App repository strictly as a read-only compatibility reference:

https://github.com/Hilpolith/COCCE_Super_App

All actual implementation work must remain in COCCE-OFFICE.

# 3. ESTABLISHED CURRENT STATUS — START HERE

The following findings were established during previous implementation sessions. Treat them as the starting baseline, not as proof that everything remains unchanged. Verify each item against the live repository, Supabase and latest CI results.

## A. Wallet and cloud storage billing

**Previously implemented and verified:**

- COCCE Office storage plans exist.
- Storage subscription tables and RPC functions exist.
- Storage purchase and renewal operations exist.
- Storage billing configuration in Supabase was confirmed enabled.
- Price approval was recorded.
- Wallet-security approval was recorded.
- The existing purchase RPC checks the latest COCCE wallet balance.
- Insufficient balances are rejected.
- Successful purchases create negative `wallet_transactions.amount` entries.
- The deduction and subscription creation happen within the same database transaction.
- The existing COCCE wallet ledger is used.
- No independent Office wallet or alternative coin system has been introduced.

**Outstanding verification:**

- Complete the Wallet PIN authorization implementation.
- Verify the actual authenticated PIN workflow.
- Verify biometric authorization compatibility where supported.
- Verify purchases and renewals.
- Verify insufficient balance handling.
- Verify duplicate submissions and concurrent purchase protection.
- Verify rollback when any part of a purchase fails.
- Verify that no client can bypass authorization or manipulate the purchase amount.
- Perform a real authenticated end-to-end purchase using an authorized test account, if available.
- Verify the actual wallet balance and ledger afterward.

Do not claim an end-to-end purchase has passed without executing it.

## B. Wallet PIN compatibility reference

The existing COCCE Super App contains the shared coin-spending authorization method:

`_authorizeCoinSpend()`

Its established behaviour:

1. Checks whether biometric authorization is enabled.
2. Otherwise retrieves `profiles.wallet_pin_hash`.
3. Requests the user's four-digit Wallet PIN.
4. Compares the entered PIN against the stored value.
5. Authorizes the spending operation only after successful verification.

Use this implementation as the compatibility reference.

Implement secure server-side PIN verification in COCCE Office.

Requirements:

- Use the existing authenticated user's profile.
- Never expose the stored PIN or PIN hash to the browser.
- Never log entered PINs or hashes.
- Do not store PINs in local storage.
- Do not introduce another PIN system.
- Validate PIN format.
- Use secure comparison and appropriate verification methods compatible with the existing stored format.
- Protect against brute-force attempts with appropriate rate limits and lockout controls.
- Ensure only the authenticated account owner can authorize their spending.
- Ensure failed verification cannot execute a purchase.
- Ensure the same authorization requirements apply to purchases and renewals.

Do not modify the Super App's wallet transactions.

## C. Latest CI findings

The last reported commit pushed to `main` was:

`ee2a0f1`

It corrected two CI test assumptions:

1. An AI test expected an outdated prompt expression.
2. A cloud-storage boundary test matched an explanatory comment instead of an actual wallet operation.

The preceding validation had 163 passing checks and two failures.

The corrected implementation was pushed, but the latest validation result was still pending in the last report.

**Your first action must be to inspect the latest GitHub Actions status and establish the actual current production code state.**

Do not assume `ee2a0f1` is the latest commit. Check `main` and all newer commits.

## D. Existing COCCE Office architecture

Previous implementation work established:

- Supabase authentication and database integration.
- Ten specialist management sectors.
- Existing sector-specific schemas and RLS policies.
- A workspace creation and membership architecture.
- A COCCE Office AI implementation.
- A cloud-storage service.
- A VisionOS-inspired application shell and dock.
- Existing document, spreadsheet, presentation and PDF editor foundations.
- An existing capability roadmap.

Previously reported validation included:

- 1,052 Vitest tests.
- 127/127 test files.
- 238 sector-related tables with RLS enabled.
- Previous successful production TypeScript and Vite builds.

These are historical results. Re-run current validation instead of presenting historical results as current.

# 4. FIRST TASK — COMPLETE REPOSITORY AUDIT

Before changing code, inspect:

1. Current `main` commit and working tree.
2. Latest GitHub Actions runs.
3. `docs/office-capability-roadmap.md`.
4. All ten sector workspace implementations.
5. Authentication and onboarding.
6. Workspace creation and membership.
7. Spaces and Documents.
8. Drive and cloud storage.
9. AI Chat and AI integrations.
10. Database migrations and current Supabase schema.
11. Existing RPC functions.
12. All RLS policies.
13. Wallet and billing implementation.
14. Document editors.
15. Offline and synchronization implementation.
16. Tests and CI configuration.
17. Current production deployment and build status.

Identify which features are:

- Fully implemented and tested.
- Implemented but incompletely tested.
- Partially implemented.
- UI-only.
- Backend-only.
- Missing.
- Broken.

Produce an internal task checklist and immediately begin implementation.

Do not spend the entire session writing another audit.

# 5. PRIORITY ONE — COMPLETE WALLET PIN AND STORAGE BILLING

This is the first implementation milestone.

Complete the full authenticated Wallet PIN workflow.

Implement and test:

- PIN verification.
- Biometric compatibility where supported.
- Purchase authorization.
- Renewal authorization.
- Secure server-side verification.
- Failure handling.
- Rate limiting.
- Atomic wallet deductions.
- Duplicate transaction prevention.
- Balance consistency.
- Subscription creation.
- Subscription renewal.
- Subscription expiration.
- Insufficient balance handling.
- Transaction rollback.
- Purchase history.
- Storage entitlement updates.

Preserve the existing wallet transaction architecture exactly.

**Non-negotiable:** COCCE Office must use the existing COCCE wallet and existing wallet ledger.

COCCE Coin retains its existing value of 1 coin = 1 TZS.

Never create an independent Office wallet.

Never modify the Super App wallet transaction architecture.

Ensure that the amount displayed to users matches the amount actually charged by the server.

# 6. PRIORITY TWO — COMPLETE COCCE CLOUD DRIVE

The cloud storage system must operate as a real cloud drive, not merely a file-upload interface.

Implement and verify:

### File operations

- Upload files.
- Download files.
- Preview supported files.
- Rename files.
- Move files.
- Copy files.
- Delete files.
- Restore deleted files where supported.
- Organize folders.
- Search files.
- Sort and filter.
- Manage file metadata.
- Display storage usage.
- Display available capacity.
- Handle large files.
- Handle interrupted uploads.
- Handle failed downloads.

### Storage plans

Connect the existing storage subscription and billing architecture.

The following previously discussed plans must be verified against the actual pricing configuration:

| Storage | Monthly price |
|---|---:|
| 5 GB | 2,000 TZS |
| 25 GB | 5,000 TZS |
| 100 GB | 12,000 TZS |
| 250 GB | 25,000 TZS |
| 1 TB | 60,000 TZS |
| 2 TB | 100,000 TZS |

Do not overwrite an existing approved pricing configuration without verifying it.

### Bunny.net integration

Preserve secure private storage access.

The intended storage organization is:

`coccesuperapp/cocce-office/`

The existing Office implementation uses `cocce-kyc` and S3-compatible signed uploads, while the Super App uses the standard Bunny Storage API.

Inspect the current configuration and determine the safest migration path.

Requirements:

- Use Bunny.net for Office file storage.
- Preserve private-file access.
- Preserve workspace membership checks.
- Preserve authorization and signed upload/download flows.
- Preserve integrity verification.
- Preserve revision history.
- Keep Bunny credentials in Supabase secrets or an appropriately secured server-side environment.
- Never expose Bunny API credentials in frontend code.
- Never use unrestricted public upload URLs.
- Never weaken RLS or workspace authorization.
- Avoid breaking existing stored files during migration.
- Provide backward compatibility or a safe migration procedure where required.

Do not migrate production storage until the new authenticated service has passed security and regression testing.

# 7. PRIORITY THREE — AUTOMATIC CLOUD SYNCHRONIZATION AND OFFLINE OPERATION

The existing synchronization implementation is partial.

Complete it.

The application should support:

- Automatic synchronization.
- Background synchronization where supported.
- Manual synchronization.
- Offline document editing.
- Local persistence.
- Pending changes.
- Synchronization queues.
- Retry after network failure.
- Conflict detection.
- Conflict resolution.
- Revision history.
- Last synchronized timestamps.
- Upload and download progress.
- Recovery after browser refresh.
- Recovery after application restart.
- Safe handling of concurrent edits.
- Cross-device synchronization.

Do not silently overwrite newer versions of files.

Use reliable synchronization and conflict-resolution logic.

Users should understand whether their work is saved locally, synchronized, or awaiting synchronization.

# 8. PRIORITY FOUR — COMPLETE ALL OFFICE EDITORS

The existing editor foundations must be transformed into fully usable productivity applications.

## A. COCCE Docs

Implement:

- Rich-text editing.
- Formatting.
- Font selection.
- Font sizes.
- Headings.
- Paragraph styles.
- Lists.
- Numbering.
- Alignment.
- Indentation.
- Tables.
- Headers and footers.
- Page breaks.
- Page layouts.
- Margins.
- Links.
- Images.
- Image resizing.
- Image positioning.
- Image insertion from Drive.
- Image insertion from device.
- Drag-and-drop image insertion.
- Undo and redo.
- Autosave.
- Version history.
- Export to PDF.
- Export to DOCX.
- Import supported document formats.
- Printing.

**Image insertion is an explicitly outstanding requirement.**

It must actually work, including saving and reopening documents without losing inserted images.

## B. COCCE Sheets

Implement:

- Spreadsheet grid.
- Cell editing.
- Row and column operations.
- Cell formatting.
- Number formats.
- Formulas.
- Formula evaluation.
- Functions.
- Sorting.
- Filtering.
- Cell references.
- Multiple worksheets.
- Sheet renaming.
- Copy and paste.
- Undo and redo.
- Autosave.
- CSV import/export.
- XLSX import/export.
- PDF export.
- Charts.
- Basic data analysis.

Verify formulas and calculations rather than merely displaying formula strings.

## C. COCCE Slides

Implement:

- Presentation creation.
- Multiple slides.
- Slide layouts.
- Text elements.
- Image elements.
- Shapes.
- Backgrounds.
- Element positioning.
- Resizing.
- Alignment.
- Layer ordering.
- Themes.
- Slide duplication.
- Slide deletion.
- Slide reordering.
- Presentation mode.
- Autosave.
- Import and export.
- PDF export.
- PPTX export.

## D. COCCE PDF

Implement:

- PDF viewing.
- Page navigation.
- Zoom.
- Search.
- Text selection.
- Text annotations where supported.
- Highlighting.
- Comments.
- Page rotation.
- Page reordering.
- Page deletion.
- Page insertion.
- Image insertion.
- Document merging.
- Export and download.
- Secure storage integration.

Do not claim PDF editing is complete if the application only provides a PDF viewer.

# 9. PRIORITY FIVE — COMPLETE THE TEN MANAGEMENT SYSTEMS

COCCE Office must become a comprehensive enterprise productivity platform.

Complete all ten specialist workspaces.

Each system must have functional interfaces, real database operations, appropriate authorization, reporting, analytics, document management and relevant workflows.

## 1. Government and Public Administration

Implement:

- Departments.
- Ministries and administrative units.
- Staff management.
- Citizen records where appropriate.
- Public service workflows.
- Case management.
- Correspondence.
- Official documents.
- Approvals.
- Procurement workflows.
- Budget management.
- Revenue and expenditure tracking.
- Meetings.
- Reports.
- Audit trails.
- Role-based permissions.

## 2. School Management

Implement:

- Student registration.
- Admissions.
- Classes.
- Subjects.
- Teachers.
- Timetables.
- Attendance.
- Examinations.
- Results.
- Grading.
- Fees.
- Payments.
- Parent communication.
- Report cards.
- Academic calendars.
- Discipline records.
- School reports.

## 3. University Management

Implement:

- Student admissions.
- Faculties.
- Departments.
- Programmes.
- Courses.
- Course registration.
- Lecturers.
- Timetables.
- Examinations.
- Results.
- Transcripts.
- Student accounts.
- Fees.
- Scholarships.
- Research administration.
- Graduation.
- Academic reporting.

## 4. Business Management

Implement:

- CRM.
- Customers.
- Suppliers.
- Products.
- Inventory.
- Sales.
- Purchases.
- Orders.
- Invoices.
- Payments.
- Employees.
- Projects.
- Tasks.
- Expenses.
- Profit and loss.
- Business analytics.

## 5. Accounting Management

Implement:

- Chart of accounts.
- General ledger.
- Journal entries.
- Accounts payable.
- Accounts receivable.
- Invoices.
- Receipts.
- Bank reconciliation.
- Cash flow.
- Budgets.
- Financial statements.
- Tax reporting support.
- Audit trails.
- Financial reports.

Use appropriate accounting controls and balanced journal entries.

## 6. Manufacturing Management

Implement:

- Raw materials.
- Inventory.
- Suppliers.
- Bills of materials.
- Production planning.
- Work orders.
- Manufacturing operations.
- Quality control.
- Equipment.
- Maintenance.
- Labour.
- Production costs.
- Finished goods.
- Warehouse operations.
- Production reports.

## 7. Healthcare Management

Implement:

- Patient registration.
- Appointments.
- Clinical workflows.
- Medical records.
- Departments.
- Healthcare personnel.
- Prescriptions.
- Laboratory workflows.
- Billing.
- Insurance records.
- Inventory.
- Pharmacy operations.
- Reporting.
- Access controls.
- Audit trails.

Healthcare data must receive strict privacy and authorization protections.

## 8. NGO Management

Implement:

- Projects.
- Programmes.
- Beneficiaries.
- Donors.
- Donations.
- Grants.
- Budgets.
- Activities.
- Field operations.
- Monitoring and evaluation.
- Impact reporting.
- Procurement.
- Staff and volunteers.
- Compliance reporting.

## 9. Hospitality Management

Implement:

- Reservations.
- Guests.
- Rooms.
- Check-in.
- Check-out.
- Housekeeping.
- Restaurant operations.
- Menus.
- Orders.
- Payments.
- Inventory.
- Staff.
- Events.
- Revenue management.
- Occupancy reporting.

## 10. Institutions Management

Implement a configurable system for institutions that do not fit neatly into the other nine categories.

Support:

- Institutional structures.
- Departments.
- Personnel.
- Membership.
- Assets.
- Operations.
- Workflows.
- Approvals.
- Documents.
- Budgets.
- Reports.
- Permissions.
- Customisable modules.

### Important requirements for all ten sectors

Do not create ten attractive dashboards with nonfunctional buttons.

Every module must connect to real data operations.

Verify:

- Create.
- Read.
- Update.
- Delete where permitted.
- Search.
- Filtering.
- Pagination.
- Validation.
- Permissions.
- RLS.
- Reporting.
- Export.
- Audit history.
- Error handling.

Use the existing schemas wherever possible.

Only create migrations when genuinely necessary.

All migrations must be safe, reversible where practical, and compatible with existing production data.

# 10. PRIORITY SIX — COMPLETE COCCE AI AND AI CHAT

The existing AI implementation must evolve into a workspace-aware enterprise assistant.

Previous work established an `office-ai-chat` Supabase Edge Function with JWT verification and a previously selected OpenRouter model:

`google/gemma-4-31b-it:free`

Verify the current configuration and actual model availability. Do not assume historical configuration remains valid.

Use the existing secure server-side architecture and Supabase secrets.

## AI Chat

Implement a fully functional dedicated AI Chat destination.

It must support:

- New conversations.
- Conversation history.
- Persistent messages.
- Streaming responses where supported.
- Context-aware assistance.
- File attachments.
- Document understanding.
- Document summarization.
- Question answering.
- Conversation search.
- Conversation management.
- Appropriate error handling.

## Workspace-wide intelligence

COCCE AI must be able to access information from all resources the current user is authorized to access.

Integrate:

- Spaces.
- Documents.
- Drive files.
- Teams.
- Workspace members.
- Projects.
- Tasks.
- Sector data.
- Reports.
- Relevant conversations.

Implement permission-aware retrieval.

The AI must never access information from an unauthorized workspace or another user's private files.

## AI document operations

Enable users to ask AI to:

- Create documents.
- Edit documents.
- Summarize documents.
- Generate reports.
- Analyze spreadsheets.
- Generate spreadsheet formulas.
- Create presentations.
- Extract information from PDFs.
- Compare files.
- Search workspace documents.
- Generate meeting summaries.
- Draft correspondence.
- Create tasks from conversations.

AI-generated changes must be reviewable and saved through the existing authorized application workflows.

## AI automations

Implement actual automations, not just chat suggestions.

Support:

- Task creation.
- Workflow execution.
- Document generation.
- Report generation.
- Approval assistance.
- Data analysis.
- Scheduled operations where supported.
- User-authorized actions.
- Execution history.
- Failure reporting.

Never allow AI to bypass normal permissions, approval requirements or wallet authorization.

COCCE AI and AI Chat must be separate, accessible dock destinations.

# 11. PRIORITY SEVEN — GENOFFICE-INSPIRED PRODUCTIVITY EXPERIENCE

Build a cohesive, premium productivity environment inspired by modern office suites.

The target is a complete application experience, not a collection of disconnected pages.

Implement:

- Unified document creation.
- Recent documents.
- Templates.
- Document organization.
- Shared workspaces.
- Team collaboration.
- Comments.
- Notifications.
- Version history.
- Document permissions.
- Sharing controls.
- Import/export.
- Search across the application.
- Unified productivity workflows.

Ensure the ten specialist management systems integrate naturally with the core Office environment.

# 12. PRIORITY EIGHT — COMPLETE THE VISIONOS / LIQUID GLASS INTERFACE

The existing interface needs a consistent, premium redesign.

The visual direction is:

**Apple VisionOS + iOS 26 Liquid Glass + premium enterprise productivity.**

The interface must look sophisticated, modern, lightweight and polished.

Avoid:

- Chalky flat colour backgrounds.
- Generic dashboard templates.
- Excessive gradients.
- Childish designs.
- Excessive buttons.
- Unnecessary square cards.
- Inconsistent spacing.
- Oversized typography.
- Cluttered navigation.

Implement a consistent design system across:

- Authentication.
- Onboarding.
- Workspace selection.
- Workspace creation.
- Dashboards.
- Spaces.
- Documents.
- Drive.
- AI Chat.
- COCCE AI.
- All ten management systems.
- Dialogues.
- Popovers.
- Notifications.
- Toasts.
- Context menus.
- Settings.
- Profile.
- Billing.
- Storage management.

### Visual requirements

- Realistic glass textures.
- Subtle transparency.
- Background blur.
- Layered depth.
- Refined shadows.
- Translucent floating surfaces.
- Premium icons.
- Rounded squircle surfaces.
- Elegant pill navigation.
- Consistent interaction feedback.
- High-quality typography.
- Responsive layouts.
- Smooth transitions.

Use scalable visual assets or appropriately generated glass textures where they improve the result.

Do not simulate glass merely by applying random coloured backgrounds.

### Navigation

Preserve and refine the floating navigation concept.

The dock should provide clear access to:

- Spaces.
- Documents.
- Drive.
- AI Chat.
- COCCE AI.
- Profile.

Keep the interface minimal.

Avoid duplicating destinations unnecessarily.

### Responsiveness

The application must work properly on:

- Android phones.
- iPhones.
- Tablets.
- Laptops.
- Desktop computers.
- Large displays.

Pay particular attention to small-screen layouts.

Do not allow navigation, modals, tables, editors or toolbars to overflow on mobile.

Preserve acceptable performance on low-powered devices.

# 13. AUTHENTICATION AND WORKSPACE SECURITY

Audit and complete:

- Login.
- Registration.
- Password recovery.
- Session persistence.
- Google authentication.
- Authentication callbacks.
- Workspace creation.
- Workspace selection.
- Workspace invitations.
- Membership management.
- Roles and permissions.
- Profile management.
- Session expiration.
- Secure logout.

Google sign-in should return users to COCCE Office rather than unexpectedly opening the installed COCCE Super App on Android.

Preserve the existing `cocce-kyc` setup.

Do not migrate authentication architecture without a verified need.

Verify all security boundaries on both frontend and backend.

# 14. DATABASE AND ARCHITECTURE REQUIREMENTS

Inspect the complete Supabase database.

Verify:

- All migrations.
- All tables.
- All relationships.
- Foreign keys.
- Indexes.
- Functions.
- Triggers.
- RLS policies.
- Storage authorization.
- RPC permissions.
- Authentication requirements.

Previously reported architecture contained 238 sector-related tables with RLS enabled.

Revalidate every relevant table and policy.

Having RLS enabled is not sufficient: verify that the policies actually enforce the correct access boundaries.

Avoid:

- Duplicate tables.
- Duplicate business logic.
- Unnecessary migrations.
- Destructive schema changes.
- Insecure service-role usage.
- Exposed secrets.
- Client-side authorization as the only security mechanism.

Keep the system maintainable and modular.

# 15. TESTING — NO FALSE COMPLETION CLAIMS

Testing is mandatory throughout implementation.

Do not postpone all testing until the end.

After each major implementation:

1. Run relevant unit tests.
2. Run integration tests.
3. Run regression tests.
4. Run TypeScript checks.
5. Run production builds.
6. Run database tests where available.
7. Run security and authorization tests.
8. Fix discovered problems.
9. Repeat failed tests.

At the end, run the complete available CI suite.

### Required test categories

**Wallet**
- Valid PIN.
- Invalid PIN.
- Missing PIN.
- Biometric path.
- Insufficient balance.
- Successful purchase.
- Successful renewal.
- Duplicate purchase.
- Concurrent purchase.
- Failed transaction rollback.
- Unauthorized purchase.

**Storage**
- Upload.
- Download.
- Rename.
- Delete.
- Restore.
- Permissions.
- Workspace isolation.
- Signed URLs.
- Integrity.
- Subscription limits.

**Editors**
- Create.
- Edit.
- Save.
- Reopen.
- Autosave.
- Export.
- Import.
- Images.
- Formulas.
- Presentation rendering.
- PDF operations.

**Management systems**
- CRUD.
- Validation.
- RLS.
- Permissions.
- Reporting.
- Audit history.

**AI**
- Authentication.
- Model availability.
- Streaming.
- Context retrieval.
- Workspace isolation.
- File permissions.
- Tool execution.
- Error handling.
- Persistent history.

**UI**
- Mobile.
- Desktop.
- Tablet.
- Navigation.
- Dialogues.
- Accessibility.
- Loading states.
- Empty states.
- Error states.

Do not delete, skip or weaken existing tests.

Do not use mock data to claim production functionality.

Use isolated test accounts and test workspaces for destructive or financial tests.

# 16. DEPLOYMENT AND PRODUCTION VERIFICATION

Work on the existing production repository and `main` branch.

Check whether Vercel automatically deploys from GitHub.

Do not modify Vercel configuration or unrelated projects.

Before pushing:

- Review the diff.
- Check for accidental secrets.
- Check for unrelated changes.
- Run relevant tests.
- Ensure migrations are safe.
- Verify the build.

After pushing:

- Inspect GitHub Actions.
- Verify deployment status.
- Verify production build.
- Test critical production workflows where safely possible.
- Confirm no existing functionality was broken.

Do not claim deployment succeeded merely because a commit was pushed.

Do not claim production is complete if CI is still running or failing.

# 17. EXECUTION RULES — DO NOT STOP PREMATURELY

These instructions are especially important.

I have already authorized you to complete the entire project.

Therefore:

- Do not ask me whether to continue after each milestone.
- Do not stop after producing an audit.
- Do not stop after implementing Wallet PIN.
- Do not stop after fixing CI.
- Do not stop after implementing document editors.
- Do not stop after implementing one management system.
- Do not stop after making the interface attractive.
- Do not stop after deploying one feature.
- Do not leave known incomplete functionality simply because it is outside the first milestone.

When one milestone is complete, immediately continue to the next.

If a tool or environment limitation prevents one operation, use another available supported method.

If GitHub connectivity fails, retry appropriately and use available GitHub integrations.

If a local build environment is unavailable, establish what can be validated through the available repository, CI, database and deployment tools. Do not pretend unavailable tests passed.

If one feature depends on another, implement the dependency first.

If you discover bugs, fix them.

If a migration is necessary, implement it safely and verify it.

If a feature already exists and works, do not rewrite it unnecessarily.

Preserve existing user data and production functionality.

**Your responsibility is to finish the actual application, not merely report what should be done.**

# 18. PROGRESS REPORTING

Provide concise progress updates approximately every three minutes during extended execution, or at meaningful implementation milestones if the platform cannot send timed updates.

Each update should include:

- What was inspected.
- What was implemented.
- Files or components changed.
- Tests executed.
- Test results.
- Commit hash, if pushed.
- Remaining work.
- Current blockers, if any.

Do not send repetitive messages without meaningful progress.

Maintain one continuously updated completion checklist.

Do not mark a feature complete until implementation and verification are both finished.

# 19. FINAL ACCEPTANCE CRITERIA

COCCE Office will only be considered fully completed when:

1. Wallet PIN authorization works securely.
2. Existing COCCE wallet deductions work correctly.
3. Storage purchases and renewals work end to end.
4. Cloud Drive operations work.
5. Bunny storage integration is secure and verified.
6. Automatic cloud synchronization works.
7. Offline operation works with reliable recovery.
8. Docs is fully usable, including image insertion.
9. Sheets is fully usable, including formulas and export.
10. Slides is fully usable, including presentation and export.
11. PDF editing workflows work.
12. All ten specialist management systems have functional workflows.
13. COCCE AI has permission-aware workspace intelligence.
14. AI Chat works independently.
15. AI automations execute authorized operations.
16. GenOffice-inspired productivity workflows are integrated.
17. VisionOS Liquid Glass is consistently implemented.
18. Authentication and workspace security are verified.
19. Database and RLS security tests pass.
20. Regression tests pass.
21. Production build succeeds.
22. GitHub CI passes.
23. Production deployment is verified.
24. No existing Super App wallet behaviour has been modified.
25. No unrelated COCCE repositories or Vercel projects have been changed.

# 20. BEGIN EXECUTION NOW

Start by inspecting the latest state of:

`https://github.com/Hilpolith/COCCE-OFFICE`

Check the current `main` commit, CI results, roadmap, migrations, Supabase implementation and production state.

Use the previous findings in this directive to avoid repeating completed work.

Then immediately implement the highest-priority outstanding work and continue through every remaining milestone.

I do not want another proposed roadmap.

I want the existing COCCE Office application completed.

**Continue working until all acceptance criteria are satisfied.**

At the end, provide an honest final report containing:

- Final commit hash.
- Complete list of implemented features.
- Database migrations applied.
- Security improvements.
- Wallet PIN verification results.
- Actual storage purchase and renewal test results.
- Editor functionality and test results.
- Status of all ten management systems.
- AI Chat and automation verification.
- UI and responsiveness verification.
- Total tests passed and failed.
- Production build result.
- GitHub Actions result.
- Production deployment URL and verification.
- Any remaining limitations, if genuinely unavoidable.

Do not report 100% completion unless every acceptance criterion has actually been met and verified.

**COCCE OFFICE MUST BE DELIVERED AS A COMPLETE, FUNCTIONAL, SECURE AND PRODUCTION-READY PRODUCT.**

Proceed now.