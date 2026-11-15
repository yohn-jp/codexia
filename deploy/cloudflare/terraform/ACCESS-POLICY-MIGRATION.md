# Shared Access policy migration

Supply `access_policy_id` for the existing account-owned reusable Allow policy. For ZENPRAX, use `7ea377b8-7f00-4273-9fba-dbc01bdabf21` (Allow-ZENPRAX team). Verify the policy's identity rules and inherited session duration before applying. Remove the old `allowed_emails` input from local tfvars and automation. Terraform 1.7+ is required for the non-destructive `removed` block. Back up state, run plan, and verify the old policy is forgotten without destruction and the application attaches the shared policy at precedence 1. Do not apply an older revision after the live migration. The CI identity applications are managed by this module; the reusable Service Auth policy remains account-owned. Before applying the first revision that adds these resources, supply `ci_access_policy_id` and import the existing applications (see below). Preserve their IDs and audiences. Delete the obsolete policy only after all application references are removed. Never import the shared policy into this module's ownership.

## Adopt existing CI identity applications

Set `ci_access_policy_id` to the existing reusable Service Auth policy (ZENPRAX: `79278a25-76f8-494b-8aee-d3381a70fcab`). It must select only the dedicated CI service token. Do not create a second token, rotate credentials, or attach this policy to the hostname-wide author application.

In the existing private Terraform state, import each application before planning:

```sh
terraform import 'cloudflare_zero_trust_access_application.ci_identity["backend"]' '<account-id>/<existing-backend-identity-app-id>'
terraform import 'cloudflare_zero_trust_access_application.ci_identity["frontend"]' '<account-id>/<existing-frontend-identity-app-id>'
```

For the existing ZENPRAX deployment, the backend and frontend application IDs are respectively `5f5c9d0c-5f67-40c2-a6e6-1ec127dcfaab` and `33639d42-6c4f-4355-9fc8-cdc4adbf389f`. Verify IDs against live state first. Review the plan for no application replacement and no unrelated routing or policy changes. The two exact path ingress rules precede the hostname catch-all, each accepts its own audience and the author audience, and the catch-all accepts only the author audience. Static assets continue to serve the frontend identity when the UI route is active; the Tunnel rule preserves origin fallback.

Do not apply the former Terraform declaration: it omits both identity ingress rules. After adoption, use the protected release preflight to exercise both identity endpoints with the actual CI credentials, then validate browser authorization separately. Terraform validation alone does not prove live credentials or policy membership.
