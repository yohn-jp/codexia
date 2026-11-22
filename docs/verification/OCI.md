# OCI build and startup verification

The root `Dockerfile` builds Core and Full profiles of one application container. Runtime packages include the compiled API and browser assets, CA certificates and required runtime dependencies. The image runs as UID 1000 and listens on port 3000. Core excludes optional analysis and model dependencies; Full includes its selected trusted module packages.

Every API startup requires PostgreSQL. The OCI verification script creates an isolated network and PostgreSQL sidecar, applies checked migrations, registers a Better Auth owner and OAuth clients, and checks authorization alongside health, assets, profile metadata, nonroot execution, writable scratch data and graceful shutdown. It removes the fixture containers and network on exit.

```sh
CODEXIA_PROFILE=core bash scripts/verify-oci.sh
CODEXIA_PROFILE=full bash scripts/verify-oci.sh
```

For a standalone installation, apply application migrations to private PostgreSQL and follow [Better Auth runtime provisioning](../../deploy/ansible/AUTH-RUNTIME.md) and [protected activation](../deployment/PUSH-DEPLOYMENT.md#first-application-activation). `/data` holds derived module caches, and `/history` holds private usage and job history. Give each container its own writable volumes and use a trusted HTTPS reverse proxy beyond localhost.

Podman is the default when available. Set `OCI_ENGINE`, `CODEXIA_OCI_IMAGE` and `CODEXIA_OCI_PORT` to override the engine, local image tag and host port; Docker remains supported. Provision engine trust through the host's normal administration; the verification procedure does not alter host trust configuration.

The production dependency audit rejects build/test tools in runtime closure. Core auditing additionally rejects optional NLP, model-provider, tokenizer, embedding, reranker and speaker dependencies in packages or compiled imports. The local `pnpm audit:core` command allows development tools installed for source work, so it does not substitute for the image's production audit.

For hosted assignments and PostgreSQL configuration, use [Hosted deployment](../HOSTED-DEPLOYMENT.md). For immutable image publication, use [OCI releases](OCI-RELEASE.md).
