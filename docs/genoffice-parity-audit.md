# GenOffice-level editor parity audit

This is a product capability and acceptance checklist for COCCE Office. It uses publicly documented GenOffice capabilities as a benchmark, not as source code or a design to copy. COCCE Office remains a web-first, workspace-aware product with its own Liquid Glass visual identity, explicit consent and private cloud controls.

## Release rule

Do not label an editor “GenOffice-level” or “complete” merely because its toolbar looks similar. Each editor must pass its interaction, persistence, file-round-trip, accessibility, responsive, security and regression checks. Mark each capability as **Verified**, **Partial**, **Not implemented**, or **Not applicable** in the capability roadmap. Never claim parity with a capability that has not been tested.

## Shared editor workbench acceptance

- Consistent premium Liquid Glass workbench: editor title and file status, compact ribbon/tool groups, main canvas, contextual AI panel, contextual side panels, and a clear save/recovery status.
- Desktop: ribbon and canvas use available width without clipping; side panels can be resized/collapsed where appropriate; keyboard workflows do not require pointer use.
- Mobile: controls reorganize into reachable, scrollable groups; canvas remains usable at 320px width; no page-level horizontal overflow; dialogs fit the viewport and retain accessible focus.
- Shared behavior: undo/redo, find/search, clear empty states, import/export confirmation and fidelity warnings, recoverable failures, visible progress, accessible labels and keyboard focus.
- Cloud behavior must be explicit and understandable: local draft, explicit cloud copy, or opt-in sync are clearly distinguished. Never imply live collaboration or automatic cloud backup unless verified.
- AI actions are user-triggered, scoped to the current file or explicitly selected context, show a preview/diff before applying, can be rejected, and support undo/rollback. No silent background edits.

## Docs

### Existing verified baseline
Tiptap rich text, heading levels 1–3, common character/paragraph formatting, lists and quotes, local autosave/recovery, bounded DOCX import/export, Markdown/HTML source modes, find/replace, local anchored review comments, selection-based AI tools, image insertion, bounded tables, live word count and optional explicit private cloud copy/opt-in sync.

### Remaining acceptance targets
- Page model: page size, orientation, margins, page breaks, headers/footers, page numbering, print preview and stable pagination.
- Review: tracked insertions/deletions with author/time metadata, accept/reject individual or all changes, compare versions, and one-step rollback. Keep existing comments distinct from tracked changes.
- Structure: richer table controls (alignment, column sizing, repeat header where supported), footnotes/endnotes, hyperlinks, bookmarks, citations and references.
- DOCX fidelity: preserve unsupported OOXML parts when unchanged; fixture-based round-trip tests for styles, section/page setup, images, tables, headers/footers and metadata; clearly warn/refuse any destructive lossy save.
- AI: block/selection-aware edits with before/after diff, preview, apply/reject, snapshot and rollback; document-grounded responses with citations when sources are available.

## Sheets

### Existing verified baseline
Local multi-worksheet workbooks, bounded grid editing, formula engine subset, range selection, clipboard, fill operations, session undo/redo, CSV and bounded single-sheet XLSX interchange, local bar/line charts, explicit cloud copies and opt-in immutable sync.

### Remaining acceptance targets
- Professional cell model: number/date formats, font/fill/borders, alignment, wrap, row heights, column widths, hide/unhide, freeze panes and conditional formatting.
- Formula engine: expanded documented function coverage, correct dependency recalculation, circular-reference detection, error propagation, locale-aware display and robust formula autocomplete.
- Authoring: fill handle, drag-to-fill, multi-range selection, named ranges, data validation and accessible formula bar.
- Analysis: pivot tables and slicers with verified source refresh and filter semantics.
- XLSX fidelity: multi-sheet workbook round trips, styles, dimensions, charts, formulas, named ranges and explicit refusal for unsupported features. Never silently flatten or drop workbook structures.
- AI: typed prompt to structured preview workbook with live formulas and chart objects, validation before apply, and undoable changes.

## Slides

### Existing verified baseline
Local decks, themes, text layouts, notes, add/duplicate/delete/reorder, session undo/redo, local images with alt text, bounded PPTX import/export and explicit cloud copies/opt-in sync.

### Remaining acceptance targets
- Master slides and reusable layouts; theme fonts/colors and placeholders.
- Canvas authoring: text boxes, shapes, lines, tables/charts, alignment/distribution, smart guides, grouping/layers, precise position/size/rotation and image crop.
- Presentation: transitions and animations with reduced-motion handling, presenter notes, keyboard navigation and presentation mode.
- PPTX fidelity: preserve supported media, master/layout/theme relationships, notes, fonts and image crop; fixture-based import/export validation and clear warnings for unsupported parts.
- AI: prompt-to-deck with editable native elements, preview, reorder/edit and rollback.

## PDF

### Existing verified baseline
Local PDF rendering, text-layer selection/search, local annotation sidecars, comments/highlights/underline/strike-through, flattened visual annotated copies, text export and page rotate/extract/reorder/merge/insert operations.

### Remaining acceptance targets
- Direct content editing of existing text and images, preserving fonts and geometry where possible; never simulate a successful edit with an opaque cover-up.
- OCR for scanned pages with confidence/selection review and clear offline/privacy disclosure.
- PDF-to-DOCX/XLSX/PPTX conversion with page/geometry validation and warnings for uncertain layout.
- Forms and fields, annotation objects, safe redaction, signatures and metadata only after independent security and format-preservation review.
- Preserve original bytes and offer a separate output; never overwrite the source without explicit confirmation.

## HTML editor

- Dedicated HTML workspace, separate from Docs source mode, with code/design/preview views.
- Safe local HTML/CSS authoring, responsive viewport preview, accessible element selection, reusable sections and asset management.
- Export one self-contained HTML file when possible; sanitize active content and remote assets before preview/import.
- AI design brief to editable page preview with diffs, explicit apply and rollback.

## Markdown editor

- Dedicated distraction-free Markdown workspace with source and rendered preview, synchronized scroll, heading outline, code blocks, tables, task lists and link/image handling.
- Preserve raw Markdown semantics and front matter where supported; do not round-trip through rich text if that changes source structure.
- Save/export plain .md with deterministic formatting and safe local asset links.
- AI actions operate on selected Markdown blocks and preview a source diff before applying.

## Cross-editor AI and files

- AI available in Docs, Sheets, Slides, PDF, HTML and Markdown with a shared but context-specific interaction model.
- Every generated change is typed, validated, previewable and reversible. Spreadsheet outputs contain formulas, not only pasted values; slide outputs remain editable; document changes preserve unaffected blocks.
- Ask across user-selected files with citations to exact file/section/cell/slide/page, permission checks and explicit context disclosure.
- Private cloud files remain workspace-authorized and integrity-verified. Do not alter the existing `cocce-kyc` private storage arrangement or Super App wallet/transaction logic as part of editor work.

## Verification matrix required for each release

1. Unit tests for new format/model operations and boundary cases.
2. Component tests for every new user interaction, disabled state, error and recovery path.
3. Import/export fixture tests that reopen the produced file and compare supported structures.
4. Security checks for sanitization, file-size limits, workspace membership and AI context scope.
5. Full lint, TypeScript, production build and complete test suite.
6. Desktop and mobile visual QA at wide desktop, tablet and 320px mobile widths.
7. Update `docs/office-capability-roadmap.md` with verified status and remaining limitations.

## Reference

Public GenOffice benchmark: https://genoffice.ai/ and https://github.com/genspark-ai/genoffice/. This checklist is a capability benchmark only; no GenOffice source code or proprietary assets are copied.


## Current-main evidence update — 13 November 2026

### GenOffice references inspected

- [GenOffice official site](https://genoffice.ai/) — product overview and available public interface imagery; imagery was inspected as evidence of the visible editor/workspace composition, not as proof that unseen controls work.
- [GenOffice public GitHub repository and README](https://github.com/genspark-ai/genoffice/) — public feature descriptions used to compare native-format editing, document-aware/reviewable AI, and format/privacy caveats. Restricted source and proprietary assets were not copied or used.

The public materials support a functional benchmark of native editing, reviewable AI, and honest compatibility/privacy disclosures. Public screenshots were inspected where available; no attributable, editor-specific official screenshot was verified for PDF or HTML, so this audit does not assert screenshot-level parity for those workspaces.

### Editor and AI status on the audited tree

The detailed capability and test boundaries remain in the [capability roadmap](./office-capability-roadmap.md). The current implementation is a substantial local-first suite, but not full GenOffice parity:

| Area | Current implementation | Important verified boundary |
|---|---|---|
| Docs | Tiptap rich-text workspace, local recovery, bounded DOCX/Markdown exchange, comments, find/replace, image insertion, page setup and previewable local AI actions. | DOCX is a supported subset; stable pagination, tracked changes, complete fidelity and shared collaboration are not established. |
| Sheets | Local multi-sheet workbooks, tested formula subset, range/clipboard/fill, local charts, and bounded CSV/XLSX exchange. | XLSX is deliberately limited to one visible sheet and 288 cells; broad formatting, pivots and Excel compatibility are absent. |
| Slides | Editable local decks, notes, layouts, image support, undo, and bounded PPTX import/export. | No full master/layout system, shapes/charts/transitions/animation or complete PPTX fidelity. |
| PDF | Local viewer/search, sidecar annotations, selected text marks, page operations and separately confirmed flattened annotated copies. | Not direct content editing, OCR, form editing or secure redaction. |
| HTML | No separate HTML workspace was verified; Docs exposes a sanitized source mode. | The dedicated code/preview workspace and responsive preview controls in this checklist remain unimplemented. |
| Markdown | Markdown source/preview is available through Docs. | No dedicated distraction-free Markdown workspace and full source-preserving editor were verified. |
| AI | Separate workspace-scoped Chat and COCCE AI, persistent conversations, bounded authorized Teams context, consented selected Drive text files, and previewable Docs actions. | Not unrestricted workspace search: sector records and approved sector actions are not retrieved/executed; streaming and autonomous workflows are absent. A successful authenticated real-model response was not verified in this local run. |

### Ten-sector code audit

Each sector has a substantial specialist implementation and local tests, but repository code and synthetic test databases do not prove the production Supabase state. The current audit found these material boundaries:

| Sector | Current code/test evidence | Limitation that prevents a completion claim |
|---|---|---|
| Government | Correspondence and records-management UI, RPC adapters, local SQL and Edge Function tests. | The broader records/connector SQL is still labeled review-only; no production application, provider credentials, dispatch, or archive integration was verified. |
| School | Admissions, classes, attendance, grades, fees, timetable and role-scoped RPCs; disposable SQL suite. | Official integrations, fee payment and message delivery remain manual. The acceptance harness now loads the committed School migration, not a proposal copy. |
| University | Role-scoped admissions, academic, finance, research and reporting workflows; disposable schema and UI tests. | TCU/HESLB and other external submission workflows remain manual; no live session was tested. |
| Business | Server-backed CRM, sales, receivables, procurement, projects, compliance and private-contact workflows; SQL and component tests. | No live Supabase/RPC integration was tested; operational code is not proof of statutory ERP or payment/tax integrations. |
| Accounting | Accounting RPC and SQL acceptance suites cover ledger controls, journals, reconciliation, evidence and reporting. | **Integration blocker:** the committed bootstrap/read RPC shape and supported resources do not match what `AccountingManagementWorkspace` requests and expects. The component tests mock that RPC contract; no live read path was verified. |
| Manufacturing | Server-backed inventory, BOM, production, quality, maintenance, evidence and reporting workflows; local SQL/UI tests. | Evidence storage tests mock cloud calls; production storage and live authorization remain unverified. |
| Healthcare | Clinical and operational panels, private-data gates, encryption and local authorization tests. | Fixed in this update: Diagnostics, Inpatient, Pharmacy and Billing now resolve to their matching operations panels; the 12-panel mapping has regression coverage. Production healthcare permissions and data remain unverified. |
| NGO | Server-backed projects, grants, beneficiaries, budgets, evidence and protected-record workflows; local SQL/UI tests. | **Data-contract blocker:** the read/bootstrap result omits `storage_review_reference` expected by the Security UI, so an existing review reference is not restored after reload. Fix requires a reviewed forward SQL change; none was applied. |
| Hospitality | Reservation/front-desk, guest privacy, operations, finance, food/stock and reporting workflows; local SQL/UI suites. | No live PMS/provider, payment settlement or production authorization test was performed. |
| Institutional | Governance, people, finance, assets, compliance and reporting; local SQL/UI suites. | Filings and regulatory evidence are manual/reference-only; production routing and database state were not exercised. |

All sector SQL suites described above use disposable local databases, and UI/API tests commonly mock Supabase. They validate checked-in logic and tested cases only; they do not prove hosted RLS, deployed grants/RPC bodies, migration history, tenant configuration, or real-user behavior. No Supabase query, migration application/rollback, production-data operation, or deployment was performed for this work.

### Verification evidence for this update

- `pnpm test`: passed; Vitest reports **144/144 test files and 1,230/1,230 tests**. The command also completed the configured Node and disposable PostgreSQL/PGlite security and sector suites with exit status 0, including the committed School migration check.
- `pnpm lint`: completed with **0 errors and 176 warnings**. Warnings remain and are not represented as fixed.
- `pnpm build`: TypeScript and Vite production build passed. The existing large-chunk advisory remains.
- Focused regressions: Docs editor **22/22**; Health Administration workspace **14/14**, including the new exact route mapping for all 12 panel IDs.
