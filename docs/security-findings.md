# Security finding: existing COCCE Supabase tables without RLS

A read-only Supabase catalog/advisor inspection on 2026-11-01 reported **13 existing `public` tables with Row Level Security disabled**: `shop_follows`, `groups`, `group_members`, `story_views`, `cart_items`, `orders`, `order_items`, `story_replies`, `boost_campaigns`, `video_views`, `contact_matches`, `content_vectors`, and `ads_schema_versions`.

The advisor classified this as critical and warned that tables without RLS can be fully exposed through Supabase client roles. No row contents were queried for this finding, and no database changes were made. The user’s isolation instruction means this project must not apply a repair to the existing COCCE schema. Enabling RLS without carefully designed, tested policies can block existing applications; the statements below are the advisor’s RLS-enabling statements only and are **not a complete policy design**.

```sql
ALTER TABLE "public"."shop_follows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."story_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."cart_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."story_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."boost_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."video_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."content_vectors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ads_schema_versions" ENABLE ROW LEVEL SECURITY;
```

Do not run these statements blindly. First review the existing access patterns, define least-privilege policies, then test them against all COCCE clients and backend service roles in a controlled environment. The user must decide whether to authorize any remediation.

## COCCE Office local Vault boundary

The Office Vault is a separate browser-local slice using Web Crypto and encrypted IndexedDB. It does not connect to Supabase, create tables, or enforce multi-user/server-side access policies. AES-GCM authenticates the encrypted payload and version/algorithm/salt/nonce/revision/timestamp metadata; atomic revision checks reject stale saves from another tab instead of silently overwriting new data. These controls do not provide device integrity, protection from a compromised browser, secure sharing, remote audit logs, automatic idle lock, forensic deletion, or recovery if the passphrase is lost. JavaScript does not guarantee immediate memory erasure on lock. Do not describe this slice as an enterprise-secure Vault or use it as a substitute for server-side authorization and tested database policies.
