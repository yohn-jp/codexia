locals {
  ui_routes             = jsondecode(file("${path.module}/../ui-routes.json")).routes
  origin_routes         = jsondecode(file("${path.module}/../ui-routes.json")).originRoutes
  identity_probes       = jsondecode(file("${path.module}/../identity-probes.json"))
  public_protocol_paths = jsondecode(file("${path.module}/../public-protocol-paths.json"))
  public_access_paths = {
    for key, endpoint in local.public_protocol_paths : key => endpoint
    if var.public_oauth_edge_enabled
  }
  public_tunnel_paths = {
    for key, endpoint in local.public_access_paths : key => endpoint
    if endpoint.tunnelPath != null
  }
}

# The account administrator owns the shared reusable policy.
removed {
  from = cloudflare_zero_trust_access_policy.codexia
  lifecycle {
    destroy = false
  }
}

resource "cloudflare_zero_trust_access_application" "codexia" {
  account_id                = var.account_id
  name                      = "Codexia"
  domain                    = var.app_hostname
  type                      = "self_hosted"
  allowed_idps              = sort(tolist(var.allowed_idps))
  auto_redirect_to_identity = length(var.allowed_idps) == 1
  session_duration          = "8h"
  policies = [{
    id         = var.access_policy_id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_policy" "ssh" {
  account_id = var.account_id
  name       = "Codexia SSH (${var.repository_id})"
  decision   = "non_identity"
  include = [
    for environment in ["codexia-bootstrap", "codexia-production"] : {
      service_token_tag = {
        key   = "codexia-scope"
        value = "repo-${var.repository_id}-ssh-${environment}"
      }
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "ssh" {
  account_id           = var.account_id
  name                 = "Codexia management SSH"
  domain               = var.ssh_hostname
  type                 = "self_hosted"
  app_launcher_visible = false
  session_duration     = "1h"
  policies = [{
    id         = cloudflare_zero_trust_access_policy.ssh.id
    precedence = 1
  }]
}

# The reusable policies remain account-owned; manage only their application attachments.
resource "cloudflare_zero_trust_access_application" "identity_probe" {
  for_each                  = local.identity_probes
  account_id                = var.account_id
  name                      = each.value.name
  domain                    = "${var.app_hostname}${each.value.path}"
  type                      = "self_hosted"
  allowed_idps              = sort(tolist(var.allowed_idps))
  auto_redirect_to_identity = length(var.allowed_idps) == 1
  app_launcher_visible      = false
  session_duration          = "8h"
  policies = [
    {
      id         = var.access_ci_policy_id
      precedence = 1
    },
    {
      id         = var.access_policy_id
      precedence = 2
    }
  ]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.access_ci_policy_id != var.access_policy_id
      error_message = "CI Service Auth policy must be distinct from the author Allow policy."
    }
  }
}

# Public protocol routes remain disabled until an operator confirms that the
# Passkey-first Better Auth runtime and its remote OAuth acceptance are ready.
resource "terraform_data" "public_oauth_edge_readiness" {
  count = var.public_oauth_edge_enabled ? 1 : 0
  input = var.passkey_oauth_runtime_ready

  lifecycle {
    precondition {
      condition     = var.passkey_oauth_runtime_ready
      error_message = "Set passkey_oauth_runtime_ready only after the Passkey-first Better Auth runtime and remote MCP OAuth acceptance are verified."
    }
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "codexia" {
  account_id = var.account_id
  name       = "codexia"
  config_src = "cloudflare"
}

resource "cloudflare_dns_record" "codexia" {
  zone_id = var.zone_id
  type    = "CNAME"
  name    = var.app_hostname == var.zone_name ? "@" : trimsuffix(var.app_hostname, ".${var.zone_name}")
  content = format("%s.cfargotunnel.com", cloudflare_zero_trust_tunnel_cloudflared.codexia.id)
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.zone_id
  type    = "CNAME"
  name    = trimsuffix(var.ssh_hostname, ".${var.zone_name}")
  content = format("%s.cfargotunnel.com", cloudflare_zero_trust_tunnel_cloudflared.codexia.id)
  proxied = true
  ttl     = 1
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "codexia" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.codexia.id
  depends_on = [terraform_data.public_oauth_edge_readiness]
  config = {
    ingress = concat(
      [
        for _, endpoint in local.public_tunnel_paths : {
          hostname = var.app_hostname
          path     = endpoint.tunnelPath
          service  = var.origin_service
          origin_request = {
            http_host_header = var.app_hostname
            # Access is bypassed only by the matching, exact-path app below.
            # Do not validate a Cloudflare Access assertion at the private origin.
          }
        }
      ],
      [
        for key, probe in local.identity_probes : {
          hostname = var.app_hostname
          path     = probe.tunnelPath
          service  = var.origin_service
          origin_request = {
            http_host_header = var.app_hostname
            access = {
              required  = true
              team_name = var.team_name
              aud_tag = [
                cloudflare_zero_trust_access_application.identity_probe[key].aud,
                cloudflare_zero_trust_access_application.codexia.aud
              ]
            }
          }
        }
      ],
      [
        {
          hostname = var.app_hostname
          service  = var.origin_service
          origin_request = {
            http_host_header = var.app_hostname
            access = {
              required  = true
              team_name = var.team_name
              aud_tag   = [cloudflare_zero_trust_access_application.codexia.aud]
            }
          }
        },
        {
          hostname = var.ssh_hostname
          service  = "ssh://127.0.0.1:22"
          origin_request = {
            access = {
              required  = true
              team_name = var.team_name
              aud_tag   = [cloudflare_zero_trust_access_application.ssh.aud]
            }
          }
        },
        { service = "http_status:404" }
      ]
    )
  }
}

# Cloudflare's more-specific app path replaces the parent Access policy for
# just this protocol endpoint. The API still authenticates OAuth/MCP requests.
# The tunnel update is ordered first: while enabling, the parent Access app
# remains the guard until the Bypass app exists; while disabling, origin Access
# validation returns before the Bypass app is removed.
resource "cloudflare_zero_trust_access_application" "public_protocol" {
  for_each             = local.public_access_paths
  account_id           = var.account_id
  name                 = each.value.name
  domain               = "${var.app_hostname}${each.value.path}"
  type                 = "self_hosted"
  app_launcher_visible = false
  policies = [{
    name       = each.value.name
    decision   = "bypass"
    precedence = 1
    include = [{
      everyone = {}
    }]
  }]

  depends_on = [
    terraform_data.public_oauth_edge_readiness,
    cloudflare_zero_trust_tunnel_cloudflared_config.codexia,
  ]
}

# A new site can prepare the production Worker resource before it has a release.
resource "cloudflare_worker" "frontend" {
  count      = var.manage_frontend_worker ? 1 : 0
  account_id = var.account_id
  name       = "codexia-frontend"
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Scriptless exclusions win over the static catch-all, including query-string URLs.
resource "cloudflare_workers_route" "frontend" {
  for_each = var.frontend_route_enabled ? toset(local.ui_routes) : toset([])
  zone_id  = var.zone_id
  pattern  = "${var.app_hostname}${each.value}"
  script   = "codexia-frontend"

  depends_on = [cloudflare_worker.frontend]
}

resource "cloudflare_workers_route" "origin" {
  for_each = var.frontend_route_enabled ? toset(local.origin_routes) : toset([])
  zone_id  = var.zone_id
  pattern  = "${var.app_hostname}${each.value}"
}
