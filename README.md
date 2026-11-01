# COCCE Office — foundation preview

This private, isolated React/TypeScript project is the starting foundation for COCCE Office. The current build is a **local-only preview**, not a production collaboration service.

## What works

The responsive interface uses a frosted liquid-glass treatment guided by the supplied references. The supplied COCCE Office squircle logo is reused with its transparent alpha and original artwork intact. In this browser, users can create and switch local workspace labels, draft and search plain-text documents, export Markdown, and persist six themes plus an accent color. COCCE Sheets now supports local workbooks and worksheets, cell editing, a tested formula evaluator (arithmetic, references, ranges, and common functions), and CSV import/export. CSV export writes formula results as values and prefixes formula-like text to reduce spreadsheet-formula injection risk. Formula, parser, upload-size, and export-area limits have unit coverage.

## Important limits

There is no sign-in, Google OAuth, shared database, membership, invitations, roles, cloud storage, upload authorization, messaging, notifications, DOCX/PPTX/PDF engine, XLSX support, Vault encryption, AI provider, workflow runner, or multilingual catalog connected. Sheets is a limited local grid and CSV tool, not an Excel-compatible or collaborative service. Other module pages identify their connection status; they do not fabricate records or make pretend service calls. Do not use this preview for confidential, sensitive, or shared work. Data is stored in this browser only and can be cleared by the browser.

## Run and test

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
```

## Isolation and integration

The project does not import COCCE Super App code, read its secrets, call its APIs, or change its configuration. The current local store uses `window.localStorage`; no remote service client is active. Review [the architecture notes](docs/architecture.md), [integration boundaries](docs/integration-boundaries.md), and [implementation log](docs/implementation-log.md) before adding any shared services.

The upstream GenOffice repository is primarily an Electron desktop product; its Electron IPC/native-engine assumptions are not directly portable to a browser. The separately licensed `ee/` directory was not copied.

## Release status

This foundation is **not eligible for production release** under the supplied definition of done. The `cocce-office.vercel.app` alias is attached to a Vercel project that is currently paused; unauthenticated requests return `503 DEPLOYMENT_PAUSED`. Do not unpause or present the alias as a live enterprise service until authentication, backend authorization/RLS, storage, the seven productivity modules, real-time collaboration, AI, localization, and their security/end-to-end tests are implemented and verified.
