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
