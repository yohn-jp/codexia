locals {
  ui_routes = jsondecode(file("${path.module}/../ui-routes.json")).routes
}

resource "cloudflare_zero_trust_access_policy" "codexia" {
  account_id = var.account_id
  name       = "Allow selected Codexia identities"
  decision   = "allow"
  include = [
    for email in sort(tolist(var.allowed_emails)) : {
      email = { email = email }
    }
  ]
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
    id         = cloudflare_zero_trust_access_policy.codexia.id
    precedence = 1
  }]
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
    ingress = [
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
  }
}

# Zone Routes select only UI paths. /api/* and every other dynamic path reach the Tunnel directly.
resource "cloudflare_workers_route" "frontend" {
  for_each = var.frontend_route_enabled ? toset(local.ui_routes) : toset([])
  zone_id  = var.zone_id
  pattern  = "${var.app_hostname}${each.value}"
  script   = "codexia-frontend"
}
