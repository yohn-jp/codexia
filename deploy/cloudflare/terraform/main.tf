locals {
  ui_routes       = jsondecode(file("${path.module}/../ui-routes.json")).routes
  origin_routes   = jsondecode(file("${path.module}/../ui-routes.json")).originRoutes
  identity_probes = jsondecode(file("${path.module}/../identity-probes.json"))
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

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "codexia" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.codexia.id
  config = {
    ingress = concat(
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
        { service = "http_status:404" }
      ]
    )
  }
}

# Scriptless exclusions win over the static catch-all, including query-string URLs.
resource "cloudflare_workers_route" "frontend" {
  for_each = var.frontend_route_enabled ? toset(local.ui_routes) : toset([])
  zone_id  = var.zone_id
  pattern  = "${var.app_hostname}${each.value}"
  script   = "codexia-frontend"
}

resource "cloudflare_workers_route" "origin" {
  for_each = var.frontend_route_enabled ? toset(local.origin_routes) : toset([])
  zone_id  = var.zone_id
  pattern  = "${var.app_hostname}${each.value}"
}
