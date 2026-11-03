# COCCE Office Docs AI

## What the writing studio does

The Docs writing studio provides user-triggered tools for summarizing, proofreading, quality checks, clarity and concision edits, expansion, key points, action items, outlines, email rewrites, custom instructions, and new drafts. Draft starters cover email, meeting notes, project briefs, proposals, and report outlines. Users can save up to 12 reusable instruction recipes in this browser and run them on a selected excerpt.

Every response is shown as a preview. Nothing is inserted or replaces text until the user chooses **Insert at cursor** or **Replace selection**. The resulting edit uses the normal Tiptap history and local autosave, so the existing Undo control can reverse it.

## What leaves the browser

No document is uploaded or indexed automatically. For rewrite/review actions, the user must select text in the editor and click an action; only that selected plain-text excerpt is included in the request, capped at 8,000 characters. A draft action sends only the prompt typed into the draft form and never includes the current editor selection. Custom and saved workflows send the instruction plus the selected excerpt. Document title, document ID, workspace, local storage, and the rest of the document are not in the request schema.

Saved workflow names and instructions are stored under the Office-specific `cocce-office-ai-workflows-v1` browser key. They are not synced to the server unless a user explicitly runs a workflow, in which case its instruction and selected excerpt are sent for that one action. No background jobs or unattended automations run.

## Provider, free model, and fallback safety

`api/office-ai.js` pins the server-side model ID `google/gemma-4-31b-it:free`. The current public OpenRouter catalog lists this as a text-capable free variant with zero prompt and completion prices, 262,144-token context, and `max_tokens` support. OpenRouter documents `:free` as a separate catalog variant with its own prices and availability; free endpoints can be rate-limited or temporarily unavailable. See the [OpenRouter free-variant guide](https://openrouter.ai/docs/guides/routing/model-variants/free), [model catalog](https://openrouter.ai/api/v1/models?limit=500), and [model endpoint details](https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints).

The model is not supplied by the browser. The server sends only this one fixed model ID, includes no alternate-model list, restricts OpenRouter to the exact `google-ai-studio` provider slug with `provider.only`, sets `provider.allow_fallbacks` to `false`, and rejects a response whose model ID does not exactly match the fixed `:free` ID or whose reported cost is positive. If the endpoint is missing, rate-limited, or unavailable, the route returns a temporary-unavailable message and does not select a paid model or alternate provider. The user can retry after a short wait. OpenRouter documents `provider.only` as the allowlist for request-level provider routing in its [provider-selection guide](https://openrouter.ai/docs/guides/routing/provider-selection).

The route uses OpenRouter's Chat Completions API with a bounded output. Its provider key is stored only in the Vercel server environment as `OPENROUTER_API_KEY`; it is never given a `VITE_` name, bundled in client code, logged, or stored in browser storage. The route checks the bearer token with the existing COCCE Supabase Auth service, enforces an allowlist of action fields and size limits, and applies a short-window per-user in-memory request cap on each warm function instance (not a global quota). It does not persist content and logs no prompt, selection, response text, raw provider error body, or credential.

## Provider privacy disclosure

A user action sends the selected excerpt or typed drafting prompt through OpenRouter to the model provider. OpenRouter says it does not store prompts or responses unless an account opts into input/output logging or product use, but it keeps request metadata and may anonymously categorize a small sample. Provider data policies can differ. OpenRouter's current provider-logging page lists Google AI Studio as retaining prompts for 55 days and not training on them; its provider policies may change. This Office route does not claim zero-data retention and currently does not request OpenRouter's `zdr` or `data_collection: deny` filters; synthetic preflight attempts with those additional filters did not produce a successful response. The Docs panel discloses the provider policy; users should send only text they are permitted to share with a cloud service.

Sources: [OpenRouter data-collection policy](https://openrouter.ai/docs/guides/privacy/data-collection), [provider logging policies](https://openrouter.ai/docs/guides/privacy/provider-logging), [request-level provider controls](https://openrouter.ai/docs/guides/routing/provider-selection), [Zero Data Retention guide](https://openrouter.ai/docs/guides/features/zdr), and [Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

## Limits and related work

This is a bounded set of on-demand Docs writing tools, not a general workflow engine. There is no document-wide summarization, automatic background scanning, scheduled automation, cloud document storage, collaborative editing, comments, tracked changes, or external app action. The separate Automations page remains informational and does not run model calls. The feature uses public productivity concepts only; no GenOffice source code, especially code from `ee/`, is included.

Local validation includes `src/lib/officeAi.test.ts` for selection/request and local workflow contracts, `src/OfficeAiWriter.test.tsx` for preview and unavailable-state behavior, and `scripts/office-ai-api-check.mjs` for mocked API auth, field allowlisting, limits, rate limiting, fixed-model routing, and error handling. Mocked tests do not send document content to a provider.

A controlled production smoke on 2026-11-03 with an existing COCCE test account confirmed that the AI route is configured and authenticated; the synthetic selected-text request returned `503 FREE_MODEL_UNAVAILABLE` without generated text, while a direct synthetic preflight returned HTTP 429. The UI reports this temporary outage and the server does not switch to a paid model or alternate provider. Treat successful generation as unverified until the pinned free endpoint becomes available; no real document content was used.

Vercel's function platform has an independent request limit ([Function limits](https://vercel.com/docs/functions/limitations)); this route rejects JSON bodies above 40 KB and checks `Content-Length` early when available.
