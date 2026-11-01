# Integration boundaries and required approvals

## Existing COCCE systems inspected read-only

The COCCE Super App source is a Flutter application. Its `SupabaseService`/`AuthProvider` handle email-password, Google ID-token sign-in, PKCE sessions, refresh, and account recovery. The Bunny client sends storage/video work through authenticated Edge Functions. Messaging and Realtime use existing Supabase records; Firebase Messaging handles push; localization and Liquid Glass themes are implemented as Flutter providers/catalogs. These are useful compatibility references, not code that this Vite app imports.

## Required boundaries

COCCE Office must use the same user identity, but this preview intentionally has no login surface or auth client. A production integration requires explicit decisions about allowed OAuth callback URLs, email/password flows, session cookies, and app-specific RLS. Adding a Vercel hostname to a shared Supabase Auth redirect allow-list is an existing service configuration change and must not happen without explicit approval.

No existing public table, function, Firebase project, Bunny folder/rule, or Vercel project was modified. Any eventual database changes must be additive, isolated to a dedicated `office_` namespace, reviewed against existing policies, and tested with separate roles before release. Do not change existing Super App tables, auth behavior, functions, storage paths, FCM behavior, or deployment settings to make Office work.

Bunny API credentials, Supabase service-role credentials, Firebase service credentials, and AI provider keys must remain server-side. The browser must receive only the minimum public Supabase client configuration; every sensitive operation must be validated server-side and through RLS. Office objects need a separate storage prefix and ownership mapping.

## GenOffice

The read-only review found that GenOffice's browser renderer is part of an Electron desktop architecture. Any reused code must be checked package-by-package for web compatibility and license notices. The `ee/` code has a separate license and is not included. This foundation contains no copied GenOffice source.

## Before production work continues

Agree on a dedicated Office schema and additive callback configuration, then add/test migration files without applying them to production until the owner approves the exact change. Configure Office-only storage authorization and server secrets through the deployment secret manager. Implement real end-to-end permission tests using separate accounts, including direct API/RLS tests. Do not point a production alias at this preview.
