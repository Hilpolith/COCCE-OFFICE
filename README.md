# COCCE Office — foundation preview

This private, isolated React/TypeScript project is the starting foundation for COCCE Office. The current build is a **local-only preview**, not a production collaboration service.

## What works

The responsive interface uses a frosted liquid-glass treatment guided by the supplied references. The supplied COCCE Office squircle logo is reused with its existing transparent alpha and original artwork intact. Users can create and switch local workspace labels, draft plain-text documents, search their local drafts, export a document as Markdown, and persist six themes plus an accent color in the current browser.

## Important limits

There is no sign-in, Google OAuth, shared database, membership, invitations, roles, cloud storage, upload authorization, messaging, notifications, DOCX/XLSX/PPTX/PDF engine, Vault encryption, AI provider, workflow runner, or multilingual catalog connected. Those module pages clearly identify their status; they do not fabricate records or make pretend service calls. Do not use this preview for confidential, sensitive, or shared work. Data is stored in this browser only and can be cleared by the browser.

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
