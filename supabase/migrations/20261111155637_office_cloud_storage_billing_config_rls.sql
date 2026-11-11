-- Keep the private Office storage billing switch inaccessible through the public Data API.
alter table public.office_cloud_storage_billing_config enable row level security;
revoke all on table public.office_cloud_storage_billing_config from public, anon, authenticated;
