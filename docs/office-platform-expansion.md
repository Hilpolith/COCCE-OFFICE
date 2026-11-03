# COCCE Office platform expansion backlog

## Purpose and status

This document is a **backlog and acceptance plan, not an implementation claim**. COCCE Office should become a modular workplace platform for Tanzanian and eventually East African organisations: government departments, schools, universities, companies, accounting firms, factories, NGOs, hospitals, hotels, churches and other institutions. The objective is useful, auditable business capability—not a larger menu, decorative dashboards, fake buttons, placeholder reports or simulated integrations.

Build **one complete module at a time**. Each module must be researched, designed, implemented, tested and verified against the existing application before the next module starts. A module is not complete until its real workflow, persistence boundary, permissions, failure handling, reports where applicable, accessibility behavior and regression tests pass. This document does not claim that any item below is implemented.

The current verified product remains local-first and bounded. Docs, Sheets, Slides, PDF and personal Drive/Vault files retain their existing local behavior and format restrictions described in the [capability roadmap](office-capability-roadmap.md). Office Teams is server-backed collaboration, but it does not make personal editor files cloud-synced. Nothing in this backlog silently widens those limits.

## Non-negotiable boundaries

- **No dummy UI entries.** Do not add navigation items, cards, dashboards, reports, integrations or AI buttons unless the underlying behavior is ready to be developed and tested as a complete slice. A planned module belongs here, not in the product UI.
- **No premature cloud action.** The first tranche is a local frosted-glass foundation and an accessibility preference. There is no live cloud-storage button, upload action, migration action or cloud-save claim in this tranche.
- **No Bunny action before written approval.** Do not create, upgrade, replicate, alter, configure, test real uploads to, or incur charges for any Bunny Storage Zone or Pull Zone until the owner has approved the exact zone, primary and replica regions, access mode, retention/cleanup design, and expected cost. Do not reuse the existing `cocce-kyc` zone for Office without a separately approved isolation design. The research confirms that `cocce-kyc` is Standard, primary Frankfurt, with no replicas, no connected CDN Pull Zone, and S3 already enabled; that is read-only evidence, not Office authorization.
- **No live credentials by implication.** Cloud code and schema require a reviewed design, a narrowly scoped credential plan, and explicit approval before implementation. Bunny signing credentials and Supabase service-role credentials remain server-side. No real upload, download, migration, replication test or charge is authorized by this backlog.
- **No platform-boundary changes.** Do not change the model/provider, privacy or retention terms, Auth settings, shared database structures, existing shared tables, shared RLS policies, shared Realtime publications or other COCCE applications. New cloud work must use a separately reviewed Office namespace and authorization boundary; it must not alter existing Auth or shared data.
- **Synthetic development is permitted.** Build and test with synthetic organisations, users and records. Permit questions gate any applicable real regulated-data rollout; they do not block synthetic-data development. Do not use real government, student, payroll, health, identity or other sensitive records in development without the relevant approvals.
- **Existing format limits remain.** Do not claim full DOCX, XLSX, PPTX, PDF, Microsoft Office or GenOffice compatibility until independently designed, implemented and tested. Preserve current bounded import/export caps, refusal behavior, local fallbacks, confirmation gates and recovery behavior.
- **No autonomous authority.** AI may draft, extract, classify, explain or suggest. It must not independently approve payments, post official financial records, submit statutory filings, change statutory rules, bypass role separation or alter retention/privacy controls.

## Current tranche: local glass foundation and accessibility

The first deliverable is a small, complete local UI foundation—not a cloud feature and not a broad redesign.

The bounded appearance implementation is recorded in the [capability roadmap](office-capability-roadmap.md#frosted-glass-appearance-foundation): floating shell surfaces, a separately persisted glass/solid preference, accessibility/support fallbacks and the working local-search shortcut. Publication remains subject to full validation and independent review. All cloud and business-module items below remain backlog, not shipped capabilities.

### Frosted-glass foundation backlog

Implement and test reusable surface, panel, modal, toolbar and navigation primitives with a restrained frosted-glass treatment. The treatment must remain readable over supported backgrounds, preserve focus indicators and avoid making text, controls or status information depend on translucency. Define tokens for surface opacity, border, blur, shadow, contrast, spacing and motion rather than styling individual future modules ad hoc.

The foundation must include keyboard navigation, visible focus, reduced-motion behavior, responsive desktop/mobile layouts, loading/error/empty states for existing flows, and contrast checks in both light and dark themes. It must not add unimplemented module cards or pretend that cloud storage, accounting or automation exists. Existing working screens must not be removed or downgraded merely to apply the visual system.

### Solid-surface accessibility preference

Add a real, local-only appearance preference that lets a user choose the accessible **solid-surface mode** instead of frosted/translucent surfaces. The preference must persist locally using the existing appearance-preference boundary, be discoverable in the existing settings surface, work without an account or network, and apply consistently to the new primitives. Solid mode is not a decorative placeholder: it must remove or sufficiently suppress translucency/blur and provide an opaque, clearly bounded surface with equivalent hierarchy and interaction states.

Acceptance for this tranche:

1. Existing tests remain green and component tests cover glass and solid modes, persistence, keyboard focus, reduced motion, responsive behavior and theme changes.
2. Automated or documented checks cover contrast and text legibility for important states, including focus, disabled, error and selected states.
3. Reloading preserves the local preference; signing out, a network failure or an unavailable cloud service cannot erase or require it.
4. No new cloud endpoint, database table, Auth setting, model setting, Bunny configuration or live upload control is introduced.
5. The release notes and capability matrix describe this as a local appearance foundation only.

## Cloud file foundation — later, gated backlog

Cloud files are the first infrastructure module after the local glass tranche, but remain **unimplemented until design and owner gates pass**. The reviewed design should keep Bunny as the object plane and an Office-only metadata/authorization layer for organization/workspace ownership, immutable revisions, MIME, actual size, checksums, manifests, trash/retention state and audit events. The browser must never receive a Bunny storage password or privileged credential.

The planned flow is: authenticated client requests a small upload session; a server endpoint checks organization, role, quota, type and size; the server allocates an immutable random key and short-lived signed operation; the browser transfers directly to the approved Bunny zone; a finalize endpoint verifies actual object size/integrity before making a revision available. Failed and abandoned uploads need controlled cleanup. Do not proxy large files through a Vercel Function: the official [Vercel Functions limits](https://vercel.com/docs/functions/limitations) document a 4.5 MB request/response body limit, with related [payload-too-large guidance](https://vercel.com/docs/errors/function_payload_too_large).

The design review must decide and document: Office-zone isolation; exact primary/replica regions; access mode; retention, trash, legal hold and cleanup; quota and abuse controls; signed-download behavior; integrity and MIME checks; backup/restore and rollback; incident response; cost; and the legal/privacy route for the intended data class. Bunny’s [S3 guide](https://bunny.net/docs/storage/s3.md) and [changelog](https://bunny.net/docs/changelog) are existing research references. The guide’s documented limitations—such as no provider object versioning, ACLs or lifecycle policies—mean Office must not assume those controls exist in Bunny.

Cloud-foundation acceptance, after approval, must cover synthetic cross-tenant isolation and object-ID spoofing; role/session expiry; path/key manipulation; signed-header mismatch and expiry; actual-size/type validation; interrupted, duplicate and abandoned upload/finalize; cleanup; complete media/sidecar recovery; concurrent-edit conflicts; storage failure; retention/hold/trash behavior; independent restore; cross-device access; and audit evidence. Preserve local originals until a verified cloud copy exists. Cloud-storage consent must not imply AI indexing or background analysis consent.

For any real Tanzanian personal-data rollout, separately assess controller/processor duties and registration using the [PDPC registration guidance](https://pdpc.go.tz/services/registration/) and [PDPC homepage](https://pdpc.go.tz/), and assess cross-border transfer using the [PDPC cross-border transfer guidance](https://pdpc.go.tz/services/cross-border-data-transfer-permit/). Frankfurt or another overseas location is not presumed acceptable for every record class. Synthetic development does not require those rollout permits; real regulated-data use does.

## Complete module backlog

The following sequence is a product backlog. A later item must not be represented in the UI as complete while an earlier module lacks its acceptance evidence.

### 1. Documents, Sheets, Slides and Drive

Complete the local productivity suite in bounded increments, then design cloud persistence only through the gated foundation above. Planned scope includes document templates, mail merge, signatures, comments, review/revision history, OCR and document generation; spreadsheet formulas, safe formatting, charts, pivots, validation, financial models and analysis; presentation themes, layouts, charts, speaker notes, presentation mode and export; and Drive folders, search, sharing, previews, recovery, versioning and retention.

Each format increment needs a declared supported subset, fixtures, import/export behavior, refusal cases, size limits and recovery tests. Preserve current local fallback and do not describe a bounded subset as full compatibility.

### 2. Accounting and reconciliation

Build a deterministic double-entry engine: chart of accounts, general and sub-ledgers, journals, contacts, invoices, bills, expenses, receipts, payments, credit notes, cashbook, petty cash, attachments, approvals, recurring transactions, TZS and foreign currency, cost centres, budgets, fixed assets/depreciation, trial balance, general ledger, profit and loss, balance sheet, cash flow, ageing, bank/cash/mobile-money reconciliation, period locks, adjustments/reversals and audit trails. Add CSV adapters before claiming proprietary-format compatibility.

Tanzania-localized workflows must remain configurable and verified: VAT, PAYE, withholding tax, tax certificates, NSSF, PSSSF where applicable, WCF, SDL, EFD/VFD and GePG only where authorized and technically supported. Use the existing official references for [TRA PAYE](https://www.tra.go.tz/page/pay-as-you-earn), [SDL](https://www.tra.go.tz/page/skills-development-levy-sdl), [NSSF contributions](https://www.nssf.go.tz/pages/payment-of-contributions/), [WCF contributions](https://www.wcf.go.tz/pages/contribution), [TRA EFD/VFD suppliers](https://www.tra.go.tz/page/efd-vfd-suppliers) and the [M-Pesa developer portal](https://business.m-pesa.com/developers/). No rate, filing or compliance claim is complete without effective-dated rules, accountant review, official onboarding and tested failure behavior.

Acceptance requires balanced-entry invariants, explainable corrections, role separation, period locks, deterministic reports, fixture reconciliation and recovery tests. AI may propose coding, matching or explanations; an authorized accountant confirms postings.

### 3. HR and payroll

Plan employee records, recruitment, departments, contracts, onboarding/offboarding, attendance, shifts, leave, overtime, benefits, loans, deductions, appraisals, training, self-service, payroll journals, payslips, approval/lock, statutory schedules and payment evidence. Calculations must use effective-dated, jurisdiction-aware rules and explainable gross-to-net results. Validate current PAYE, SDL, NSSF, PSSSF and WCF rules with qualified specialists before production. AI must not set rates, decide employment status, change deductions or submit returns autonomously.

Acceptance requires accountant/payroll specialist fixtures, correction runs, locked-period behavior, access tests for personnel data, audit logs and reconciliation to accounting. Real payroll rollout is subject to applicable privacy and employment approvals; synthetic payroll development is allowed.

### 4. Procurement, inventory and assets

Plan requisition → approval → quotation → comparative evaluation → purchase order → receipt/inspection → supplier bill → payment evidence, including partial/rejected deliveries, warehouses, stock movements, transfers, adjustments, batches/serials, reorder points, valuation, assets, custodians, depreciation, maintenance, disposal and fleet records. Implement maker-checker separation and evidence-linked audit packs.

For public procurement, complement rather than claim to replace mandated NeST processes. Use the official [PPRA NeST modules](https://www.ppra.go.tz/services/taneps) and [2025 Public Procurement Regulations](https://www.mof.go.tz/uploads/documents/en-1758539549-GN%20No.%20261%20OF%202025%20-%20THE%20PUBLIC%20PROCUREMENT%20REGULATIONS%20-%20ENGLISH%20VERSION.pdf) as existing references. No integration is complete without an authorized interface and sandbox evidence.

### 5. Government and institutional records

Plan electronic incoming/outgoing correspondence, official letters, memoranda, circulars, registration/reference numbers, file movement, departmental routing, approvals, meeting minutes/resolutions, classification, archival, budget and expenditure approvals, procurement-plan records, employee administration, asset inspection, fleet/maintenance, complaints/service requests and audit/compliance reporting.

Build compatible workflows and integration boundaries, not an impersonation or replacement of government systems. Records classes, retention, access, holds and auditability must be defined before any real government-record rollout. The existing research references [Tanzania ERMS](https://erms.gov.go.tz/index.html?utm_source=chatgpt.com), [e-Government strategy context](https://ega.go.tz/) where applicable, and [PPRA NeST](https://www.ppra.go.tz/index.php/services/taneps?utm_source=chatgpt.com).

### 6. Schools and universities

Plan configurable education editions rather than a generic screen collection. Schools need admissions, learner/guardian records, classes, subjects, attendance, timetables, assessments, exams, grading, moderated report cards, fees/reconciliation, receipts, teachers and approved parent notices. Universities need applications, registration, courses, lecturers, timetables, examinations, transcripts, graduation, hostels, research administration, industrial training and fees.

Respect [NECTA](https://www.necta.go.tz/), [MoEST systems](https://esmis.moe.go.tz/) and the existing [TERNET OSIS reference](https://www.ternet.or.tz/single-service/online-student-information-system-osis?utm_source=chatgpt.com); do not claim direct integration or regulatory approval without evidence. Child, student and guardian data require stricter access, safeguarding and retention review. Acceptance must include fee-to-receipt-to-balance behavior, timetable conflict checks, grade controls, transcript/report fixtures, role isolation and safeguarding tests.

### 7. Factories and manufacturing

Plan versioned bills of materials, production planning, work orders, reservations/WIP, consumption and scrap, lot/serial traceability, quality holds/releases, finished goods, dispatch, costing, maintenance, downtime and procurement forecasting. These are substantial workflows, not extra buttons. [ERPNext’s work-order documentation](https://docs.frappe.io/erpnext/work-order) is a concept reference and [OSHA WIMS](https://wims.osha.go.tz/services) illustrates a separate regulator workflow.

Acceptance requires material and quantity invariants, traceability, quality hold enforcement, maintenance history, recovery and role tests.

### 8. NGOs, accounting firms, hospitals, hotels and churches

Create configurable editions without duplicating the platform:

- **NGOs and projects:** grants, donors, restricted budgets, beneficiaries, field activities, monitoring/evaluation, advances, allocations, currency dimensions and donor-report reconciliation. Configure from executed grant agreements; use the existing [TRA nonprofit guide](https://www.tra.go.tz/images/uploads/pages/NGO_second_revision_2024.pdf) as a reference.
- **Accounting firms:** multiple client workspaces, ledgers, workpapers, reconciliations, tax workflows, audit files, review/approval and client document requests.
- **Hospitals:** appointments, administrative billing, pharmacy inventory, equipment, staff and tightly controlled health-information access. Clinical use is not implied; real health-data rollout requires separate privacy, security and regulatory review.
- **Hotels:** reservations, rooms, housekeeping, guest records, billing, POS boundaries, inventory, staff and payroll. Payment/POS integrations require their own approved interfaces.
- **Churches and institutions:** membership, contributions, events, departments, accounting and communications.

Each edition requires an independently usable minimum workflow, role matrix, audit evidence, synthetic fixtures and sector-specific rollout gates.

### 9. CRM, projects, communications and analytics

Plan CRM leads/customers, pipelines, quotations, contracts, follow-ups, support and communications; projects/tasks with assignments, deadlines, Kanban/Gantt, budgets, approvals, timesheets and performance; internal chat, announcements, email integration, meetings, calendar/scheduling, shared notes and departmental communications; and analytics with KPIs, financial/operational reports, forecasting and controlled report builders.

No dashboard is complete if it only displays hard-coded or dummy data. Every report must identify its source records, permissions, time zone/currency assumptions, refresh behavior, empty/error state and export limits.

### 10. Controlled automation and AI

Plan a permission-aware workflow engine with event triggers, conditions, schedules, webhooks, approved API integrations, extraction/OCR, AI agents, notifications, approvals, transformations, cross-module actions, run history, retries, error handling, human-in-the-loop review, usage limits and monitoring.

Candidate flows include incoming letter → classification → routing → deadline alert; invoice → extraction → verification → accounting draft → approval; school payment → receipt → balance update → notice; low inventory → requisition → quotation → approval; payroll draft → statutory calculation → review → authorized posting; and meeting recording → transcription → minutes → action items. These are backlog examples, not available automations.

Every automation needs explicit trigger scope, idempotency, authorization, audit events, pause/cancel behavior, retry policy, data minimization and synthetic test fixtures. AI must not bypass financial, privacy, records or approval controls. Do not change the current model/provider, retention/privacy disclosure or authentication boundary as part of this backlog.

## Shared platform acceptance for every future module

Before calling a module complete, provide a reviewed schema and authorization design, real business logic, persistent data behavior appropriate to the approved boundary, role and organization isolation, audit events, validation, error and retry paths, mobile and desktop accessibility, synthetic fixtures, unit/integration/end-to-end tests, database-permission tests where relevant, regression tests for existing features, migration/rollback notes and preview-environment evidence. Test failure and recovery—not just the happy path.

A module must be independently usable before the next module begins. Do not perform destructive tests against production users or records. Do not migrate or delete local originals automatically. Do not announce cloud persistence, statutory compliance, official integration, full format compatibility or real AI availability until the corresponding evidence and approval exist.

## Ordered problem/fix priorities

1. **Visual foundation without regressions:** implement and test glass tokens plus the local solid-surface accessibility preference; do not add fake module UI.
2. **Cloud design and approvals:** review Office-only schema/RLS, storage isolation, region/access/retention/cost choices and scoped server credential plan; keep all Bunny actions disabled until approved.
3. **Cloud files:** build the synthetic-only persistence slice and its recovery/security tests; retain local fallback and current editor format limits.
4. **Core finance:** implement deterministic accounting and reconciliation before tax, fiscal or payment claims.
5. **HR/payroll and procurement:** add verified rules, maker-checker controls and evidence-linked workflows.
6. **Government, education, sector editions:** build one complete edition workflow at a time with jurisdiction, safeguarding and regulated-data gates.
7. **CRM/projects/comms/analytics:** add source-backed workflows and reports, not dashboard placeholders.
8. **Controlled automation:** add human approval, auditability, idempotency and privacy-preserving AI only after the underlying modules are complete.

## Existing official research references

This backlog reuses the official links already cited in the Tanzania roadmap: [Bunny S3 guide](https://bunny.net/docs/storage/s3.md), [Bunny changelog](https://bunny.net/docs/changelog), [Vercel Functions limitations](https://vercel.com/docs/functions/limitations), [Vercel payload-too-large guidance](https://vercel.com/docs/errors/function_payload_too_large), [PDPC registration](https://pdpc.go.tz/services/registration/), [PDPC cross-border transfer](https://pdpc.go.tz/services/cross-border-data-transfer-permit/), [PPRA NeST](https://www.ppra.go.tz/services/taneps), [2025 Procurement Regulations](https://www.mof.go.tz/uploads/documents/en-1758539549-GN%20No.%20261%20OF%202025%20-%20THE%20PUBLIC%20PROCUREMENT%20REGULATIONS%20-%20ENGLISH%20VERSION.pdf), [TRA PAYE](https://www.tra.go.tz/page/pay-as-you-earn), [TRA SDL](https://www.tra.go.tz/page/skills-development-levy-sdl), [NSSF](https://www.nssf.go.tz/pages/payment-of-contributions/), [WCF](https://www.wcf.go.tz/pages/contribution), [TRA EFD/VFD suppliers](https://www.tra.go.tz/page/efd-vfd-suppliers), [M-Pesa developers](https://business.m-pesa.com/developers/), [NECTA](https://www.necta.go.tz/), [MoEST systems](https://esmis.moe.go.tz/), [TRA nonprofit guide](https://www.tra.go.tz/images/uploads/pages/NGO_second_revision_2024.pdf), [ERPNext work orders](https://docs.frappe.io/erpnext/work-order) and [OSHA WIMS](https://wims.osha.go.tz/services).

No code, schema, Auth setting, shared database, model/privacy setting, Bunny configuration, upload, deployment or commit is authorized by this document.
