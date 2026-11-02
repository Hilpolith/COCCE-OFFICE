# Integration boundaries and required approvals

## Existing COCCE systems inspected read-only

The COCCE Super App source is a Flutter application. Its `SupabaseService`/`AuthProvider` handle email-password, Google ID-token sign-in, PKCE sessions, refresh, and account recovery. The Bunny client sends storage/video work through authenticated Edge Functions. Messaging and Realtime use existing Supabase records; Firebase Messaging handles push; localization and Liquid Glass themes are implemented as Flutter providers/catalogs. These are useful compatibility references, not code that this Vite app imports.

## Required boundaries

COCCE Office uses the existing COCCE Auth project and identities through its own Supabase JavaScript browser client, restricted to project reference `nresyncmhdybucenhxbw` (`https://nresyncmhdybucenhxbw.supabase.co`). It accepts only a public anon/publishable key, uses a separate browser storage key, permits email/password sign-in for existing accounts only, provides no sign-up, and signs out with local scope so other app sessions remain untouched. The committed `.env.example` contains placeholders only; any actual key used for local verification stays in an ignored local env file and is never committed or pushed. The production-only Office schema gate enables the approved collaboration release; local examples default to false. No OAuth callback, shared Auth redirect allow-list, or Auth setting may be changed as a workaround without separate explicit approval.

No existing public COCCE table/function, Auth setting, RLS policy, Realtime publication, Firebase project, Bunny folder/rule, or shared service was modified. The owner-approved Office migration is applied and adds only namespaced `office_*` tables/functions and Office-owned policies; existing COCCE rows and policy definitions stay untouched. Controlled tests used existing COCCE test accounts and cleaned the disposable Office workspace. The existing `cocce-office` Vercel project is the only deployment configuration changed: only required Office production variables are set, while SSO, aliases, and domains remain unchanged. No other app or Vercel project is changed.

Bunny API credentials, Supabase service-role credentials, Firebase service credentials, and AI provider keys must remain server-side. The browser must receive only the minimum public Supabase client configuration; every sensitive operation must be validated server-side and through RLS. Office objects need a separate storage prefix and ownership mapping.

## GenOffice

The read-only review found that GenOffice's browser renderer is part of an Electron desktop architecture. Any reused code must be checked package-by-package for web compatibility and license notices. The `ee/` code has a separate license and is not included. This foundation contains no copied GenOffice source.

## Remaining release boundaries

The applied Office schema uses bounded polling instead of the shared Realtime publication. Do not add a separate Auth provider, service-role browser key, account-creation flow, or shared Auth redirect. Office file storage/sharing remains unimplemented; any future storage must have its own authorization boundary and server-side credentials. The other productivity modules remain browser-local and are not made collaborative by this release.
