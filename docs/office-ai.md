# COCCE Office Docs AI

## What the writing studio does

The Docs writing studio provides user-triggered tools for summarizing, proofreading, quality checks, clarity and concision edits, expansion, key points, action items, outlines, email rewrites, custom instructions, and new drafts. Draft starters cover email, meeting notes, project briefs, proposals, and report outlines. Users can save up to 12 reusable instruction recipes in this browser and run them on a selected excerpt.

The tool previews every response. Nothing is inserted or replaces text until the user chooses **Insert at cursor** or **Replace selection**. The resulting edit uses the normal Tiptap history and local autosave, so the existing Undo control can reverse it.

## What leaves the browser

No document is uploaded or indexed automatically. For rewrite/review actions, the user must select text in the editor and click an action; only that selected plain-text excerpt is included in the request. The excerpt is limited to 8,000 characters. A draft action sends only the prompt typed into the draft form and never includes the current editor selection. Custom and saved workflows send the instruction plus the currently selected excerpt. Document title, document ID, workspace, local storage, and the rest of the document are not part of the request schema.

Saved workflow names and instructions are stored under the Office-specific `cocce-office-ai-workflows-v1` browser key. They are not synced to the server unless a user explicitly runs a workflow, in which case its instruction and selected excerpt are sent for that one action. No background jobs or unattended automations run.

## Server boundary

`api/office-ai.js` is a same-origin Vercel function. It verifies the bearer token with the existing COCCE Supabase Auth endpoint, accepts only a bounded allowlist of action fields, rejects JSON request bodies larger than 40 KB and all document metadata or extra content fields, applies a short-window per-user in-memory request limit, and calls OpenAI's efficient [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna) with `reasoning_effort: "none"` and a fixed output limit. Vercel independently caps function request payloads at 4.5 MB ([Vercel Function limits](https://vercel.com/docs/functions/limitations)); the route's 40 KB cap is enforced inside the application, with an early check when `Content-Length` is available. The function does not use a service-role key, does not write request/response text to a database, and does not log content or credentials. The OpenAI request uses `store: false` ([Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)); OpenAI still receives the explicit excerpt or prompt in order to generate a response.

Availability checks are authenticated and contain no document content. AI controls stay disabled when the existing COCCE Auth session is absent or when the server reports that its API key is not configured. The OpenAI key must be added only as a sensitive server-side Vercel environment variable named `OPENAI_API_KEY`; it must not use a `VITE_` prefix, appear in frontend code or bundles, or be stored in Office documents or browser storage.

## Limits and related work

This is a first, bounded set of on-demand writing tools—not a general workflow engine. There is no document-wide summarization, automatic background scanning, scheduled automation, cloud document storage, collaborative editing, comments, tracked changes, or OpenAI file upload. The feature borrows public productivity concepts only; no GenOffice source code, especially code from `ee/`, is included.

Local validation includes `src/lib/officeAi.test.ts` for selection/request and local workflow contracts and `scripts/office-ai-api-check.mjs` for mocked API auth, field allowlisting, limits, rate limiting, provider isolation, and error handling. Those tests do not transmit document content or make a live OpenAI request.
