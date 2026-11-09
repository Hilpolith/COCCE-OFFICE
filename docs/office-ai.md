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

The separate COCCE AI destination can now be scoped to one workspace or **All authorised workspaces**. Workspace context is optional and can be turned off before sending a prompt. The Edge Function validates the signed-in COCCE user and checks workspace membership through `office_list_workspaces`, then checks each workspace's AI switch. It first retrieves prompt-relevant Teams excerpts through `office_search_ai_messages`, a membership-checked full-text search RPC that excludes deleted messages and conversations the user cannot read. If the query finds no matches, it falls back to recent messages fetched through the membership-aware `office_list_conversations` and `office_list_rich_messages` RPCs, excluding deleted messages. The browser never supplies conversation IDs or message contents as trusted context.

For bounded requests, all-workspaces mode searches up to 20 authorised workspaces, requesting up to eight ranked matches per workspace; if there are no matches anywhere, the fallback samples up to two conversations and three recent messages per workspace. The final Teams/Drive prompt context is capped at 24 entries, and each message excerpt is truncated to 1,200 characters. Every excerpt is labelled as untrusted context; messages and files cannot override system instructions. Context is not written back into chats. The request cap remains 12 per user per 10-minute warm Edge Function instance, and the model remains pinned to the free Google Gemma endpoint with paid fallback disabled.

COCCE AI now supports **explicitly selected** private Drive text-file context. The user chooses up to three `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.yml`, or `.log` files in the AI workspace picker. The browser sends only file IDs. Before the request, the UI shows an explicit confirmation naming the selected files and explains that their extracted text and prompt will be sent to OpenRouter's Google AI Studio free-model provider; no file content is sent until the user confirms. The Edge Function calls `office-cloud-files` with the caller's JWT, verifies the file belongs to an AI-enabled workspace in the selected scope, obtains a short-lived private Bunny download URL, and fetches the bytes server-side. Each file is limited to 512 KiB and 8,000 characters, with 20,000 characters total; the server verifies the stored byte count and SHA-256 digest before decoding UTF-8, and rejects invalid UTF-8 or binary/null-byte content. File excerpts are labelled as untrusted context. No Drive files are scanned automatically. PDF, DOCX, XLSX, PPTX, Slides image assets, Vault items, private sector records and local browser files are not included in AI context yet. The feature does not run unattended automations. If team conversation history is switched off, team messages are omitted but explicitly selected Drive files remain attached. In Chats, allowlisted image, video and audio attachments can be previewed in place; voice notes are playable and show a locally generated waveform when browser audio decoding is supported. Other file types remain downloadable without being rendered inline.

The Edge Function is deployed as `office-ai-chat` with JWT verification enabled. The November 2026 deployment uses the membership-aware workspace RPCs and has no service-role credential in the browser.


Workspace owners and administrators can disable or re-enable COCCE AI per workspace in Team & Collaboration. The setting is stored on the workspace, not in browser state. The AI Edge Function checks it for every workspace in the selected scope; disabled workspaces are excluded, and a request is rejected if no enabled workspace remains. Members can see the setting but cannot change it. Context-off requests still respect the workspace AI setting.


## Deployment verification — 2026-11-09

The current workspace-wide Edge Function is ACTIVE as version 16 in the existing COCCE Supabase project, with `verify_jwt=true`. Its deployment was inspected after release and includes the all-authorised-workspaces loop and workspace-level AI gate. The `office_get_workspace_ai_enabled(uuid)` RPC returns a boolean and is executable by authenticated users only; it checks active membership server-side before returning the setting. The workspace/conversation/message RPCs likewise require authenticated execution and membership checks. The private `office-cloud-files` Edge Function is ACTIVE version 8 with JWT verification; its `get_link` action now returns the verified file ID, workspace ID, display name, size and SHA-256 digest to the server-side AI reader, while the signed Bunny URL never reaches the browser AI payload.

The repository's full `pnpm test` suite passed in an isolated sandbox using PostgreSQL 18 for the repository's SQL-backed migration checks. The clean TypeScript/Vite build passed. Production Vercel deployment is currently blocked by the team's HTTP 402 `api-deployments-free-per-day` limit; no production release is claimed for this code until a deployment of the current `main` commit reaches READY.


## Shared workspace AI policy for Docs — 2026-11-09

The Docs writing studio now requires an explicit workspace scope: one authorised Office workspace or **All AI-enabled workspaces (up to 20)**. Its selection edits, prompt-only drafts and confirmed full-document summaries send the scope alongside the user-triggered text. The Vercel `/api/office-ai` handler rechecks the signed-in user's workspace membership with `office_list_workspaces`, then checks `office_get_workspace_ai_enabled` using that user's JWT before calling the model. A missing scope, non-member workspace, or disabled AI setting is rejected before provider access. The all-workspaces option succeeds only when at least one of the first 20 authorised workspaces has AI enabled. The UI is advisory; the server check is authoritative.

The Government correspondence review route is subject to the same workspace AI switch in addition to its existing record eligibility and non-sensitive-text checks. This keeps the owner/admin AI setting consistent across the dedicated COCCE AI chat and Docs writing actions. Local-only documents are not automatically uploaded; the user must still choose what text to send and confirm full-document summaries separately.

These Vercel API changes are on `main` but are not considered production-released until the current commit receives a READY deployment. The separate Supabase `office-ai-chat` Edge Function remains ACTIVE version 16 with JWT verification enabled.


## Current deployed functions after native Docs/Sheets context — 2026-11-09

- `office-ai-chat` is ACTIVE at version 19 with JWT verification enabled. The deployed bundle includes `drive-context.ts`, which validates and extracts supported plain-text files and native COCCE Docs/Sheets cloud-copy envelopes.
- `office-cloud-files` is ACTIVE at version 8 with JWT verification enabled. The shared origin validator now governs both normal requests and OPTIONS preflights, including the linked COCCE Office Vercel preview hostname.
- Production Vercel environment flags `VITE_OFFICE_TEAM_SCHEMA_READY` and `VITE_OFFICE_CLOUD_FILES_READY` are both enabled.
- The selected Drive context tests now cover native Docs/Sheets extraction and rejection of unsafe embedded Docs content in addition to workspace scoping, Bunny URL validation, size bounds and SHA-256 verification. The newest relevant GitHub Actions attempts were cancelled while `main` continued receiving concurrent commits; a successful full-suite run has not yet been confirmed.
- The Vercel production alias has not been updated to these source changes because the team's deployment API quota returned HTTP 402 `api-deployments-free-per-day`. Keep this release marked unreleased until the current main commit has a READY production deployment.


## Latest integrity and CI checkpoint — 2026-11-09 11:19 UTC

The private Cloud Drive link response now includes the stored SHA-256 digest from the verified revision. COCCE AI compares the server-fetched Bunny bytes against that digest before decoding or adding any excerpt to model context. Native Docs HTML is reduced to plain text after rejecting embedded active content; Sheets cells are read as literal strings and formulas are never evaluated. The Cloud Drive Edge Function is ACTIVE at version 8 and COCCE AI is ACTIVE at version 16; both still require JWT verification. The Drive-context test suite now covers the SHA-256 match and mismatch paths.

GitHub Actions run `42607472160` completed successfully for an earlier main revision and executed both the full test command and production build. The latest main commit `f3c29c2d0ef353c980aa75012d686cb101382e60` has its own full validation run queued as `42608122219`; wait for that run to complete before treating the latest SHA as fully verified. Vercel production deployment remains blocked by the team's HTTP 402 `api-deployments-free-per-day` limit.


## COCCE AI workspace chat and Drive context — 2026-11-09 follow-up

The dedicated COCCE AI workspace now searches relevant Teams messages across the signed-in user's first 20 AI-enabled workspaces by calling office_search_ai_messages with the user's prompt. The SQL function rechecks active workspace membership and conversation read access, excludes deleted messages, ranks matching excerpts, and returns bounded text. If no search matches are found, the Edge Function falls back to recent rich messages from conversations the user can read and filters out deleted messages before constructing context. The user can disable Teams context independently.

The source for the already-applied 20261109104406_office_ai_message_search migration was restored to supabase/migrations/20261109104406_office_ai_message_search.sql because it was present in the shared database migration history but missing from the repository. The migration was NOT re-applied to the shared COCCE database. Its SECURITY DEFINER RPC explicitly checks auth.uid(), active workspace membership, and per-conversation read permission; execution is revoked from PUBLIC and anon, and granted to authenticated and service_role.

Selected Drive content now requires a separate, per-request confirmation before the browser sends selected file IDs to the Edge Function. The confirmation explains that file contents are fetched from private Bunny-backed Office Drive and sent to OpenRouter's pinned Google AI Studio free-model provider, and that this is not a zero-data-retention guarantee. The server still resolves the file through the caller's JWT, verifies workspace AI enablement, checks the Bunny URL and SHA-256 digest, and applies the existing limits: up to three files, 512 KiB per file, 8,000 extracted characters per file, and 20,000 characters total. Only UTF-8 text formats supported by drive-context.ts are included; PDF, DOCX, XLSX, PPTX and binary files are not sent to chat AI.

The dedicated office-ai-chat Edge Function was redeployed as ACTIVE version 17 with JWT verification enabled. It remains pinned to google/gemma-4-31b-it:free and the google-ai-studio provider, with paid/alternate-provider fallback disabled and a zero-cost response check. This chat endpoint is distinct from the Docs writing API.

Office Chats already supports Bunny-backed attachment upload/download, voice recording, message editing, replies, deletion, read markers, Supabase Realtime change subscriptions and a 15-second polling fallback. The follow-up adds safe inline image/video/audio previews; audio previews attempt to decode a local waveform, and temporary object URLs are revoked when previews close, conversations change, or the panel unmounts. These previews are client-side and do not move file storage into Supabase.

The new regression checks are included in the repository's pnpm test command. The full CI run for the current main head is still pending; do not treat these changes as fully validated until the run completes successfully. The Vercel production alias remains unreleased until a READY production deployment built from the exact latest main commit is confirmed.

## Live backend verification — 2026-11-09

The existing `office-ai-chat` Edge Function was redeployed after the workspace-aware Teams search change. Current live status: ACTIVE version 19 with JWT verification enabled. The deployed source includes permission-checked `office_search_ai_messages` retrieval and the explicit-consent selected-Drive context flow. The supporting `20261109104406_office_ai_message_search` migration is already applied; it was not re-applied during this deployment. Version 19 also supports explicitly selected native COCCE Docs/Sheets snapshots in addition to supported UTF-8 text files. Standard PDF/DOCX/XLSX/PPTX extraction is still outstanding. The function remains pinned to `google/gemma-4-31b-it:free` with no paid or alternate-provider fallback.


## External AI provider retention and free-tier limits

The pinned free endpoint is currently listed by OpenRouter as Google AI Studio. OpenRouter's provider directory currently lists Google AI Studio as **not training on prompts** but retaining prompts for **55 days**. The UI's Drive consent dialog discloses this before selected file content is sent. Do not describe this integration as zero-retention or suitable for confidential/regulated records without a separate privacy and legal review.

OpenRouter's free `:free` model variants are rate-limited. Its current documentation lists 20 requests per minute and 50 requests per day for accounts below the $10 cumulative-credit threshold (up to 1,000/day after that threshold). COCCE Office also applies its own per-user request guard. Free-model availability and upstream limits can change; no paid-model or alternate-provider fallback is enabled.
