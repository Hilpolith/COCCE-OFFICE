# COCCE Office Docs AI

## What the writing studio does

The Docs writing studio provides user-triggered selection tools for summaries, proofreading, quality checks, clarity and concision edits, expansion, key points, action items, outlines, email rewrites, custom instructions, and new drafts. Draft starters cover email, meeting notes, project briefs, proposals, and report outlines. Users can save up to 12 reusable instruction recipes in this browser and run them on a selected excerpt. A separate full-document summary is available only after a one-time, explicit confirmation for the active document.

Every response is shown as a preview. Selection actions can replace only the ordinary text range explicitly selected for that request. Prompt drafts and full-document summaries are inserted at the active ordinary text selection's end only after the user chooses to apply them. An active table-cell range is never treated as an insertion target. Nothing is inserted automatically. The editor verifies that the document has not changed while the preview is open, then uses the normal Tiptap history and local autosave so Undo can reverse an applied change.

## What leaves the browser

No document is uploaded, indexed, or scanned automatically. Selection editing/review sends only the selected plain-text excerpt, capped at 8,000 characters. A prompt draft sends only the prompt typed into its form and never includes the current editor selection. Custom and saved workflows send the instruction plus the selected excerpt.

Table-cell ranges selected for formatting are not treated as excerpt selections or local review-comment selections. They are included in AI only when the user explicitly confirms a full-document summary.

Full-document summarization is a separate action. The UI first displays an accessible confirmation naming the active document and stating that its complete plain-text content will be sent through OpenRouter to the fixed free Google AI Studio endpoint. It also states the provider's 55-day prompt-retention/no-training policy, the absence of paid-model or alternate-provider fallback, and that the title, ID, file, and other document metadata are not sent. The user must affirmatively click **Confirm and send full text** before the request begins; **Cancel** sends nothing. The exact text snapshot and active title are checked again before sending, so a changed document invalidates the confirmation. Only `{ action, documentText }` is sent from the browser to the Office route; no file or document metadata is included.

The full-document request is limited to 20,000 JavaScript string characters and 38,000 serialized UTF-8 bytes. The route enforces the same full-document bounds and a 40,000-byte overall JSON-body limit. Oversized content is rejected before any provider call; the app never silently truncates or splits the document. If it is too large, use a smaller excerpt with the selection-only summary instead.

Saved workflow names and instructions are stored under the Office-specific `cocce-office-ai-workflows-v1` browser key. They are not synced unless a user explicitly runs one. No background jobs or unattended automations run.

## Provider, free model, and fallback safety

`api/office-ai.js` pins the server-side model ID `google/gemma-4-31b-it:free`. The public OpenRouter catalog lists this as a text-capable free variant with zero prompt and completion prices, a 262,144-token context, and `max_tokens` support. OpenRouter documents `:free` as a separate catalog variant with its own prices and availability; free endpoints can be rate-limited or temporarily unavailable. See the [OpenRouter free-variant guide](https://openrouter.ai/docs/guides/routing/model-variants/free), [model catalog](https://openrouter.ai/api/v1/models?limit=500), and [model endpoint details](https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints).

The model is not supplied by the browser. The server sends only this one fixed model ID, includes no alternate-model list, restricts OpenRouter to the exact `google-ai-studio` provider slug with `provider.only`, sets `provider.allow_fallbacks` to `false`, and rejects a response whose model ID does not exactly match the fixed `:free` ID or whose reported cost is positive. If the endpoint is missing, rate-limited, or unavailable, the route returns a temporary-unavailable message and does not select a paid model or alternate provider. The user can retry later. OpenRouter documents `provider.only` as the allowlist for request-level provider routing in its [provider-selection guide](https://openrouter.ai/docs/guides/routing/provider-selection).

The route uses OpenRouter's Chat Completions API with bounded output. Its provider key is stored only in the Vercel server environment as `OPENROUTER_API_KEY`; it is never given a `VITE_` name, bundled in client code, logged, or stored in browser storage. The route checks the bearer token with existing COCCE Supabase Auth, validates action-specific fields and size limits, and applies a short-window per-user in-memory request cap on each warm function instance (not a global quota). It does not persist content and logs no prompt, selection, full-document text, response text, raw provider error body, or credential.

## Provider privacy disclosure

A user action sends its selected excerpt, typed drafting prompt, or (only after the separate confirmation) complete document text through OpenRouter to the model provider. OpenRouter says it does not store prompts or responses unless an account opts into input/output logging or product use, but it keeps request metadata and may anonymously categorize a small sample. Provider data policies can differ. OpenRouter's current provider-logging page lists Google AI Studio as retaining prompts for 55 days and not training on them; provider policies may change. This Office route does not claim zero-data retention and does not request OpenRouter's `zdr` or `data_collection: deny` filters; synthetic preflight attempts with those additional filters did not produce a successful response. The UI discloses the provider policy before the user confirms full-document processing. Send only text you are permitted to share with a cloud service.

Sources: [OpenRouter data-collection policy](https://openrouter.ai/docs/guides/privacy/data-collection), [provider logging policies](https://openrouter.ai/docs/guides/privacy/provider-logging), [request-level provider controls](https://openrouter.ai/docs/guides/routing/provider-selection), [Zero Data Retention guide](https://openrouter.ai/docs/guides/features/zdr), and [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

## Limits and related work

This is a bounded set of on-demand Docs writing tools, not a general workflow engine. Full-document summarization is user-initiated and requires a fresh confirmation each time; there is no document-wide automatic scanning, scheduled automation, cloud document storage, collaborative editing, comments, tracked changes, or external app action. The separate Automations page remains informational and does not run model calls. The feature uses public productivity concepts only; no GenOffice source code, especially code from `ee/`, is included.

Local validation includes `src/lib/officeAi.test.ts` for payload minimization and local workflow contracts, `src/OfficeAiWriter.test.tsx` for selection/draft/full-document confirmation and preview behavior, and `scripts/office-ai-api-check.mjs` for mocked Auth, strict fields, limits, rate limiting, fixed-model routing, and error handling. All test text is synthetic; tests do not send document content to a provider.

An earlier controlled production smoke on 2026-11-03 with an existing COCCE test account confirmed the AI route was configured and authenticated; the synthetic selected-text request returned `503 FREE_MODEL_UNAVAILABLE` without generated text, while a direct synthetic preflight returned HTTP 429. This was a point-in-time rate-limit observation, not a guarantee of current availability; the fixed model still has no paid-model or alternate-provider fallback. No real document content was used. Recheck availability with synthetic content after a release.

Vercel's function platform has an independent request limit ([Function limits](https://vercel.com/docs/functions/limitations)); this route rejects JSON bodies above 40 KB and checks `Content-Length` early when available.


## Workspace-wide COCCE AI (November 2026)

The separate COCCE AI destination can now be scoped to one workspace or **All authorised workspaces**. Workspace context is optional and can be turned off before sending a prompt. The Edge Function validates the signed-in COCCE user and checks workspace membership through `office_list_workspaces`. It then obtains conversation lists and message excerpts only through the existing membership-aware `office_list_conversations` and `office_list_messages` RPCs. The browser never supplies conversation IDs or message contents as trusted context.

For bounded requests, the all-workspaces mode considers up to 20 workspaces and samples up to two conversations and two recent messages per workspace. A single-workspace request uses the same bounded sample for that workspace. Message text is truncated to 600 characters per message and labelled as untrusted context; messages cannot override system instructions. Context is not written back into chats. The request cap remains 12 per user per 10-minute warm Edge Function instance, and the model remains pinned to the free Google Gemma endpoint with paid fallback disabled.

COCCE AI now supports **explicitly selected** private Drive text-file context. The user chooses up to three `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.yml`, or `.log` files in the AI workspace picker. The browser sends only file IDs; the Edge Function calls `office-cloud-files` with the caller's JWT, verifies the file belongs to an AI-enabled workspace in the selected scope, obtains a short-lived private Bunny download URL, and fetches the bytes server-side. Each file is limited to 512 KiB and 8,000 characters, with 20,000 characters total; UTF-8 is required and binary/null-byte content is rejected. File excerpts are labelled as untrusted context. No Drive files are scanned automatically. PDF, DOCX, XLSX, PPTX, Vault items, private sector records and local browser files are not included in AI context yet. The feature does not run unattended automations. If team conversation history is switched off, team messages are omitted but explicitly selected Drive files remain attached.

The Edge Function is deployed as `office-ai-chat` with JWT verification enabled. The November 2026 deployment uses the membership-aware workspace RPCs and has no service-role credential in the browser.


Workspace owners and administrators can disable or re-enable COCCE AI per workspace in Team & Collaboration. The setting is stored on the workspace, not in browser state. The AI Edge Function checks it for every workspace in the selected scope; disabled workspaces are excluded, and a request is rejected if no enabled workspace remains. Members can see the setting but cannot change it. Context-off requests still respect the workspace AI setting.


## Deployment verification — 2026-11-09

The current workspace-wide Edge Function is ACTIVE as version 13 in the existing COCCE Supabase project, with `verify_jwt=true`. Its deployment was inspected after release and includes the all-authorised-workspaces loop and workspace-level AI gate. The `office_get_workspace_ai_enabled(uuid)` RPC returns a boolean and is executable by authenticated users only; it checks active membership server-side before returning the setting. The workspace/conversation/message RPCs likewise require authenticated execution and membership checks. The private `office-cloud-files` Edge Function is ACTIVE version 5 with JWT verification; its `get_link` action now returns the verified file ID, workspace ID, display name and size to the server-side AI reader, while the signed Bunny URL never reaches the browser AI payload.

The repository's full `pnpm test` suite passed in an isolated sandbox using PostgreSQL 18 for the repository's SQL-backed migration checks. The clean TypeScript/Vite build passed. Production Vercel deployment is currently blocked by the team's HTTP 402 `api-deployments-free-per-day` limit; no production release is claimed for this code until a deployment of the current `main` commit reaches READY.


## Shared workspace AI policy for Docs — 2026-11-09

The Docs writing studio now requires an explicit workspace scope: one authorised Office workspace or **All AI-enabled workspaces (up to 20)**. Its selection edits, prompt-only drafts and confirmed full-document summaries send the scope alongside the user-triggered text. The Vercel `/api/office-ai` handler rechecks the signed-in user's workspace membership with `office_list_workspaces`, then checks `office_get_workspace_ai_enabled` using that user's JWT before calling the model. A missing scope, non-member workspace, or disabled AI setting is rejected before provider access. The all-workspaces option succeeds only when at least one of the first 20 authorised workspaces has AI enabled. The UI is advisory; the server check is authoritative.

The Government correspondence review route is subject to the same workspace AI switch in addition to its existing record eligibility and non-sensitive-text checks. This keeps the owner/admin AI setting consistent across the dedicated COCCE AI chat and Docs writing actions. Local-only documents are not automatically uploaded; the user must still choose what text to send and confirm full-document summaries separately.

These Vercel API changes are on `main` but are not considered production-released until the current commit receives a READY deployment. The separate Supabase `office-ai-chat` Edge Function remains ACTIVE version 13 with JWT verification enabled.
