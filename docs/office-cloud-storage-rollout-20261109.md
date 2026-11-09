# COCCE Office cloud storage rollout status

## Team workspace allowance

New Office Team workspaces now receive a separate 5 GB shared cloud-storage allowance when their cloud quota is initialized. The rollout preserves every quota row already on record. Workspaces that existed before rollout but had not yet created a quota row are given the former 25 GB allowance, so their later first cloud use cannot silently reduce their capacity. Existing cloud files and local originals are not migrated or deleted.

The same quota remains enforced by the existing Office cloud upload reservations. The user interface calls it **Team storage** and clarifies that it is shared only within the selected workspace.

The migration takes exclusive locks on workspace and quota/catalog tables during cutover and fails if it cannot acquire them within 10 seconds. Apply it during a low-traffic period; the live backend currently has one workspace and no cloud file records.

## Personal account storage and pricing

Personal account storage remains a separate, not-yet-available feature. It has no private account-scoped file API, entitlement ledger, customer checkout, recurring subscription handling, or verified-payment provisioning. The confirmed future price list is recorded in `office-cloud-storage-price-list-draft.md`; no customer can buy those add-ons through the current app.

No payment has been made. Bunny object transfers remain untested while provider credits are unavailable. Existing Team storage and COCCE Super App pricing are not changed by this rollout.
