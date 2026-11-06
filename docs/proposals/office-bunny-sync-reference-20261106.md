# Bunny sync reference findings

## Source

- Repository: [Hilpolith/COCCE_Super_App](https://github.com/Hilpolith/COCCE_Super_App)
- Reviewed commit: `a9b04a49ec02fd2b4a74ff34be4dded78ad19403`
- Relevant files: `lib/services/bunny_service.dart`, `lib/services/unified_upload_service.dart`, `lib/core/utils/bunny_upload_folder.dart`, `lib/providers/upload_state_provider.dart`, `supabase/functions/bunny-upload/index.ts`, `supabase/functions/bunny-delete/index.ts`, and `supabase/functions/_shared/bunny_stream_library.ts`.

## Observed upload and sync behavior

The reference app sends authenticated upload requests through Supabase Edge Functions. The client validates/normalizes a feature folder, gathers file bytes, calls the `bunny-upload` function, and receives a CDN URL. The function verifies the COCCE Auth bearer token, validates the requested folder and filename, enforces file-size bounds, checks signatures for selected image types, and makes the provider request with server-side Bunny configuration. `bunny-delete` is also a server function. The reference uses an allowlist of feature folders and special owner/scope checks for some user- or record-specific paths.

The reference `UnifiedUploadService` describes an app-local upload queue persisted in SQLite, foreground and background processing, pending-upload resume when the app starts or resumes, progress/status events, retry handling for transient failures, and a per-isolate guard against duplicate concurrent processing. This queue is part of COCCE Super App’s media upload flow; it is not a generic COCCE Office document synchronization protocol.

## Important implementation distinction

The reference code is useful for its authenticated server boundary, explicit upload state, resumable/retry concepts, and allowlisted upload scopes. Its general storage upload path sends base64 file bytes to an Edge Function and returns a CDN URL. COCCE Office already has a separate, more tightly scoped Office storage implementation: workspace membership checks, quota reservations, immutable object keys, short-lived signed Bunny transfers, checksum and size verification, metadata-only finalization, append-only audit, file trash/restore and interrupted-upload recovery. Office should extend that path rather than copy the reference’s base64 transport or public-URL behavior.

## Office gaps confirmed during review

The current Office browser API and Docs/Sheets/Slides panels support explicit cloud copies and recovery; they do not implement live automatic sync. The current `office_cloud_begin_upload` creates a new cloud file at revision 1. Although the metadata model has immutable revisions, no existing RPC advances an existing file to a new revision with an expected-current-version check. The current file listing also does not return the revision identity needed for safe conflict detection. Slides currently has an explicit cloud-copy panel; the existing Office cloud review says PDF and Drive have no cloud-copy integration.

To build automatic sync safely, Office needs a version-aware revision RPC and revision-state lookup, idempotent/recoverable upload processing, an explicit per-record opt-in/link (so existing browser-local records are never copied without consent), debounced sync after local saves, conflict preservation rather than last-write-wins, and UI/tests across each supported Office format. The sync should continue to use Office’s signed direct-to-Bunny protocol; it must not send Office credentials or document bytes through untrusted URLs.

## Verification limit

This was a read-only source review. No reference credentials were read or used, no Bunny objects were uploaded or deleted, and no live provider transfer was performed. Bunny credit exhaustion still prevents end-to-end upload verification. This note does not establish legal compliance, provider availability, or that any untested sync feature works in production.
