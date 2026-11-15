# Shared Access policy migration

Supply `access_policy_id` for the existing account-owned reusable Allow policy. For ZENPRAX, use `7ea377b8-7f00-4273-9fba-dbc01bdabf21` (Allow-ZENPRAX team). Verify the policy's identity rules and inherited session duration before applying. Remove the old `allowed_emails` input from local tfvars and automation. Terraform 1.7+ is required for the non-destructive `removed` block. Back up state, run plan, and verify the old policy is forgotten without destruction and the application attaches the shared policy at precedence 1. Do not apply an older revision after the live migration. The CI identity applications are managed by this module; their reusable Service Auth policy remains account-owned. Supply `access_ci_policy_id` (ZENPRAX: `79278a25-76f8-494b-8aee-d3381a70fcab`) and import both existing applications before planning. Preserve their AUDs; never attach Service Auth to the parent application. Delete the obsolete policy only after all application references are removed. Never import the shared policy into this module's ownership.

## Adopt existing CI identity applications

Back up private Terraform state. In ZENPRAX, the backend probe application ID is `5f5c9d0c-5f67-40c2-a6e6-1ec127dcfaab`; frontend is `33639d42-6c4f-4355-9fc8-cdc4adbf389f`. Import the existing applications (not the account-owned policies) with the same private tfvars:

```sh
terraform import 'cloudflare_zero_trust_access_application.identity_probe["backend"]' "accounts/$ACCOUNT_ID/$BACKEND_PROBE_APP_ID"
terraform import 'cloudflare_zero_trust_access_application.identity_probe["frontend"]' "accounts/$ACCOUNT_ID/$FRONTEND_PROBE_APP_ID"
terraform plan
```

Require a non-destructive plan preserving the two AUDs and author-only parent. The exact-path Tunnel rules in `identity-probes.json` must precede the catch-all; only each path's own probe AUD and the author AUD are admitted there. Confirm the shared CI policy selects only the designated service token. Run the protected production preflight before and after changes. Never apply a plan that replaces existing apps or broadens Service Auth to other paths.
