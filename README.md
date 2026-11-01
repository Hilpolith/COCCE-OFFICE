# COCCE Office — foundation preview

This private, isolated React/TypeScript project is the starting foundation for COCCE Office. The current build is a **local-only preview**, not a production collaboration service.

## What works

The responsive interface uses a frosted Liquid Glass treatment guided by the supplied UI references. The supplied COCCE Office logo artwork is preserved with transparent alpha; the sidebar, favicon, and home-screen icon use the transparent squircle asset. The app supports local workspace labels, six themes plus an accent color, and local document search.

**Docs** uses Tiptap/ProseMirror for editable rich text with headings, bold/italic/underline, lists, quotes, undo/redo, local autosave, and Markdown export of supported formatting. Legacy plain-text drafts remain readable; pasted content is inserted as plain text and stored markup is sanitized before it is rendered. Failed document saves remain visible and recoverable within the current tab across navigation, with retry and export controls; that temporary buffer is not a backup.

**Sheets** supports local workbooks and worksheets, cell editing, a tested formula evaluator (arithmetic, references, ranges, and common functions), and CSV import/export. CSV export writes formula results as values and prefixes formula-like text to reduce spreadsheet-formula injection risk. Formula, parser, upload-size, and export-area limits have unit coverage.

**Slides** supports browser-local text decks scoped to the current local workspace: create and rename decks, edit slide titles, line-based body text and speaker notes, choose among three visual themes, add/duplicate/delete/reorder slides, and present with keyboard navigation. Decks can be imported and exported in the COCCE Office Slides JSON format and printed or saved as PDF through the browser's own print dialog. Failed local-storage writes get a tab-scoped recovery copy when session storage is available.

**Drive** stores files in this browser's IndexedDB, scoped to the current local workspace. It supports multi-file upload (25 MB per file), previews for supported content, download, rename, reversible trash, permanent deletion, and recovery. This is local browser storage, not cloud storage or secure sharing.

**PDF** opens local PDFs with PDF.js, renders pages, searches extracted page text, and supports page navigation and preview rotation. The pdf-lib tools create new local copies for page rotation, extraction, reordering, and merging. Source PDFs are not overwritten.

## Important limits

There is no sign-in, Google OAuth, shared database, membership, invitations, roles, cloud storage, upload authorization, messaging, notifications, DOCX/XLSX/PPTX compatibility, encrypted enterprise Vault, AI provider, workflow runner, or multilingual catalog connected. PDF selection, annotations, highlights, comments, OCR, secure sharing, and cloud collaboration are not implemented. Drive does not have folders, sharing, version history, or remote sync. Slides is not a PowerPoint editor: its portable format is COCCE Office Slides JSON, not PPTX; it has no images, charts, shapes, transitions, or collaboration. Browser print-to-PDF is not a full PDF authoring workflow. Docs is a limited local rich-text draft editor, not a word-processing format engine; tables, images, page layout, tracked changes, comments, and collaboration are not implemented. Sheets is a limited local grid and CSV tool, not an Excel-compatible or collaborative service. Do not use this preview for confidential, sensitive, or shared work. Data is stored in this browser only and can be cleared by the browser.

## Run and test

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm lint
```

## Isolation and integration

The project does not import COCCE Super App code, read its secrets, call its APIs, or change its configuration. Local workbooks, Slides, Drive files, and PDF operations use browser storage; no remote service client is active. Review [the architecture notes](docs/architecture.md), [integration boundaries](docs/integration-boundaries.md), and [implementation log](docs/implementation-log.md) before adding any shared services.

The upstream GenOffice repository is primarily an Electron desktop product; its Electron IPC/native-engine assumptions are not directly portable to a browser. The separately licensed `ee/` directory was not copied.

Provided open-source dependency license texts are preserved in [third-party notices](public/third-party-notices.txt) and ship with the built application.

## Release status

This foundation is **not eligible for production release** under the supplied definition of done. The `cocce-office.vercel.app` alias is attached to a Vercel project that is currently paused; unauthenticated requests return `503 DEPLOYMENT_PAUSED`. Do not unpause or present the alias as a live enterprise service until authentication, backend authorization/RLS, secure cloud storage, full productivity-module requirements, real-time collaboration, AI, localization, and their security/end-to-end tests are implemented and verified.
