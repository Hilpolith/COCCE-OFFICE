# Architecture notes

## Current foundation

The application is a React 19 + TypeScript single-page web project built with Vite. Presentation, local state, and page navigation are separated into `src/App.tsx`, `src/index.css`, and `src/lib/localStore.ts`. The local storage module validates persisted shapes and exposes narrow operations for workspace labels and text documents. No remote service client is configured.

The brand asset at `public/brand/cocce-office-logo.png` is the user-provided COCCE Office logo. Its transparent alpha is preserved; the squircle silhouette and lettering are not redrawn.

## Reference project assessment

The public GenOffice repository uses React/TypeScript but its apps are principally Electron desktop applications. Its Docs surface uses Tiptap/ProseMirror and OOXML patching; Sheets uses Univer plus a Rust sidecar; Slides uses React/Konva with PPTX engines; PDF uses PDF.js/PDFium/pdf-lib. The renderer depends on Electron IPC, filesystem access, native tools, and desktop process boundaries, so the app cannot be copied into a browser build unchanged. Only specific portable packages should be evaluated, with separate review for all licenses and transitive notices. The `ee/` directory is separately licensed and must not be used in a hosted service without the required authorization.

## Target architecture (not yet implemented)

1. Reuse COCCE identity only through the existing Supabase Auth contract after the owner explicitly approves any additive OAuth redirect/client configuration. Keep service-role and provider keys server-side.
2. Put all Office-only records in additive `office_` tables with RLS and workspace/resource authorization. Do not alter existing COCCE tables, triggers, Edge Functions, auth behavior, Firebase setup, or storage rules.
3. Create Office-owned upload authorization and storage mappings through a server-side boundary; never expose Bunny credentials to the browser and never share existing application paths.
4. Use separate, audited services/workers for document conversion and native engine tasks. Browser-facing editors must be tested for format round-trips rather than claiming full DOCX/XLSX/PPTX fidelity based on the desktop app.
5. Route AI through a server-side provider abstraction that can select only approved free models, enforces user/workspace permissions, rate limits, and approval gates, and logs real execution records.
6. Treat localization, collaboration, notifications, Vault protection, and release qualification as first-class workstreams—not UI badges.
