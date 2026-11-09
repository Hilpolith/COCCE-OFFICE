# COCCE Office rebuild checklist

Status snapshot: 2026-11-09 14:58 UTC  
Repository: `Hilpolith/COCCE-OFFICE`  
Branch: `main`  
Production project: `cocce-office` / `https://cocce-office.vercel.app`

This checklist tracks the user's requested rebuild. A checked item means the relevant source or backend implementation exists; it does not automatically mean the current main revision has passed CI or is live in production.

## 1. Workspace-wide COCCE AI

- [x] Replace the disabled AI destination with a dedicated COCCE AI workspace.
- [x] Support one selected workspace or all AI-enabled workspaces the signed-in user belongs to.
- [x] Recheck workspace membership and workspace AI enablement on the server for every request.
- [x] Search relevant Teams messages with `office_search_ai_messages`; fall back to bounded recent messages only when search returns no matches.
- [x] Exclude deleted messages and mark retrieved Teams/Drive context as untrusted model input.
- [x] Allow workspace owners/admins to disable AI for a workspace.
- [x] Let users disable Teams conversation context independently.
- [x] Require per-request explicit consent before selected private Drive files are sent to the AI provider.
- [x] Verify selected Drive file bytes against the stored SHA-256 digest before using them as context.
- [x] Keep the model pinned to `google/gemma-4-31b-it:free`, with no paid or alternate-provider fallback.
- [ ] Add secure extraction for PDF, DOCX, XLSX and PPTX. Current AI Drive context is limited to supported UTF-8 text files.
- [ ] Add contextual AI actions inside every tab of every specialist suite.
- [ ] Add permission-scoped access to structured sector records, not just Teams messages and selected Drive text files.
- [ ] Add safe, explicit AI actions for approved create/update workflows with human confirmation and audit events.

## 2. Authentication and first-time onboarding

- [x] Branded sign-in and registration panel with COCCE Office identity.
- [x] Email/password sign-in, registration, email confirmation, recovery and local sign-out.
- [x] Google OAuth callback uses the COCCE Office origin rather than the COCCE Super App origin.
- [x] Add a first-workspace setup step with organisation name, description and Office suite selection.
- [x] Persist the selected suite in server-side workspace metadata.
- [ ] Verify the Supabase Auth redirect allowlist includes the production Office callback; the project API available here does not expose this setting.
- [ ] Run a real Android Google sign-in test on a device and verify the callback returns to COCCE Office.
- [ ] Extend first-time onboarding to collect optional team invitations and custom job titles before finishing setup. The existing Team & Collaboration invitation flow supports this after workspace creation.

## 3. Multi-workspace architecture

- [x] Add persistent workspace-to-suite metadata in `office_workspace_suites`.
- [x] Apply the migration to the existing COCCE Supabase project.
- [x] Enable RLS and remove direct anon/authenticated table reads; expose suite metadata through membership-checked SECURITY DEFINER RPCs.
- [x] Add a global workspace selector to the top bar.
- [x] Connect workspace selection to the specialist suite dashboard.
- [x] Synchronise selected workspace context with Team & Collaboration, COCCE AI and Cloud Drive.
- [x] Clear stale workspace state when the authenticated account changes or access is revoked.
- [ ] Make Docs, Sheets, Slides, PDF, Vault and every remaining tool server-workspace-scoped.
- [ ] Replace browser-local-only document state with workspace-owned cloud persistence, version history and recovery.
- [ ] Ensure switching workspaces changes all data views without mixing local or private records.

## 4. Ten specialist Office suites

Distinct specialist components and tab structures are present for government, schools, universities, business, accounting, manufacturing, healthcare administration, hospitality, institutions and NGOs.

- [x] Keep the ten specialist modules separate rather than replacing them with one generic task screen.
- [x] Provide server-backed workspace association for the selected industry suite.
- [ ] Audit each suite independently for its dashboard, tabs, real CRUD workflows, validation, search, pagination, audit history and empty/error states.
- [ ] Verify role/permission matrices for owner, administrator, manager, supervisor, officer and member.
- [ ] Verify every module's data isolation and RLS with synthetic cross-workspace tests.
- [ ] Add a compact, context-aware COCCE AI action to every tab.
- [ ] Ensure each AI action uses only the selected workspace's authorised records and selected files.
- [ ] Complete sector-specific acceptance tests and do not label a suite complete while it relies on placeholder or browser-local data.

## 5. Drive and file previews

- [x] Keep browser-local storage separate from private Cloud Drive.
- [x] Scope Cloud Drive to the globally selected server workspace.
- [x] Retain private Bunny-backed file operations through the authenticated Office Cloud Files function.
- [x] Support in-app previews for common media, PDF, text and DOCX paths already implemented in the app.
- [ ] Split the file filters into distinct tabs for Documents, Spreadsheets, Presentations, PDFs, Images, Video, Audio and Other.
- [ ] Add in-app XLSX/ODS spreadsheet preview with sheets, rows, columns and safe cell rendering.
- [ ] Add in-app PPTX/ODP presentation preview with slide navigation.
- [ ] Improve DOCX/PDF previews, including large-file handling, page navigation and accessibility.
- [ ] Add preview tests for unsupported, malformed, encrypted and oversized files.
- [ ] Keep local files local unless the user explicitly uploads them.

## 6. Docs document editor

- [x] Keep the existing Tiptap-based editor and document safety/sanitisation boundaries.
- [x] Retain tables, review comments, undo/redo, find/replace, Markdown and DOCX import/export paths already present.
- [x] Add safe font family, font size, text colour, highlight, paragraph alignment and validated link controls.
- [x] Simplify the document AI sidebar into a compact task-first COCCE AI assistant.
- [ ] Reorganise the growing toolbar into a tabbed ribbon so the editor gains functionality without putting every button on screen at once.
- [ ] Add functional Insert, Layout, References, Review and View ribbon groups.
- [ ] Add image insertion, page breaks, page size, margins, orientation, headers/footers and page numbers.
- [ ] Add document outline/navigation, word count, zoom and print/page view.
- [ ] Add references, footnotes, captions, table of contents and citation tools.
- [ ] Add tracked changes and accept/reject workflows.
- [ ] Preserve supported formatting through DOCX import/export and test round-trip fidelity.
- [ ] Make documents workspace-owned, cloud-saved and recoverable instead of relying on local-only content and manual snapshots.

## 7. UI simplification and visual foundation

- [x] Improve the auth panel branding, logo, spacing and responsive layout.
- [x] Add the global workspace selector.
- [x] Simplify the document AI sidebar and workspace selection.
- [ ] Reduce unnecessary global buttons and duplicate navigation actions.
- [ ] Use contextual toolbars, overflow menus and progressive disclosure without hiding essential actions.
- [ ] Apply one consistent liquid-glass component system to cards, buttons, dialogs, popovers, toggles, dock and top bar.
- [ ] Validate mobile and desktop layouts and retain a readable solid-surface accessibility fallback.
- [ ] **Deferred by user:** create or source the scalable glass-texture base image. Do not generate or substitute a flat-colour asset in this stage.

## 8. GenOffice code reuse and licensing

- [x] Inspect `genspark-ai/genoffice` and verify its repository licensing.
- [x] Identify the React/Tiptap document ribbon, AI panel and OOXML engine as useful reference points.
- [ ] Reuse only eligible Apache-2.0 code outside the separately licensed `ee/` area, preserving required license/NOTICE attribution.
- [ ] Port only browser-compatible UI/engine modules; replace Electron file-system and IPC paths with COCCE workspace and Bunny-backed APIs.
- [ ] Do not copy Genspark branding, logos or trademarks.

## 9. Validation and release gate

- [x] Keep all application code changes on `main` in `Hilpolith/COCCE-OFFICE`.
- [x] Verify `office-ai-chat` is ACTIVE version 18 with JWT verification enabled.
- [x] Verify `office-cloud-files` is ACTIVE version 8 with JWT verification enabled.
- [x] Verify the workspace suite table has RLS enabled and no direct anon/authenticated SELECT grant.
- [x] Verify suite and AI search RPCs are SECURITY DEFINER with an empty search_path, executable by authenticated users and not anon.
- [ ] Wait for a successful full GitHub Actions run covering unit, integration, sector acceptance and production build for the current main code.
- [ ] Create a Vercel production deployment from the exact validated main SHA.
- [ ] Confirm that deployment reaches READY and the production alias serves its assets.
- [ ] Smoke-test auth, Android OAuth, workspace creation/switching, Team, AI, Drive, Docs and the ten specialist suite routes.
- [ ] Record the final deployment SHA, deployment ID, test run and any known limitations.

## Current release warning

The latest READY Vercel production deployment currently recorded for this project is built from commit `465590d5d03ba7d572f82a961a46ca7d613c1291`, not the current main source. The last documented deployment attempt was rejected with Vercel HTTP 402 `api-deployments-free-per-day`. Therefore the current main changes must not be described as production-released until a deployment built from the validated current main SHA reaches READY and the live alias is verified.
