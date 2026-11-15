locals {
  ui_routes     = jsondecode(file("${path.module}/../ui-routes.json")).routes
  origin_routes = jsondecode(file("${path.module}/../ui-routes.json")).originRoutes
  # Dedicated, exact identity endpoints are the only CI service-token destinations.
  ci_identity_routes = {
    backend  = { path = "/api/version", ingress_path = "^/api/version$" }
    frontend = { path = "/desktop/update-identity.json", ingress_path = "^/desktop/update-identity\\.json$" }
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

# Adopt the existing path-specific applications; never attach the service-token
# policy to the author application or broaden the allowed origin audiences.
resource "cloudflare_zero_trust_access_application" "ci_identity" {
  for_each                  = local.ci_identity_routes
  account_id                = var.account_id
  name                      = "Codexia CI ${each.key} identity"
  domain                    = "${var.app_hostname}${each.value.path}"
  type                      = "self_hosted"
  allowed_idps              = sort(tolist(var.allowed_idps))
  auto_redirect_to_identity = length(var.allowed_idps) == 1
  app_launcher_visible      = false
  session_duration          = "8h"
  policies = [
    {
      id         = var.ci_access_policy_id
      precedence = 1
    },
    {
      id         = var.access_policy_id
      precedence = 2
    }
  ]
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
    ingress = concat([
      for key in sort(keys(local.ci_identity_routes)) : {
        hostname = var.app_hostname
        path     = local.ci_identity_routes[key].ingress_path
        service  = var.origin_service
        origin_request = {
          http_host_header = var.app_hostname
          access = {
            required  = true
            team_name = var.team_name
            aud_tag = [
              cloudflare_zero_trust_access_application.ci_identity[key].aud,
              cloudflare_zero_trust_access_application.codexia.aud
            ]
          }
        }
      }
    ], [
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
    ])
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
