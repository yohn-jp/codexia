# Base secret convergence (Phase B)

The standalone lifecycle uses the canonical names referenced by the existing Quadlet and updater runtime. The `secrets` stage adopts matching base credentials, or creates missing ones only before application data or containers exist. It never rotates a credential, deletes a secret, starts a service or edits the controller.

Run as the existing rootless service account with a private inventory and protected control-node files containing exact secret content:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=secrets -e codexia_secrets_approved=true
```

The inventory must declare `codexia_service_user`, `codexia_auth_token_file`, `codexia_tunnel_token_file`, `codexia_postgres_admin_password_file`, and `codexia_postgres_app_password_file`. Passwords must be separate 32-byte hexadecimal strings. An optional final LF is accepted but preserved exactly for equality; do not normalize existing secrets or generate replacements during adoption. All values are read from protected inputs with no-log and no-diff; use private files with restrictive permissions. Existing mismatches, missing secrets on a host with any canonical volume/container, or non-rootless execution fail before creation. The separate existing preflight role and credential remain managed through their dedicated database-aware convergence path; no duplicate role is introduced.

This is an implementation slice of [IAC](../../docs/deployment/IAC.md), not completion of Phase B. Network, volume, PostgreSQL and Tunnel convergence follow separately. Credential rotation, restoration and recovery of a missing secret on existing data require explicit maintenance.
