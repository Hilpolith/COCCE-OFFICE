# Architecture notes

## Current foundation

The application is a React 19 + TypeScript single-page web project built with Vite. Presentation, local state, and page navigation are separated into `src/App.tsx`, `src/SheetsWorkspace.tsx`, `src/index.css`, and `src/lib/localStore.ts`. The local storage module validates persisted shapes and exposes narrow operations for workspace labels, text documents, workbooks, worksheets, and cell values. `src/lib/spreadsheetEngine.ts` is an isolated expression parser/evaluator; it does not use JavaScript `eval`. No remote service client is configured.

The brand asset at `public/brand/cocce-office-logo.png` is the user-provided COCCE Office logo. Its transparent alpha is preserved; the squircle silhouette and lettering are not redrawn.

## Local Sheets boundary

COCCE Sheets stores workbook cells in the current browser and supports CSV import/export plus arithmetic, cell references, ranges, comparisons, and the implemented `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `ABS`, `ROUND`, `IF`, `AND`, `OR`, `NOT`, and `CONCAT` functions. Circular references and unsupported formulas return visible spreadsheet errors. CSV exports calculated formula values and prefixes formula-like text to reduce spreadsheet-formula injection risk. Version-1 data predating Sheets migrates by adding an empty workbook collection; unsupported or unreadable stored versions cannot be overwritten by this build. The grid is a limited local foundation: it does not claim XLSX compatibility, server-side authorization, collaboration, charts, cloud sync, or backup.

## Reference project assessment

The public GenOffice repository uses React/TypeScript but its apps are principally Electron desktop applications. Its Docs surface uses Tiptap/ProseMirror and OOXML patching; Sheets uses Univer plus a Rust sidecar; Slides uses React/Konva with PPTX engines; PDF uses PDF.js/PDFium/pdf-lib. The renderer depends on Electron IPC, filesystem access, native tools, and desktop process boundaries, so the app cannot be copied into a browser build unchanged. Only specific portable packages should be evaluated, with separate review for all licenses and transitive notices. The `ee/` directory is separately licensed and must not be used in a hosted service without the required authorization.

## Target architecture (not yet implemented)

1. Reuse COCCE identity only through the existing Supabase Auth contract after the owner explicitly approves any additive OAuth redirect/client configuration. Keep service-role and provider keys server-side.
2. Put all Office-only records in additive `office_` tables with RLS and workspace/resource authorization. Do not alter existing COCCE tables, triggers, Edge Functions, auth behavior, Firebase setup, or storage rules.
3. Create Office-owned upload authorization and storage mappings through a server-side boundary; never expose Bunny credentials to the browser and never share existing application paths.
4. Use separate, audited services/workers for document conversion and native engine tasks. Browser-facing editors must be tested for format round-trips rather than claiming full DOCX/XLSX/PPTX fidelity based on the desktop app.
5. Route AI through a server-side provider abstraction that can select only approved free models, enforces user/workspace permissions, rate limits, and approval gates, and logs real execution records.
6. Treat localization, collaboration, notifications, Vault protection, and release qualification as first-class workstreams—not UI badges.
