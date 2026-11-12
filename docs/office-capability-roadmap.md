# COCCE Office capability matrix and roadmap

COCCE Office is a growing local-first productivity suite, not yet a replacement for Microsoft Office or GenOffice. The current modules perform real work, but native-file compatibility, broader editing models, and several AI surfaces remain future work. This roadmap adopts public feature concepts only; no GenOffice source code is used.

## Verified capability matrix

| Area | Status | Working now | Important gaps |
|---|---|---|---|
| Docs | Partial | Browser-local rich text; headings 1–3; paragraph and character formatting; lists/quotes; autosave/recovery; Markdown export; bounded local DOCX import/export for text, lists and simple rectangular tables; local anchored review comments; per-item opt-in private cloud sync with immutable revisions and conflict detection; device PNG/JPEG/WebP image insertion with compression, safe embedded-data sanitization, reopen persistence, Markdown export and bounded width controls; verified private Cloud Drive image download and insertion after integrity checks; selection-based AI actions and preview-before-insert. | No full DOCX fidelity, page layout/print pagination, image upload from Docs into Drive, shared image assets, merged/nested/complex table fidelity, DOCX comments, tracked changes, citations, mail merge, background cloud sync is per-item opt-in (not default autosave); no real-time collaboration. AI generation remains subject to the fixed free endpoint's availability. |
| Sheets | Partial | Local workbooks and worksheets; a bounded visible grid; cell/formula editing; tested local formulas including `IFERROR`, `COUNTIF`, and `SUMIF` (without wildcard criteria); CSV import/export; confirmed local XLSX import/export for one visible 24×12 worksheet with text, finite numbers, booleans, and supported same-sheet formulas; bounded keyboard navigation and Shift+Arrow/Shift-click range selection; local TSV copy/paste; arithmetic-series and relative-reference formula fill; 50-step per-worksheet session undo/redo for cell/formula edits, TSV paste and fills; live numeric quick analysis (count, sum, average, min and max) for the selected range; local persistent bar and line charts created from selected ranges (first column categories, second column numeric values), with source-linked updates, signed values and delete controls; native bar/line chart objects in bounded single-sheet XLSX exports; separate explicit cloud-copy and restore-as-new for bounded snapshots of worksheet names, raw cell values/formulas and active sheet; per-item opt-in immutable cloud sync with conflict detection. | No full XLSX/Excel compatibility, cell formatting, pivot tables, data validation, broad formula compatibility, date/text sequence filling, AI-generated sheets, or chart import from external XLSX files. XLSX import/export remains limited to 288 cells and refuses unsupported workbook content; formatting, dates, hidden/merged layouts, macros and cached formula results are not retained; external chart/drawing packages are refused on import. |
| Slides | Partial | Local decks; three themes; title/body/notes; four text layouts used in editing, presenter, and print; add, duplicate, delete and reorder slides; 50-step active-deck session undo/redo for content, theme, layout, ordering, image references and image descriptions; one local PNG/JPEG/WebP image per slide with alt text, rendered in thumbnails, editor, presenter, and print-to-PDF; bounded IndexedDB storage (2 MB/image, 4096 px maximum side, 16 MP maximum; hard retained cap of 512 files globally, 24 files/24 MB per deck, and 128 MB total; editor preflight cap of 8 distinct active files and 12 MB per deck); local JSON transfer; speaker notes. Image metadata and file bytes use separate IndexedDB stores, while slide references stay in localStorage; removing an image is undoable and retains its bytes until the presentation is deleted. JSON export requires confirmation and omits image bytes and local asset IDs, while preserving image descriptions and an omission marker. Older or unknown layouts fall back to title/content; undo history resets on reload. | No PPTX, master slides, full layout designer, image crop/position controls, vector images, shapes, charts, transitions, animation, per-item opt-in immutable cloud sync with conflict detection; no real-time collaboration or AI-generated decks. Presentation creation, import, and whole-deck deletion are not in the undo stack. Removed/replaced images remain in the presentation's local image store for undo and are cleared when the presentation is deleted. |
| PDF | Partial | Local viewing and selectable text; multi-occurrence search (up to 2,000) with temporary hit overlays, wraparound previous/next navigation, current-hit scroll focus, and explicit clear-search; local selected-text highlights, comments, underlines and strike-throughs; 50-step session undo and confirmed current-page clear; confirmed local JSON annotation backup/restore for byte-identical PDFs; page rotation, extraction, reorder and merge as new copies. Text-mark vectors reproject from normalized page rectangles after resize and rotation. An explicit, confirmation-gated **Create annotated copy** action verifies mark fingerprints against exact local PDF bytes and writes a separate PDF with flattened highlight/underline/strike-through page content; comments, quote text, and notes are excluded, and the original bytes/sidecar stay unchanged. Output is capped at 25 MB, 500 pages, and 10,000 rectangles; marked pages must have verified PDF.js/pdf-lib geometry and in-bounds CropBoxes. | No OCR, direct text/image editing, editable PDF annotation objects for local marks, form creation, signatures, secure redaction or cloud review. Annotation bundles are manual local files, not automatic or cloud backups. Export refuses encrypted/malformed PDFs, unverified legacy marks, non-quarter-turn or inconsistent page geometry, oversized inputs/outputs, and CropBoxes extending outside MediaBox because renderers can disagree. Digital signatures and advanced form behavior may not be preserved. |
| AI | Partial | Separate dock destinations for private AI Chat and workspace-intelligence COCCE AI; persistent workspace-scoped AI conversations; atomic user/assistant exchange persistence; 30-at-a-time paginated conversation list, local title search across loaded pages, reopen, new chat and owner-only hard deletion; RLS/ownership/membership enforcement; relevant Teams message search with membership/read checks and deleted-message exclusion; owner/admin AI switch enforced by the Supabase Edge Function and Docs AI API; per-request confirmation for selected private Drive text context (up to 3 files, 512 KiB each, 20,000 characters total); Docs selection tools, prompt-only drafting, preview/undo and separately confirmed bounded document summaries. Provider key stays server-side. | No PDF/DOCX/XLSX/PPTX extraction into AI, no full-drive indexing, no streaming responses, no autonomous/background workflows, and no paid or alternate-provider fallback. Persistent AI Chat currently requires one selected AI-enabled workspace; all-workspace COCCE AI questions remain temporary. The fixed free endpoint can still be rate-limited. |
| Files and collaboration | Partial | Browser-local Drive/Vault plus a separate private Cloud Drive in authenticated Office workspaces, alongside server-backed Office Teams using existing COCCE accounts. Cloud Drive supports explicit confirmed upload, quota display, 50-file pagination, category filters, integrity-verified download, trash/restore, and in-app image/video/audio/PDF/text/safe-DOCX previews. | Local originals remain browser-local. Cloud Drive stores separate workspace copies, not live-synced originals; active workspace members with access can see those copies. Docs and Sheets also support explicit bounded copy/restore-as-new flows. PDF and Vault remain local-first; Slides now has explicit cloud copies and per-item opt-in immutable sync. There is no live collaborative editing or full native Office-format round trip. |

The initial editor tranche adds local Docs H3/strikethrough, bounded Sheets navigation, presenter-only Slides speaker notes, and bounded multi-occurrence PDF search, alongside responsive toolbars. The DOCX tranche adds local import/export for text, lists, and simple rectangular tables; the Docs table slice adds cell editing, row/column controls, sanitizer and size guards, and local persistence. Unsupported import tables flatten with warnings, and unsupported export tables are refused; this is not a full OOXML round trip. The Sheets tranche adds Shift+Arrow range selection, local TSV clipboard operations that preserve raw formulas, one-dimensional numeric arithmetic-series fill, and bounded local XLSX import/export. XLSX import creates a new workbook only after explicit confirmation and complete ZIP/XML validation; export also requires a fidelity confirmation. The accepted subset is one visible 24×12 worksheet, ordinary text, finite numbers, booleans, and formulas supported by the local engine with same-sheet references. The current formula increment adds lazy `IFERROR` (without masking cycles), plus `COUNTIF` and `SUMIF` with exact or relational criteria, case-insensitive text matching, type-matched relational comparisons (not-equal also matches unlike types), a 256-character cap on evaluated text criteria, a 512-character formula-text cap, a 10,000-cell formula-range cap, and same-shape `SUMIF` ranges; wildcard expansion is unsupported. XLSX includes these calls only when their references remain visible and conditional ranges have compatible shapes. Export uses canonical numeric raw values and uppercase TRUE/FALSE as typed cells; noncanonical numeric/boolean-like text and whitespace-only values are rejected to avoid silent coercion. Unsupported workbooks or cell structures fail before save; the import limits compressed/expanded sizes, ZIP entries, XML parts, populated cells, and text. Formatting, dates, metadata, row/column sizing, print/view settings, and cached formula results are not retained. The Slides tranches add 50-step per-presentation session undo/redo and four per-slide text layouts, with old/invalid layout values falling back to title/content; layout switching preserves text/notes and is rendered by editing, presenter, and print/PDF views. Undo/redo results are saved locally; the history stack itself is not persisted across reloads. PDF follow-ups add transient search-hit overlays and selected-text underline/strike-through marks. The text marks share the normalized local sidecar with highlights/comments, reproject through rotation/resize, and support a 50-step session undo plus confirmed page clear. The new annotated-copy action is separately confirmed and source-hash-bound; it flattens only verified highlights/underlines/strike-throughs into a new local PDF's page content, excludes comment/quote/note text, and never modifies source bytes or the sidecar. Geometry is checked against PDF.js view boxes and pdf-lib MediaBox/CropBox; in-bounds offset crops and 0/90/180/270 rotations have rendered synthetic coverage. Ambiguous out-of-bounds CropBoxes and unsupported geometry are rejected. Output caps are 25 MB, 500 pages, and 10,000 mark rectangles. The local output is visual, not editable PDF annotation data, and may not preserve signatures or advanced form behavior. A separate manual JSON sidecar backup contains annotation text/positions but no PDF bytes or local workspace/file IDs; it requires an exact SHA-256 source match to restore.

## Practical roadmap

1. **Polish and harden the existing local editors.** Continue with accessible toolbar groups, mobile layouts, keyboard paths, import/export limits, save/recovery feedback, and non-destructive operations. Add component tests before expanding control surfaces. This phase must not imply cloud backup or file compatibility.
2. **Add one bounded authoring capability at a time.** Candidate increments: richer Docs table formatting/selection; Sheets safe cell formatting, more tested formulas, formula autofill and AI-generated-sheet previews; Slides master-slide editing, a fuller layout designer, and image crop/position controls; PDF OCR or safe local form editing only after separate format and signature reviews. Define schema and round-trip behavior before each feature.
3. **Expand user-controlled AI across editors.** Build prompt-to-sheet and prompt-to-slide as typed-prompt-only flows with a validated structured preview and explicit apply step; consider PDF actions only on text the user selects. Reuse the existing fixed free endpoint, retain the 55-day/no-training disclosure, and keep failure retryable—never silently switch to paid or alternate models. The current upstream rate limit blocks verification of successful generation.
4. **Extend native formats cautiously.** Docs handles only a bounded local DOCX subset, and Sheets now handles a bounded one-visible-sheet XLSX subset. Full DOCX fidelity and full XLSX/PPTX compatibility, cloud files, shared annotations, version history, OCR, signatures, and real-time editing need independent format/security reviews, compatibility fixtures, authorization design, retention rules, and owner approval before implementation or claims of support.

The Docs review-comments tranche adds a versioned localStorage sidecar scoped by workspace and document, capped at 200 comments per document, 2,000 records and 2 MB total. Quotes are limited to 1,000 characters and notes to 2,000. Open comments highlight only when the text at their mapped ProseMirror range still exactly matches the saved quote; changed passages remain saved but unhighlighted as orphaned comments. Resolve/reopen/delete stay local, and confirmed local document deletion cleans only that document's comment scope. Comment data is excluded from rich text, DOCX/Markdown exports, and AI requests. This is not OOXML comments, shared review, or tracked changes.

## Reference points

- [GenOffice public README](https://github.com/genspark-ai/genoffice/blob/main/README.md) and [public product overview](https://genoffice.ai/) describe native document formats, reviewable AI changes, richer spreadsheets and decks, and PDF tools. These are concept references only; restricted `ee/` code was not inspected or copied for this implementation.
- [Microsoft Word web-versus-desktop comparison](https://support.microsoft.com/en-us/word/word-features-comparison-word-for-the-web-vs-desktop) shows that even Word’s web and desktop feature sets differ materially.
- [Microsoft Excel function reference](https://support.microsoft.com/en-us/excel/excel-functions-by-category) illustrates the breadth and version-specific nature of spreadsheet formula compatibility.
- [Microsoft PowerPoint platform comparison](https://support.microsoft.com/en-us/powerpoint/compare-powerpoint-features-on-different-platforms) documents platform-dependent slide, media and presenter capabilities.
- [Adobe Acrobat PDF editing overview](https://www.adobe.com/acrobat/features/modify-pdfs.html) is a practical benchmark for PDF content editing, OCR, annotations and page operations.

This matrix describes verified capability boundaries, not a claim of feature parity. New controls should appear only when the underlying behavior, tests and data boundary are ready.


## Docs table range selection update

The table-selection portion of roadmap item 2 is now implemented: users can select the active row, active column, or whole simple table and apply the existing bold, italic, underline, or strikethrough tools across its cells. The selection count is announced in the toolbar; the selection itself is temporary. Formatting stays within the current sanitized table markup, uses the ordinary local undo/save path, leaves review-comment sidecars unchanged, and does not widen the DOCX table schema. Component tests cover all three selection scopes, multi-cell marks, undo/redo, local patching, comment-sidecar stability, and export markup; DOCX fixtures cover supported inline-mark round trips. The next Docs table work should address only one additional format at a time—such as alignment or column sizing—after defining safe sanitizer and DOCX round-trip behavior. Cell shading, merged/nested cells, full Word fidelity, and cloud collaboration remain out of scope.


Cell-range selection is formatting-only: it does not authorize an excerpt AI request or a selected-text review comment. Prompt-only drafts remain prompt-only, and table text is included in AI only by the separately confirmed full-document summary action. Preview insertion is blocked while a cell range is still selected.


## Docs local Find & Replace update

A local Find & Replace panel now searches ProseMirror text runs with optional case sensitivity, wraparound previous/next navigation, current-match replacement, and explicitly confirmed Replace All. It is bounded to 128-character queries, 1,000-character replacement text, 200,000 document text characters, and 2,000 matches. The search includes individual table-cell text but does not join text across marks, paragraphs, or cells, and it excludes local review-comment sidecars. Replacements enter as plain text with the replaced range's inline marks preserved, are prevalidated for staleness/overlap/size, and apply through one undoable transaction; local autosave/recovery remains in place. Tests cover limits, literal/case behavior, table text, mark preservation, count confirmation/cancellation, undo/redo, comment orphan/re-attachment, failed-save retry state, and no network calls. This increment does not add tracked changes, DOCX comments, advanced table formatting, page layout, or Word/GenOffice parity.
Additional safety: every replacement range must match exactly one current text node and its unchanged mark set; crafted or stale cross-run/block/cell ranges are refused before mutation. Switching the active document clears search and replacement state, with a source-document guard preventing stale-position selection. Regression tests exercise these cases in addition to ordinary search and replacement flows.


## Sheets formula-fill update

A user-triggered **Fill formula** action now copies the formula in the first (top/left) cell through one selected row or column within the visible 24×12 grid, with a 24-cell operation cap. Relative A1 references translate by the destination offset; mixed and absolute `$` anchors are respected, and A1-looking text inside quoted strings is not rewritten. Cross-sheet/external references, unsupported or malformed local syntax, out-of-grid source or translated references, and formulas over 512 characters are refused before saving. The UI asks before overwriting populated targets, skips no-op results, and applies validated results in one local worksheet update using the existing storage-failure behavior. Synthetic tests cover relative/range/mixed/absolute references, escaped formula strings, boundary and malformed cases, all-target validation, overwrite/cancel/failure behavior, local persistence, and generated-formula XLSX round-trip. The XLSX parser/exporter and supported formula set are unchanged. The later session-history tranche below covers this action as one undoable worksheet edit. Full Excel formula compatibility, two-dimensional autofill, formatting, date/text series, and cloud data remain unsupported.

## Sheets session Undo/Redo update

Sheets now offers real local Undo and Redo for cell-content edits: individual grid/formula-bar edits, rectangular TSV paste, numeric-series fill, and formula fill. The per-worksheet in-memory history is capped at 50 accepted steps; same-cell typing coalesces within 750 ms. Each edit and restoration uses the existing atomic local-save callback, and a failed save does not advance history or alter the stored copy. No-op edits do not create entries or discard redo; a new accepted edit after undo branches the history. Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl/Cmd+Y work outside text inputs and contenteditable fields. History is not persisted and resets on reload or leaving the workbook editor, while switching worksheets in the same visit retains each sheet's stack. Workbook/worksheet name and structure changes plus imports/exports remain outside the stack. The existing one-visible-sheet XLSX subset and formula semantics are unchanged; this does not provide full Excel Undo or workbook-wide history.


## Docs semantic table-header update

The Docs table toolbar now toggles the first row between semantic header cells and ordinary cells, with active state and accessible action labels. The change uses the existing Tiptap table schema and normal local undo/autosave path; text, inline marks, and review-comment sidecars remain unchanged. The supported DOCX subset already round-trips this distinction through Word's header-row property, now covered for both headered and headerless synthetic tables. Header status no longer adds bold formatting to plain or italic header cells; regression tests verify that source inline marks remain intact. Since Markdown pipe tables require a header row, exporting any headerless table prompts before treating its first row as a header; cancellation exports nothing and changes no document data. No sanitizer attributes or remote behavior were added. Cell alignment, column sizing, shading, merged/nested tables, and full Word/GenOffice parity remain out of scope.

## PDF annotation backup/restore update

A separately confirmed **Export backup** downloads a browser-local JSON sidecar with every supported annotation for the open PDF, including selected-text quotes, normalized page positions, comment text, every stored note field (including notes on visual marks), timestamps, and source SHA-256. It contains no PDF bytes, workspace ID, local file ID, or session undo history. Because quote and note text can be sensitive, the confirmation says what the JSON contains; ordinary original downloads and page-operation copies still do not include annotations, and the flattened annotated-copy path still excludes comments and note text.

A local **Import backup** accepts only the version-1 COCCE PDF annotation JSON format (maximum 5 MB and 2,000 entries, also subject to the browser-wide 2,000-record sidecar cap), validates every field and position, and re-reads/re-hashes the locally stored PDF before changing the sidecar. It requires both the viewer’s open PDF and the current local file bytes to match the bundle fingerprint exactly; it never rebinds marks to a different PDF. Imported rows are assigned the currently selected local workspace/file scope. IDs are compared within the selected PDF scope: identical rows are idempotent, a different payload under an existing selected-PDF ID aborts instead of overwriting, and same IDs on other local PDFs are unaffected. The single localStorage write is atomic, uses the existing PDF annotation undo stack as one session action, and leaves the source file unchanged. Invalid rows, unknown fields/versions, unsupported metadata, out-of-range pages, storage quota failures, and source mismatches are surfaced without silently dropping data. Legacy annotations without an exact source fingerprint block backup rather than being omitted. This is a manual browser-local transfer/backup mechanism—not cloud sync or an automatic backup guarantee.


## PDF page-copy preflight update

Rotate, extract, reorder, and merge now create a separate browser-local PDF copy only after an explicit confirmation. The prompt warns that signatures can become invalid and forms, embedded PDF features, bookmarks, attachments, or metadata may not be preserved; Office annotation sidecars are not copied. The original files and sidecars remain unchanged, and nothing is uploaded. The workspace re-reads selected local files, checks Drive metadata and file sizes, hashes the currently open PDF against its displayed source fingerprint, and re-hashes each selected source before saving the output. Missing, stale, or changed sources abort before a new file is saved.

Page-copy inputs and outputs are capped at 25 MiB each; single-document operations and merged output are capped at 500 pages. Merging accepts at most 8 files, 50 MiB combined source bytes, and 500 total pages. Encrypted, malformed, over-limit, or unsupported PDFs fail closed, and oversized serialized output is refused before local Drive storage. This is a bounded copy workflow, not full PDF feature preservation or in-place editing; users should inspect outputs before relying on interactive fields or signed content.

## Frosted-glass appearance foundation
The application shell now uses a floating, frosted-glass design layer with shared surface, reflection, border, shadow and spacing tokens. Preferences includes real **Frosted glass** and **Solid surfaces** choices, persisted separately under a bounded, versioned appearance-only browser key; selecting a surface never writes document state or makes a network request. Failed writes retain the previously saved choice and show an error. Unreadable appearance data is left untouched and defaults to glass; blocked browser storage is reported rather than represented as a successful save. The existing six color themes and custom accent control remain available, while common primary actions use a fixed high-contrast foreground/background pair rather than white text on arbitrary light accents.
The screen-only layer includes explicit opaque fallbacks for unsupported backdrop filtering, operating-system reduced-transparency/increased-contrast preferences, and forced colors. The manual solid option remains available where the reduced-transparency media query is not supported. Existing application-owned blur surfaces, including lazy-loaded Team/Docs panels and modal backdrops, use the same controlled tokens. Rich-document pages remain opaque and unblurred, and slide content, PDF coordinate layers and print rules keep their owning render paths. Existing reduced-motion behavior is retained. Ctrl/Cmd+K now focuses the existing local search control outside editable inputs/content, without overriding an already-handled shortcut.
Regression coverage includes preference limits, malformed data preservation, blocked storage/getter and quota failures, reload, document-state isolation, no network calls, theme/accent preservation, keyboard and mobile navigation, CSS fallback coverage, numerical representative contrast checks, reduced-motion dependency, responsive contracts and print isolation. This is a local visual/accessibility foundation, not a cloud-save, accounting, payroll or new automation module. See the [platform expansion backlog and approval gates](office-platform-expansion.md) for the staged broader programme.
Browser implementation references: [MDN backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter) and [MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency), whose limited availability is why a manual solid preference is also provided.


## Industry workbench local-preview tranche — 2026-11-05

The sidebar now groups Docs, Sheets, Slides, PDF, Drive and Vault under one expandable **Documents** entry and lists ten industry destinations separately under **Office suites**. Selecting an industry opens a shared local workbench with a sector-specific office profile, work-item label and stage sequence, bounded search, optional reference/owner/date/note fields, local stage history and an optional hand-off to the existing server-backed Office Team creation flow. A linked team ID is stored next to the local office record; the register and its work items are not shared with team members.

The industry register is a bounded, versioned localStorage prototype with validation and non-destructive handling of unreadable/newer data. It is not encrypted or backed up, has no record-level permissions, shared task sync, cross-device persistence, approval/audit service, reminders, reporting or server storage. It must not be used for personal, student/guardian, patient, payroll, client financial, beneficiary, donor, payment, or confidential government records. The preview is not a completed school, university, accounting, manufacturing, healthcare, government, NGO, hospitality, church or business suite, and does not provide statutory calculations or external integrations. Those remain in the [platform expansion backlog](office-platform-expansion.md) and require one end-to-end module at a time with the listed security, privacy, regulatory and acceptance gates.


## 2026-11-09 follow-up implementation

The current main branch adds the following work on top of the ten-sector foundation:

- COCCE AI now accepts one workspace or an all-workspaces scope. Every workspace is revalidated against the signed-in user's membership, and the Edge Function checks the persisted per-workspace AI switch before using it. Disabled workspaces are excluded; if the selected scope has no AI-enabled workspace, the request is rejected. Teams context first searches relevant messages across up to 20 enabled workspaces through office_search_ai_messages; the SQL function checks active membership and conversation read access and excludes deleted messages. If there are no matches, the Edge Function samples recent rich messages and filters deleted messages. Context remains bounded to 24 excerpts. Users can turn conversation context off; owners/admins can disable AI entirely per workspace.
- The ten shared industry-suite views expose a contextual COCCE AI action. It opens the separate AI destination with the linked workspace selected and a sector-specific prompt. Chat AI can use authorised Teams excerpts and explicitly selected Drive text files after per-request consent; it does not read sector registers, protected records, unselected files or unsupported binary formats.
- Office workspace membership now supports optional free-text job positions (up to 80 characters), carried from invitations into accepted membership. Owners/admins can edit positions separately from permission roles. Permission checks are server-side and the new metadata RPCs are not executable by the anonymous role.
- Team & Collaboration allows creating additional server-backed Office workspaces and switching among workspaces the user owns or has joined.
- Drive now presents browser-local files separately from private workspace Cloud Drive. Both have file-type filters. Cloud Drive supports membership-scoped listing, quota display, explicit upload confirmation, upload recovery, integrity-verified downloads, image/video/audio/PDF/text previews, safe sandboxed DOCX preview (5 MiB import cap), 50-file pagination, and trash/restore. Other unsupported Office formats can be downloaded but do not yet have a rendered in-app preview. Local files are never uploaded automatically.
- The Google OAuth redirect is explicitly pinned to the COCCE Office origin for production and the active Vercel preview origin for preview builds. The auth panel uses the COCCE Office app mark.

The new custom image-generation step remains intentionally deferred. In the meantime, the existing `cocce-light-frosted-ambient.webp` asset is reused as a subtle, responsive ambient texture beneath the VisionOS glass surfaces; this is a temporary reuse, not a newly generated asset. Production Vercel deployment and full test/build verification remain release gates; code pushed to main is not considered production-ready until a new deployment reaches READY and the build/test suite passes.


### Follow-on refinements — 2026-11-09

- Cloud Drive now pages through large workspaces in 50-file batches rather than silently limiting the visible library to the first page. Trash listing is independent of the currently selected file-type filter.
- Cloud Drive adds a sandboxed, script-disabled DOCX reading preview using the existing bounded local DOCX importer. It is capped at 5 MiB, strips unsupported content through the established sanitizer, and surfaces import warnings. The verified original remains downloadable; larger or unsupported Office formats remain download-only.
- Docs' formatting ribbon now includes inline code, code blocks, and clear-formatting actions while keeping heading levels aligned with the existing safe HTML/DOCX interchange contract. It does not claim full Microsoft Word parity.
- The Office AI Edge Function now accepts only the production Office origin, localhost development, and the exact linked Vercel team deployment hostname pattern. JWT and workspace membership checks remain mandatory; CORS is not treated as authentication.
- The workspace AI function was redeployed with JWT verification still enabled. The connected production project environment confirms the public COCCE Auth configuration, Office schema gate, and server-only OpenRouter key are present; secret values were not read.


## 2026-11-09 continuation verification

The follow-up implementation has now been validated from a clean shallow clone of the public `main` branch in an isolated Vercel sandbox:

- `pnpm install --frozen-lockfile` completed successfully.
- `pnpm build` completed successfully (`tsc -b` and Vite production build). Vite still reports the existing large PDF worker/chunk advisory; this is a performance warning, not a build failure.
- `PG_BINDIR=/usr/lib/postgresql/18/bin pnpm test` completed with exit code 0. This runs the Vitest suite and the repository's SQL-backed sector regression suites. PostgreSQL 18 was used because the sandbox image did not include the PostgreSQL 16 binaries hard-coded as the local script default; the SQL validation itself completed successfully.
- `pnpm lint` completed with exit code 0. Oxlint reports warnings (including existing intentional control-character validation regexes and React effect warnings); there are no lint errors.
- The Cloud Drive component test suite passed, including membership-scoped listing, explicit upload confirmation, finalisation and preview checks. The existing PDF workspace test was made asynchronous-safe by waiting for the viewer's search field to reappear after a workspace switch.
- The Office chat polling interval type and optional cloud attachment file-ID handling were corrected so TypeScript can build cleanly.

The `office-ai-chat` Edge Function was subsequently redeployed and is ACTIVE at version 9 in the existing COCCE Supabase project, with JWT verification enabled. Its deployed code checks membership through the authenticated RPCs, honours the per-workspace AI enable/disable setting, samples at most 20 authorised workspaces, and never treats client-supplied conversation IDs or file contents as trusted context. Selected Drive file IDs are resolved through the authenticated `office-cloud-files` function; file bytes are fetched server-side from a validated Bunny origin and limited to small UTF-8 text formats. `office-cloud-files` is ACTIVE version 8 with JWT verification. The AI context opt-out is available in the UI.

The production alias `https://cocce-office.vercel.app` was checked and returned HTTP 200 with the COCCE Office HTML title. This confirms the currently aliased site responds; it does **not** mean the new source has been deployed.

A new production deployment was requested but Vercel rejected the deployment API call with HTTP 402, `api-deployments-free-per-day`: more than 100 deployment API calls have been made for the team and Vercel instructed waiting 24 hours. The mapped Vercel CLI fallback was not available in the sandbox (no Vercel CLI executable or Vercel credentials were present). Therefore the latest `main` source is pushed and verified by clean build/tests, but production deployment remains blocked by the Vercel team deployment limit. Do not mark this release READY until a deployment of the current main commit is created and reaches READY.


### Verification scope after the previous clean run

The clean install/build/test/lint results above are a verification snapshot from an earlier main-branch revision. Subsequent commits added workspace-scoped Docs AI authorization (including server-side membership and AI-switch checks), explicit private Drive text-file context with server-side file retrieval, concurrent AI-setting checks, DOCX in-app preview and pagination tests, and the main-branch GitHub Actions workflow. Those later changes have not yet received a fresh full test/build run. The Vercel production alias remains on the earlier READY deployment; the current source is not production-released.


### Latest source and deployment state — 2026-11-09 11:16 UTC

The AI/Drive integration has advanced beyond the earlier verification snapshot:

- Selected Drive file context is implemented in COCCE AI. The browser submits up to three file IDs; the Edge Function resolves each with the caller's JWT, verifies the returned workspace is in the user's enabled AI scope, restricts downloads to the expected Bunny origin and workspace/file/revision path, bounds the bytes, and accepts only small UTF-8 text files. The helper has six focused tests covering authorised reads, cross-workspace denial, file type/size, URL pinning, size/UTF-8 checks, and context caps.
- The AI workspace offers a Drive picker, caps selected files at three, and lists only files in AI-enabled workspaces. Conversation history can still be disabled separately; explicitly selected files remain attached until deselected.
- Supabase `office-ai-chat` is ACTIVE at version 16 and `office-cloud-files` is ACTIVE at version 8; both retain JWT verification. Production Office collaboration and Cloud Drive feature flags are enabled.
- The Cloud Drive Vercel-preview CORS preflight mismatch was corrected in source and deployed to `office-cloud-files` v6.
- Focused tests for the Drive context helper and AI workspace passed (10/10), and a production TypeScript/Vite build passed at the immediately preceding main revision. A later full test run found one Cloud Drive OPTIONS preflight test failure; the source correction is now applied, and a GitHub Actions run for current main commit `22b766fe12d871cb8e5036220bfbf9542532e008` was pending. Do not call the current main branch fully green until that run completes successfully.
- Vercel production deployment remains blocked by the team's HTTP 402 `api-deployments-free-per-day` quota. The live alias still returns HTTP 200, but serves the prior READY deployment; the current source has not been production-released.

The latest full local test run could not be repeated after the isolated Vercel sandbox session stopped. The GitHub Actions run is the authoritative current-main verification path. After it passes, create a production deployment when Vercel's 24-hour quota window permits and verify READY plus the live alias.


## Latest integrity and CI checkpoint — 2026-11-09 11:19 UTC

The private Cloud Drive link response now includes the stored SHA-256 digest from the verified revision. COCCE AI compares the server-fetched Bunny bytes against that digest before decoding or adding any excerpt to model context. The Cloud Drive Edge Function is ACTIVE at version 8 and COCCE AI is ACTIVE at version 16; both still require JWT verification. The Drive-context test suite now covers the SHA-256 match and mismatch paths.

GitHub Actions run `42607472160` completed successfully for an earlier main revision and executed both the full test command and production build. The latest main commit `f3c29c2d0ef353c980aa75012d686cb101382e60` has its own full validation run queued as `42608122219`; wait for that run to complete before treating the latest SHA as fully verified. Vercel production deployment remains blocked by the team's HTTP 402 `api-deployments-free-per-day` limit.



### Current release gate (2026-11-09)

- Latest application-code HEAD before this docs-only release-gate update: `2eeb06a2ae4f115912af51c5949c6c8370f97bb9`.
- Latest READY Vercel production deployment still points to `5c2e662a3cfcd7a5ebca45b19de4a821ae3a654c`; it is not the current main HEAD. The current production alias has not been verified against the new AI/Drive work.
- The latest Vercel build error in the deployment history was for an earlier test revision; the subsequent source changes addressed that reported test failure, but no newer production deployment has completed.
- The main-branch GitHub Actions workflow is present, but no workflow run is visible for the latest commits.
- Vercel deployment creation returned HTTP 402 for the daily deployment quota. A separate Vercel sandbox attempt returned HTTP 402 because sandbox snapshot storage is at its plan limit until 2026-12-01. No snapshots were deleted and no plan or billing settings were changed.
- Supabase migrations and the two Edge Functions are deployed independently: `office-ai-chat` version 16 and `office-cloud-files` version 8, both ACTIVE with JWT verification. The latest main-branch frontend/API changes still need a clean full test/build and a READY production deployment.


### Follow-on AI and chat hardening — 2026-11-09

- The dedicated AI workspace now asks for explicit consent on every request that includes selected Drive file IDs. The dialog identifies OpenRouter's Google AI Studio free-model provider, the selected files, and the fact that this is not a zero-data-retention guarantee. Cancelling sends no file context.
- The existing office_search_ai_messages RPC is now used by the Edge Function for relevance-ranked Teams context. The source migration 20261109104406_office_ai_message_search.sql was restored to GitHub because the migration was already recorded in the shared database but missing from the repository; it was not applied a second time.
- If full-text search returns no matches, COCCE AI uses recent membership-checked rich messages and explicitly filters deleted_at rows. The prompt context is bounded to 24 excerpts across the selected workspace scope.
- Office Chats now renders safe inline image, video and audio previews from verified Bunny Cloud Drive downloads. Audio waveform bars are derived locally when the browser can decode the recording; temporary object URLs are cleaned up on preview close, conversation switch and unmount.
- office-ai-chat is ACTIVE version 17 with JWT verification. Its free model/provider routing and zero-cost response checks remain pinned. The latest full CI and Vercel exact-commit production checks remain release gates.


## Latest sector acceptance and production release — 2026-11-09

This checkpoint supersedes the earlier pending-CI and Vercel deployment-quota notes in the historical entries above.

- Full GitHub Actions run `42647820453` passed for main commit `311ef82dd30a1770c0893037c91b5f53b71ec39e`.
- Vitest: 132/132 files, 1,105 passed, 1 skipped.
- Node acceptance scripts: 163 passed.
- Hospitality: 46 passed; Institutions: 38 passed; Institutions PostgreSQL schema/RLS/grants: 38 passed; Government PostgreSQL acceptance: 11 passed.
- University and Business PostgreSQL schema/workflow validators passed. Business acceptance covers 40 distinct command workflows and 27 paginated read resources.
- TypeScript and Vite production build passed.
- School now has bounded server-side offset pagination and load-more controls for admissions, learners, attendance, assessments, fees and notices. Its nine-test SQL acceptance harness covers stable page boundaries and invalid offset rejection.
- Workspace-switching, account-change cleanup, revoked-membership cleanup, cross-workspace isolation, AI permission/context settings, Drive list/preview/upload behavior and Docs AI consent regressions pass.

### Production release

The READY production deployment is `dpl_HLGwsrg2FoYe7ewHTbVtr3dyT1cC`, source commit `b003490af1f4c2efa93fe40c4099c2cc5ec9ddbb`, serving `https://cocce-office.vercel.app`. Validated main commit `311ef82` is its direct child and changes only a case-insensitive SQL ACL assertion in an acceptance script; application source is identical. Production HTML, JS and CSS returned HTTP 200, and the last-hour runtime-error query returned no errors.

The main application chunk is approximately 949.92 kB (267.21 kB gzip), versus the earlier 1,711.81 kB (451.92 kB gzip) baseline. The ten specialist workspaces remain lazy-loaded. Separate Docs/PDF chunks still produce a Vite size warning; the production build itself succeeds.

### Security and release boundaries

A read-only production catalog check found 257 Office tables with RLS enabled, zero anonymous table SELECT/write grants, and zero anonymous execution grants across 120 Office RPC functions. All 108 security-definer Office functions inspected have an empty pinned search path. The School offset-pagination migration is recorded as already applied in production.

Monthly Cloud Drive storage subscriptions remain disabled: the billing migration is not applied to production and the Vercel approval flag is absent. Do not enable wallet deductions until the owner explicitly approves the commercial pricing and terms.

The sector-management acceptance chain is green, but this does not mean full Microsoft Office/GenOffice feature parity or statutory/regulatory certification. Existing local editor compatibility limits and the remaining roadmap items above remain in force.


---

## 2026-11-12 — wallet lockout, billing and deployment checkpoint

This checkpoint supersedes earlier statements in this document that monthly Cloud Drive billing is disabled. A read-only query of the connected production database on 2026-11-12 found:

- `office_cloud_storage_billing_config.enabled = true`, with both price approval and wallet-security approval timestamps present.
- All six active monthly plans match the approved price schedule: 5 GB / 2,000 coins; 25 GB / 5,000; 100 GB / 12,000; 250 GB / 25,000; 1 TB / 60,000; 2 TB / 100,000.
- This confirms billing is enabled in production configuration. It does not prove a successful authenticated user purchase or renewal; no real wallet debit was executed during this checkpoint.

### Wallet PIN lockout implementation

- Added `office_cloud_wallet_pin_attempts`, a durable per-user attempt table with a 15-minute window and lockout after five attempts.
- Added `office_cloud_wallet_pin_attempt(uuid, boolean)`, serialized with a per-user transaction advisory lock. Only the service role can execute it.
- RLS is enabled on the attempt table; anonymous and authenticated roles have no table SELECT access. Anonymous and authenticated roles cannot execute the lockout RPC.
- The `office-cloud-files` Edge Function now reserves an attempt before reading the existing wallet PIN, returns HTTP 429 while locked, and clears the attempt state after a successful PIN verification. Purchase and renewal still use the existing COCCE wallet RPCs and ledger.
- Production migration history records version `20261112074001` (`office_wallet_pin_attempt_lockout`). The source migration filename must match that version.
- `office-cloud-files` is ACTIVE at version 10 with JWT verification enabled.

The rate-limit unit test was added to `core.test.ts`, but the full Vitest/Node/PostgreSQL CI suite has not yet been verified for this change. A transaction-scoped production SQL acceptance test using a synthetic auth user verified five reserved attempts, sixth-attempt rejection, successful-verification reset, and a subsequent allowed attempt; the transaction was rolled back and a follow-up query confirmed zero synthetic auth-user or attempt rows persisted. This validates the database lockout RPC, not the Edge Function's end-to-end HTTP path. Do not treat the Vitest test as passed until CI or an equivalent test run reports it.

### Release state

- The Vercel production deployment for application commit `997cc7d43ff95c0c982a6c0956e62905419ad7d8` reached READY. Its Vercel build completed successfully.
- `https://cocce-office.vercel.app` returned HTTP 200 and served the corresponding application bundle.
- Vercel build output still warns about large chunks (main JS approximately 954 kB; Docs editor approximately 535 kB). This is a performance warning, not a build failure.
- The GitHub combined commit status currently reports Vercel deployment checks only. A successful full GitHub Actions run for the latest commit has not been independently confirmed.
- No authenticated production PIN, purchase, renewal, balance or wallet-ledger end-to-end test was run.

### Remaining explicit limitations

- The production Bunny storage zone remains `cocce-kyc` with the existing S3-compatible signed-upload implementation. The requested `coccesuperapp/cocce-office/` migration has not been performed; production files have not been redirected.
- Biometric authorization has not been implemented or verified in the Office web flow.
- The editor and sector limitations documented above remain; this checkpoint does not claim full Office-format parity or 100% product completion.


---

## 2026-11-12 — persistent AI history and Docs image insertion

### COCCE AI conversation persistence

Implemented and applied three production migrations:

- `office_ai_chat_persistence` — creates private workspace-scoped conversation and message tables, indexes, RLS policies and authenticated RPCs.
- `office_ai_chat_delete_hard` — owner-only conversation deletion physically removes the conversation and cascades its messages.
- `office_ai_message_order` — adds a database identity sequence so user/assistant messages inserted in the same transaction are restored in deterministic order.

The UI now:
- Lists the latest 30 saved conversations for the selected workspace.
- Opens saved conversations and restores up to 100 messages in sequence order.
- Starts a new conversation without deleting previous history.
- Saves each user/assistant exchange atomically through `office_ai_save_exchange`.
- Supports owner-only deletion.
- Keeps all-workspace (`*`) questions temporary; a single selected workspace is required for persistent history.
- Clears in-memory private chat state when the account or workspace changes.

Security boundaries:
- RLS is enabled on both tables.
- Authenticated clients have SELECT only; they have no direct INSERT, UPDATE or DELETE grants.
- Anonymous users have no SELECT grant.
- Writes/deletion are handled by security-definer RPCs with pinned empty search paths, authenticated owner checks, active workspace membership and workspace AI-enabled checks.
- Conversation and message reads are scoped to the authenticated owner and active workspace membership.

Production PostgreSQL acceptance was executed in rollback-protected transactions with synthetic users and a synthetic workspace. It verified authenticated create/save, owner read, cross-user RLS denial, hard-delete cascade and rollback cleanup. Follow-up queries found zero synthetic users, conversations or messages persisted. This does not yet verify the browser UI against a real signed-in user's session.

### COCCE Docs image insertion

Added a custom TipTap image node and an Insert Image action.

- Device PNG/JPEG/WebP images are accepted up to 12 MB before processing.
- Images are resized to a maximum 1,600 px edge and compressed to a bounded embedded data URI (maximum 1.8 MB).
- Image source sanitization permits only bounded base64 PNG/JPEG/WebP data URIs; remote URLs, SVG data, event handlers and unsafe attributes are removed.
- Safe image HTML is retained through document sanitization, rich-text persistence, reopen and Markdown export.
- Image-only documents are no longer mistaken for empty drafts when reopened.
- Image width controls are available for Auto, Small, Medium, Large and Full sizing.
- A responsive image style and image sanitization regression tests were added.

Images are embedded in the local rich-text document. This implementation does not yet upload image binaries to Bunny Drive or provide Drive image insertion; cloud image asset storage and shared collaboration remain separate outstanding work.

### Release and validation status

- The last verified Vercel build before the final image-width UI adjustment was READY for commit `5b246a6364d13cfa51a8b3c74570bff94d043403`; Vercel reported both project checks successful and the preview returned the COCCE Office HTML shell.
- Earlier intermediate builds failed because review-comment newline string literals were accidentally changed while normalizing inserted component markup. The literals were restored; the `5b246a6` build then succeeded.
- Subsequent source commits for image sizing and deterministic AI message ordering are awaiting their own latest exact-commit deployment verification.
- The focused Docs sanitizer tests have been added but not yet executed in this environment. Do not count them as passed until Vitest/CI reports them.
- Full GitHub Actions, complete Vitest, Node acceptance and sector PostgreSQL suites have not been rerun for this checkpoint.

### Still outstanding after this stage

- Browser-level authenticated AI history verification with a real test account.
- Streaming AI responses and independent AI Chat destination.
- Workspace-wide sector retrieval and approved AI actions/automations.
- Bunny image upload and Drive insertion; private Drive migration and full Drive operations.
- Docs cloud autosave/synchronization and shared editing.
- Sheets, Slides and PDF completion.
- Reliable offline queues and conflict resolution.
- Remaining ten-sector workflow acceptance and mobile/device QA.


---

## 2026-11-12 — AI Chat dock separation and Drive-backed Docs images

- Added a dedicated **AI Chat** dock destination, separate from **COCCE AI**. AI Chat starts with team-conversation context and Drive context disabled; it stores private persistent conversations against one selected AI-enabled workspace. COCCE AI retains its multi-workspace and selected-Drive context workflows.
- Docs now supports selecting a PNG/JPEG/WebP from the device or selecting a matching image file in the authenticated private Cloud Drive panel. Drive image bytes are downloaded through the existing signed, membership-checked download path and SHA-256 integrity verification before being embedded in the local rich-text draft.
- Image files from Drive are limited to 12 MB before local compression. Unsupported extensions, invalid image data, and failed downloads are rejected. The image bytes are embedded in the rich-text document; they are not copied back to Drive or shared automatically.
- Added a PGlite PostgreSQL acceptance test script for AI history creation, atomic message order, cross-user RLS, direct-write denial, disabled-AI rejection, membership revocation and hard-delete cascade. The script is wired into the full `npm test` chain. It has not yet been executed in the current environment; the separate transaction-scoped production SQL acceptance checks passed earlier.
- Vercel build for commit `4b2b907` reached READY, covering the Docs Drive image insertion callback. Later separate AI Chat route and test-harness commits are still awaiting exact-commit build/test verification.


---

## 2026-11-12 — local Sheets chart authoring

- Added a persisted chart model to each local worksheet. Older saved workbooks remain valid because the chart collection is optional.
- Users can Shift-select a bounded range, choose Bar or Line, and create a chart using the first row as headers, the first column as category labels and the second column as numeric values.
- Bar charts support positive and negative values around a zero baseline. Line charts render numeric points with labels.
- Charts remain linked to the source cell range and redraw when the source worksheet values change.
- Users can remove charts. A worksheet is limited to 20 charts and chart ranges must be valid, forward-ordered, two-dimensional selections within the visible A1:L24 grid.
- Added local storage tests for chart creation, persistence, removal, invalid-range rejection and chart retention when source cells change.
- Charts are browser-local only. They are intentionally excluded from XLSX interchange and the existing cloud snapshot format until a compatible interchange contract is implemented.
- The source changes are committed on `main`; a Vercel build for this exact chart tranche has not yet been confirmed. The automated Vitest test has been added but has not yet been executed in this environment.


### Sheets quick analysis refinement

- Added a live selected-range summary with numeric-cell count, sum, average, minimum and maximum.
- Values are derived from the visible evaluated cell results, including supported formulas; blanks and non-numeric labels are ignored.
- The summary is read-only and remains local to the workbook. It does not transmit selected cell contents to AI or a server.

---

## 2026-11-12 — VisionOS-inspired AI Chat interface

- The dedicated AI Chat route now uses a two-pane glass conversation window: a translucent conversation-history sidebar and a larger focused message surface.
- The dedicated Chat route hides the separate hero banner, keeps the workspace selector in a compact top context row, and defaults to the first joined workspace rather than the all-workspaces scope. This ensures private chat history is persisted to a concrete workspace from the first conversation.
- Added local title search across loaded conversations, 30-at-a-time history pagination with stale-page protection, a floating circular send control, refined glass message bubbles, a quiet empty state, and automatic scroll-to-latest-message behavior.
- Added stale-request protection when opening a saved conversation so a response from a previous workspace selection cannot overwrite the current thread.
- Mobile layout stacks the conversation list above the message pane; reduced-motion preferences disable the decorative transitions.
- The separate COCCE AI assistant keeps its existing multi-workspace and explicit Drive-context interface.
- Reference inspiration: the MacRumors report on Telegram's early visionOS concept, especially its translucent environment-matched interface, conversation sidebar and focused media/chat surface. This is an adaptation, not a pixel-for-pixel copy.
- Focused validation after the final chat/search/glass-boundary changes passed 17 tests across `glassStyles.test.ts` and `OfficeAiWorkspace.test.tsx`; the production TypeScript/Vite build also passed at commit `7de27e8`. A separate 45-test focused run passed before the final small search and glass-boundary refinements. The complete Vitest stage then passed and proceeded into the Node/PostgreSQL acceptance scripts; the overall `pnpm test` command stopped later at `test:office-institutions-schema` because the isolated Vercel sandbox does not contain the PostgreSQL `initdb` binary. That environment failure is not counted as a product test pass. The production Vercel deployment for `7de27e8` reached READY and carries the `cocce-office.vercel.app` production alias.
- Current limitations remain: AI responses are returned after the provider completes rather than streamed; title search covers only pages the user has loaded into the sidebar; real signed-in browser/device QA has not yet been performed.

### AI Chat history pagination follow-up

- The private history list now fetches 30 conversations at a time using server pagination, and the sidebar exposes a compact Load older chats action when a full page is returned.
- Search filters the conversations currently loaded into the sidebar; loading older pages expands the searchable set without replacing already loaded rows.
- Added a generation guard so an older-page response is discarded if the selected workspace changes while the request is in flight.
- The focused AI Chat suite now has 10 passing tests, including the first and second history-page boundaries. The TypeScript/Vite production build passed after this change.

### AI Chat destructive-action safeguard

- Permanent conversation deletion now requires the shared Frosted Confirm dialog, names the conversation, explains that its messages will be removed, and uses a destructive confirmation action.
- Cancelling leaves the conversation and its message rows untouched; the existing owner-only hard-delete RPC remains the only deletion path.
- Added a regression test for cancellation. The dedicated AI Chat component suite now passes 11/11 tests and the TypeScript/Vite build passes after this change.

### AI Chat keyboard interaction

- Enter submits the current message; Shift+Enter keeps a multiline draft. The behavior is covered by a component test and uses the same validated submit path as the send control.
- The dedicated AI Chat component suite now passes 12/12 tests; the glass boundary suite passes 8/8; the production TypeScript/Vite build passes. The latest commits are not yet deployed because Vercel is returning a build-rate-limit failure for both linked project checks; the previously verified production deployment remains commit `7de27e8` until a newer deployment reaches READY.

### AI Chat final interaction tranche

- The composer now sends on Enter and preserves multiline text on Shift+Enter; both paths use the same submit validation and request handler.
- The latest focused run passed 12/12 AI Chat component tests and 8/8 glass-boundary tests (20 total), followed by a successful TypeScript/Vite production build.
- Latest main commit: `7adfdbb` for the keyboard test, with subsequent roadmap documentation committed separately. The last READY production deployment is still `7de27e8`; newer Vercel builds are currently rejected by the account's build-rate limit. Do not claim the latest chat changes are live until a deployment for the newer commit reaches READY.


---

## 2026-11-12 — People chat spatial UI and audio waveform tranche

- Redesigned the regular People & Teams Chats page separately from AI Chat. The layout now uses a three-surface conversation workbench: workspace people/contacts, a conversation rail for direct and group threads, and a focused message canvas. On small screens, the conversation rail becomes a horizontal strip and the message composer remains usable without horizontal page overflow.
- The real server-backed conversation panel is now the primary Chats surface. Existing direct/group creation, membership and authorization, presence, realtime/polling, replies, edits, deletes, read receipts and Bunny-backed attachment workflows remain the source of truth.
- Added live microphone analyser visualization while recording, waveform extraction from decoded audio, playback progress highlighting on the waveform, and native audio controls. Recording is stopped and microphone tracks/audio contexts are cleaned up on conversation changes and component disposal; a recording is not uploaded into a different chat after navigation.
- Added bounded waveform helpers and unit coverage for silence/empty buffers, peak normalization, live analyser bins, and invalid bar counts.
- GenOffice UI reference reviewed: its real product screenshots show a paper-like Docs canvas beside a document-aware AI panel, and the official product description emphasizes real DOCX/XLSX/PPTX formats, reviewable AI edits and local document workflows. COCCE Docs now places its existing COCCE AI writer rail beside the page canvas on desktop, stacks it below the editor on mobile, and refines the ribbon/paper treatment. This is an inspiration adaptation; no third-party UI screenshots or assets were copied into production.
- Reference links: https://genoffice.ai/ and https://github.com/genspark-ai/genoffice; visionOS chat inspiration: https://www.macrumors.com/2023/11/14/telegram-demos-visionos-app/.
- Focused checks in the implementation sandbox passed 28 tests (glass ownership, collaboration component, AI Chat regression and waveform helpers) and TypeScript/Vite build passed. The complete suite was attempted but the disposable build sandbox terminated during execution; rerun CI/full test suite before release.
- Stories are not yet implemented in the existing Office collaboration schema/API. The chat backend supports direct, group and channel conversations plus media attachments; do not represent ephemeral stories as working until a dedicated workspace-scoped story data model, expiry policy, media authorization and UI have been implemented and tested.


## 2026-11-12 — Workspace Stories delivery

- Added an additive workspace-scoped stories schema and authenticated RPCs for listing, publishing, viewing and deleting stories.
- Story visibility is limited to active workspace members; stories expire after 24 hours; each author is limited to 20 publications per rolling 24-hour window.
- Media is restricted to JPEG, PNG, WebP, MP4 and WebM and is uploaded through the existing private Office Cloud API. The migration prevents an active story's cloud media from being trashed until the story expires or is deleted.
- Added story rail, composer, private media viewer, view counts and author deletion controls to the dedicated Chats route. It is not shown for the all-workspaces scope.
- Added frontend tests and an isolated PGlite migration test covering workspace isolation, supported media, expiry, view tracking, deletion permissions and active-media protection. The three database tests passed locally.
- The story migration has been added to the repository but has not yet been applied to the production Supabase database. Production story publishing remains unavailable until the migration is applied and verified there.



## 2026-11-12 — Editor interchange, PDF tools and AI provider status

This entry supersedes earlier same-day notes that said the Stories migration had not been applied or that the newer AI provider was not configured.

- **AI Chat:** The JWT-verified `office-ai-chat` Edge Function is version 23 and delegates inference to the server-only Vercel route `/api/office-ai-provider`. The provider validates the caller against Supabase Auth, independently verifies workspace membership and AI enablement, uses OpenRouter's `openrouter/free` router, rejects paid model IDs and positive-cost responses, and keeps the OpenRouter key server-side. Production provider status returned HTTP 200 with `configured: true`. Provider tests use synthetic credentials and mocked upstream responses; a real authenticated user chat generation has not yet been smoke-tested.
- **Stories:** The additive stories migration is now applied to production Supabase. `office_stories` and `office_story_views` have RLS enabled; direct table access is revoked; authenticated RPCs enforce active membership and author/admin deletion; the media trigger protects active story files. Production catalog checks confirmed the policies, table privileges and function grants.
- **Docs interchange:** COCCE Docs supports DOCX and Markdown export, plus HTML and plain-text export. It now imports DOCX, HTML, Markdown and TXT into editable rich text. HTML import is sanitized, unsafe links and scripts are removed, and text imports are size-bounded. Markdown import preserves common headings, emphasis, lists, quotes and safe links.
- **Slides interchange:** Added real editable PPTX export with text, slide layouts, theme palette, retained local images and speaker notes. PPTX import now extracts slide text and speaker notes, recognises common layouts, applies ZIP path/entry/expanded-size checks, and flags embedded images for reinsertion (image payloads are not yet restored on import). The existing COCCE Slides JSON import/export remains.
- **Sheets:** Existing CSV/XLSX interchange remains in place; this tranche did not change its formula engine.
- **PDF:** The local copy-based toolset now includes page extraction, rotation, reorder, merge, page removal, insertion of pages from another PDF at the selected position, and centered PNG/JPEG insertion. Existing text search, annotations, annotation backup/restore and flattened visual-mark copies remain. These operations create a new local copy and do not mutate the source; advanced PDF metadata/signatures may not be preserved.
- **Validation:** Latest focused checks include 30 Slides/PPTX and Slides workspace tests, 77 combined Slides/PDF regression tests across five files, 44 PDF tests in the preceding focused run, 28 Docs/import tests, 15 AI-provider/story database checks, plus successful production TypeScript/Vite builds. GitHub CI passed for the latest Story migration / provider changes; later PDF/PPTX changes have focused local validation and their own CI runs must be checked before release.
- **Deployment:** Latest production deployment still runs commit `257c28d`. Vercel rejected subsequent deployment creation with HTTP 402 because the team's 100-deployments-per-day API allowance was exhausted (retry window 24 hours). The production app remains reachable; newer `main` commits are not yet live. Do not claim deployment completion until a newer deployment reaches READY.
- **Remaining:** Run an authenticated live COCCE AI Chat smoke test with a test account; restore embedded PPTX images during import; complete remaining cloud sync/offline, editor, AI automation and ten-sector workflows; re-run full CI on the latest commit; deploy after Vercel's quota resets and verify production workflows.

## 2026-11-12 — AI permission recovery, wallet safety and editor interchange follow-up

- **AI Chat production failure:** The deployed `office-ai-chat` request path and the Vercel provider both use `office_get_workspace_ai_enabled`. Production logs showed the RPC failing because its membership helper was qualified as though the private schema were nested under `public`, producing PostgreSQL SQLSTATE `0A000` and an Edge Function 503. Added and applied migration `20261112102219_fix_office_workspace_ai_enabled_membership_schema`; the corrected RPC now calls `office_private.is_active_member` and reads `public.office_workspaces`. An authenticated-role check using the affected workspace returned `true`.
- **AI Chat error reporting:** Supabase `FunctionsHttpError` responses now expose the safe JSON error code/message to the user instead of only the generic non-2xx text. Added helper and component regression tests. A real post-fix model-generation smoke test still requires an authenticated user session; no successful generation is claimed from the database permission check alone.
- **Wallet PIN compatibility:** Verified the current Super App source: `profiles.wallet_pin_hash` is presently the literal four-digit PIN text despite the legacy column name, and the Super App compares that value directly. Office keeps the same compatibility contract server-side, uses a separate service-role-only attempt/lockout table, and refuses to call the existing atomic purchase/renewal RPC when PIN verification fails. No Super App files, wallet ledger schema, wallet triggers, or purchase/renewal RPCs were changed. The existing purchase/renewal RPCs still use the shared `wallet_transactions` ledger and the established `wallet.atomic_writer = v2` path. No real-money transaction was executed as part of this audit.
- **PowerPoint import:** PPTX import now resolves slide image relationships and restores the first supported embedded PNG/JPEG/WebP image per slide into the new deck's local image store, retaining its description. Imports are bounded by the existing 2 MB per-image validation, eight active-image limit and 12 MB active-image total. Unsupported, invalid, additional or over-limit images are counted and reported for reinsertion; no image is silently represented as restored.
- **Sheets cloud copies:** Cloud snapshot format version 2 preserves bounded bar/line chart metadata on each worksheet. The parser remains backward compatible with version-1 cloud copies. XLSX interchange remains the existing bounded single-sheet subset and does not yet include chart objects.
- **Validation:** GitHub Actions run `43201795115` passed on commit `304940a3ef3105e933fd6f5de9dcb7dde8e8b610`: all 139 Vitest files passed (1,167 tests passed, one skipped), the additional PostgreSQL/sector acceptance scripts passed, and the production TypeScript/Vite build completed successfully.
- **Release status:** These changes are committed to `main`. They are not yet included in the production Vercel deployment: the latest confirmed READY deployment remains commit `257c28d`. The earlier deployment attempt was rejected by Vercel's daily deployment quota (HTTP 402). Do not claim the updated UI is live until a deployment for a newer commit reaches READY.


## 2026-11-12 — Native XLSX chart export

- Single-worksheet XLSX exports now include supported native Excel bar and line chart objects, with chart series linked to absolute worksheet cell ranges. Chart titles and worksheet names are XML-escaped; apostrophes in worksheet names are correctly quoted in formulas.
- Chart export validates the existing 20-chart cap, chart type, title, timestamp and visible-grid range before generating package relationships. It does not silently drop invalid chart metadata.
- Existing versioned cloud snapshots continue to preserve chart metadata and restore charts as editable COCCE worksheet charts.
- External XLSX chart import remains unsupported and is explicitly disclosed in the UI and import/export fidelity warning. The importer still refuses drawing/chart packages rather than silently losing chart data.
- Regression coverage added for native bar/line chart package parts, worksheet drawing relationships, safe absolute references and invalid/over-limit chart rejection. Full CI and a new production build are being rerun after the initial test exposed a mismatch between the intended absolute-reference assertion and the emitted formulas.


## 2026-11-12 — Reliability and editor workflow hardening

- Automatic cloud sync now retries a previously failed item when the user returns to the visible tab or window, as well as when network connectivity returns. A failure is reported in the sync panel without creating an unhandled promise rejection; retries remain event-driven and do not create a tight retry loop.
- The retry path continues to use the existing per-item consent, idempotency journal, private Cloud Drive reservation/finalization, SHA-256 verification, immutable revision creation, and stale-base conflict detection. It does not upload other local records or overwrite a newer remote revision.
- AI conversation persistence now checks the active request generation after conversation creation and exchange persistence. If the user switches or clears workspace access while a save is pending, the old request cannot attach its conversation ID or refresh the newly selected workspace's history.
- Regression coverage added for tab-resume sync recovery and stale AI conversation creation across a workspace switch. These changes do not change AI provider/model selection, workspace authorization RPCs, or wallet behavior.
- The native XLSX chart exporter emits absolute cell references in bar/line series formulas. The chart import boundary remains unchanged: external chart/drawing packages are still refused rather than partially imported.
- Validation for this tranche is running on GitHub Actions; no deployment claim is made until the full test suite and production build pass.
