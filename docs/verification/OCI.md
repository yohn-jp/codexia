# OCI build and startup verification

The root `Dockerfile` builds Core and Full profiles of one application container. Runtime packages include the compiled API and browser assets, CA certificates and required runtime dependencies. The image runs as UID 1000 and listens on port 3000. Core excludes optional analysis and model dependencies; Full includes its selected trusted module packages.

Every API startup requires PostgreSQL. The OCI verification script creates an isolated network and PostgreSQL sidecar, applies the checked migrations, starts the application against it, checks health/readiness, HTML and built assets, profile/module metadata, nonroot execution, writable scratch data and graceful shutdown, then removes both containers and the network.

```sh
CODEXIA_PROFILE=core bash scripts/verify-oci.sh
CODEXIA_PROFILE=full bash scripts/verify-oci.sh
```

For a manual run, provide `CODEXIA_DATABASE_URL` for a private PostgreSQL database and apply migrations before starting the image. Standalone mode also requires `CODEXIA_AUTH_TOKEN`. The runtime uses PostgreSQL for authoring state; `/data` holds derived module caches, while `/history` holds private usage/job history. Do not share one writable cache/history volume between containers. Use a trusted HTTPS reverse proxy beyond localhost.

Podman is the default when available. Set `OCI_ENGINE`, `CODEXIA_OCI_IMAGE` and `CODEXIA_OCI_PORT` to override the engine, local image tag and host port; Docker remains supported. Provision engine trust through the host's normal administration; the verification procedure does not alter host trust configuration.

The production dependency audit rejects build/test tools in runtime closure. Core auditing additionally rejects optional NLP, model-provider, tokenizer, embedding, reranker and speaker dependencies in packages or compiled imports. The local `pnpm audit:core` command allows development tools installed for source work, so it does not substitute for the image's production audit.

For hosted assignments and PostgreSQL configuration, use [Hosted deployment](../HOSTED-DEPLOYMENT.md). For immutable image publication, use [OCI releases](OCI-RELEASE.md).
