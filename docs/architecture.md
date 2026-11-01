# Architecture notes

## Current foundation

The application is a React 19 + TypeScript single-page web project built with Vite. Presentation, local state, and page navigation are separated into `src/App.tsx`, `src/DocsEditor.tsx`, `src/SheetsWorkspace.tsx`, styles, and `src/lib/localStore.ts`. The local storage module validates persisted shapes and exposes narrow operations for workspace labels, documents, workbooks, worksheets, and cell values. `src/lib/spreadsheetEngine.ts` is an isolated expression parser/evaluator; it does not use JavaScript `eval`. No remote service client is configured.

The brand asset at `public/brand/cocce-office-logo.png` is the user-provided COCCE Office logo. Its transparent alpha is preserved; the squircle silhouette and lettering are not redrawn.

## Local Docs boundary

Docs uses the MIT-licensed Tiptap/ProseMirror editor with a deliberately limited schema: paragraphs, H1/H2, text styles, lists, quotes, and undo/redo. The optional `richText` field stores sanitized markup; `content` remains a plain-text search/list copy. Older drafts without usable rich text fall back to escaped text paragraphs rather than being blanked by empty/unsafe markup. The allowlist sanitizer removes all attributes and active elements before stored rich text is rendered. Paste accepts plain text only, and HTML/file drop is disabled. Local storage failures leave saved data intact and retain failed document edits in a tab-local recovery buffer across navigation, with retry/export controls and a close-tab warning. Supported formatting exports to escaped Markdown; this is not a DOCX/PDF conversion engine, and there is no collaboration, page layout, comments, tracked changes, cloud sync, or backup. No GenOffice source or separately licensed editor extension was copied.

## Local Sheets boundary

COCCE Sheets stores workbook cells in the current browser and supports CSV import/export plus arithmetic, cell references, ranges, comparisons, and the implemented `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `ABS`, `ROUND`, `IF`, `AND`, `OR`, `NOT`, and `CONCAT` functions. Circular references and unsupported formulas return visible spreadsheet errors. CSV exports calculated formula values and prefixes formula-like text to reduce spreadsheet-formula injection risk. Version-1 data predating Sheets migrates by adding an empty workbook collection; unsupported or unreadable stored versions cannot be overwritten by this build. The grid is a limited local foundation: it does not claim XLSX compatibility, server-side authorization, collaboration, charts, cloud sync, or backup.

## Local Slides boundary

`src/SlidesWorkspace.tsx` uses the isolated `src/lib/slidesStore.ts` model and a separate `cocce-office-slides-v1` browser-storage key. Decks carry the current local workspace ID, so the personal space and locally named workspaces show separate decks. The editor supports slide text and speaker notes, three visual themes, slide insertion/duplication/deletion/reordering, keyboard-accessible presenter controls, browser print styling, and a versioned COCCE Office Slides JSON import/export format. Imported decks are shape-checked and limited to 100 slides, 12,000 characters per slide field, and 5 MB per input file. When local storage rejects a write, the UI keeps the current edit, writes a tab-scoped recovery copy where session storage is available, and offers retry; this remains browser-local recovery, not a backup. There is no PPTX reading/writing, Office compatibility, rich objects, PDF editing, cloud persistence, access control, or collaboration. The print action delegates PDF creation to the browser.

## Editor dependency sources and notices

The installed Tiptap packages are version 3.32.2 and declare MIT licensing. Integration follows the official [React setup](https://tiptap.dev/docs/editor/getting-started/install/react) and [StarterKit configuration](https://tiptap.dev/docs/editor/extensions/functionality/starterkit) documentation. The installed package license files were inspected, and complete provided license texts for the 58 resolved production packages are preserved in `public/third-party-notices.txt`; these notices ship with the web build. No enterprise editor package was installed.

## Reference project assessment

The public GenOffice repository uses React/TypeScript but its apps are principally Electron desktop applications. Its Docs surface uses Tiptap/ProseMirror and OOXML patching; Sheets uses Univer plus a Rust sidecar; Slides uses React/Konva with PPTX engines; PDF uses PDF.js/PDFium/pdf-lib. The renderer depends on Electron IPC, filesystem access, native tools, and desktop process boundaries, so the app cannot be copied into a browser build unchanged. Only specific portable packages should be evaluated, with separate review for all licenses and transitive notices. The `ee/` directory is separately licensed and must not be used in a hosted service without the required authorization.

## Target architecture (not yet implemented)

1. Reuse COCCE identity only through the existing Supabase Auth contract after the owner explicitly approves any additive OAuth redirect/client configuration. Keep service-role and provider keys server-side.
2. Put all Office-only records in additive `office_` tables with RLS and workspace/resource authorization. Do not alter existing COCCE tables, triggers, Edge Functions, auth behavior, Firebase setup, or storage rules.
3. Create Office-owned upload authorization and storage mappings through a server-side boundary; never expose Bunny credentials to the browser and never share existing application paths.
4. Use separate, audited services/workers for document conversion and native engine tasks. Browser-facing editors must be tested for format round-trips rather than claiming full DOCX/XLSX/PPTX fidelity based on the desktop app.
5. Route AI through a server-side provider abstraction that can select only approved free models, enforces user/workspace permissions, rate limits, and approval gates, and logs real execution records.
6. Treat localization, collaboration, notifications, Vault protection, and release qualification as first-class workstreams—not UI badges.
