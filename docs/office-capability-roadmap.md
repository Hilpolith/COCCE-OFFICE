# COCCE Office capability matrix and roadmap

COCCE Office is a growing local-first productivity suite, not yet a replacement for Microsoft Office or GenOffice. The current modules perform real work, but native-file compatibility, broader editing models, and several AI surfaces remain future work. This roadmap adopts public feature concepts only; no GenOffice source code is used.

## Verified capability matrix

| Area | Status | Working now | Important gaps |
|---|---|---|---|
| Docs | Partial | Browser-local rich text; headings 1–3; paragraph, bold, italic, underline, strikethrough, lists and quotes; autosave/recovery; Markdown export; selection-based AI actions, prompt-only drafts and preview-before-insert. Full-document summaries require explicit confirmation. | No DOCX, page layout, tables/images, comments, tracked changes, citations, mail merge, cloud sync or collaboration. AI generation is currently unavailable when the fixed free endpoint is rate-limited. |
| Sheets | Partial | Local workbooks and worksheets; a bounded visible grid; cell/formula editing; a tested subset of formulas; CSV import/export; keyboard navigation with arrows, Tab and Enter. | No XLSX, cell formatting, charts, pivot tables, data validation, broad Excel formula compatibility, range editing or AI-generated sheets. |
| Slides | Partial | Local text decks; three themes; title/body/notes; add, duplicate, delete and reorder slides; JSON transfer; print-to-PDF; presenter navigation and optional speaker notes. | No PPTX, slide layouts/masters, images, shapes, charts, transitions, animation, media, cloud collaboration or AI-generated decks. |
| PDF | Partial | Local viewing, selectable text, page navigation and multi-occurrence search; local highlights/comments; page rotation, extraction, reorder and merge as new copies. Originals remain unchanged. | No OCR, direct text/image editing, embedded annotations, form creation, signatures, secure redaction or cloud review. |
| AI | Partial | User-invoked Docs selection tools and prompt-only drafting; local reusable recipes; preview/undo; separately confirmed, bounded plain-text document summaries. Provider key stays server-side. | No Sheets/Slides/PDF AI authoring, no autonomous/background workflows, no full-document indexing, and no paid or alternate-provider fallback. Last production smoke returned temporary free-model unavailability (upstream rate limit); successful generation is not currently verified. |
| Files and collaboration | Partial | Browser-local Drive/Vault and a separately server-backed Office Teams feature using existing COCCE accounts. | Personal Docs/Sheets/Slides/PDF files are not cloud-synced or shared. Office Teams does not make local personal files collaborative. Native Office-format round trips are absent. |

The first implementation tranche adds real, local capabilities without changing data boundaries: H3 and strikethrough in Docs, bounded keyboard navigation in Sheets, presenter-only speaker notes in Slides, and bounded all-occurrence PDF search with next/previous navigation. A shared toolbar treatment improves spacing, focus, touch targets and responsive wrapping across these editors. Regression tests cover the added behavior.

## Practical roadmap

1. **Polish and harden the existing local editors.** Continue with accessible toolbar groups, mobile layouts, keyboard paths, import/export limits, save/recovery feedback, and non-destructive operations. Add component tests before expanding control surfaces. This phase must not imply cloud backup or file compatibility.
2. **Add one bounded authoring capability at a time.** Candidate increments: Docs tables and review comments; Sheets cell formatting, range selection/copy-paste, and more tested formulas; Slides reusable layouts and local images with alt text; PDF searchable hit highlighting and an explicit output-copy/download path. Define schema and round-trip behavior before each feature.
3. **Expand user-controlled AI across editors.** Build prompt-to-sheet and prompt-to-slide as typed-prompt-only flows with a validated structured preview and explicit apply step; consider PDF actions only on text the user selects. Reuse the existing fixed free endpoint, retain the 55-day/no-training disclosure, and keep failure retryable—never silently switch to paid or alternate models. The current upstream rate limit blocks verification of successful generation.
4. **Plan native formats and collaboration separately.** DOCX/XLSX/PPTX compatibility, cloud files, shared annotations, version history, OCR, signatures, and real-time editing need independent format/security reviews, compatibility fixtures, authorization design, retention rules, and owner approval before implementation or claims of support.

## Reference points

- [GenOffice public README](https://github.com/genspark-ai/genoffice/blob/main/README.md) and [public product overview](https://genoffice.ai/) describe native document formats, reviewable AI changes, richer spreadsheets and decks, and PDF tools. These are concept references only; restricted `ee/` code was not inspected or copied for this implementation.
- [Microsoft Word web-versus-desktop comparison](https://support.microsoft.com/en-us/word/word-features-comparison-word-for-the-web-vs-desktop) shows that even Word’s web and desktop feature sets differ materially.
- [Microsoft Excel function reference](https://support.microsoft.com/en-us/excel/excel-functions-by-category) illustrates the breadth and version-specific nature of spreadsheet formula compatibility.
- [Microsoft PowerPoint platform comparison](https://support.microsoft.com/en-us/powerpoint/compare-powerpoint-features-on-different-platforms) documents platform-dependent slide, media and presenter capabilities.
- [Adobe Acrobat PDF editing overview](https://www.adobe.com/acrobat/features/modify-pdfs.html) is a practical benchmark for PDF content editing, OCR, annotations and page operations.

This matrix describes verified capability boundaries, not a claim of feature parity. New controls should appear only when the underlying behavior, tests and data boundary are ready.
