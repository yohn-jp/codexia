variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the Codexia hostname."
}

variable "zone_name" {
  type        = string
  description = "Cloudflare DNS zone name."
}

variable "app_hostname" {
  type        = string
  description = "Single HTTPS hostname shared by Static Assets and Tunnel API routes."
  validation {
    condition     = var.app_hostname == var.zone_name || endswith(var.app_hostname, ".${var.zone_name}")
    error_message = "The Codexia hostname must be the zone apex or a subdomain of the selected zone."
  }
}

variable "team_name" {
  type        = string
  description = "Cloudflare Access team prefix before .cloudflareaccess.com."
}

variable "access_policy_id" {
  type        = string
  description = "Existing account-owned reusable Access policy ID; its authorization rules are managed outside Codexia."
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.access_policy_id))
    error_message = "Set an existing reusable Access policy UUID."
  }
}

variable "allowed_idps" {
  type        = set(string)
  description = "Existing Cloudflare Access IdP IDs."
  validation {
    condition     = length(var.allowed_idps) > 0
    error_message = "Set at least one existing Cloudflare Access IdP ID."
  }
}

variable "origin_service" {
  type        = string
  description = "Private Podman network address for the legacy API or standalone updater proxy."
  default     = "http://codexia-api:3000"
  validation {
    condition     = contains(["http://codexia-api:3000", "http://codexia-api-proxy:3000"], var.origin_service)
    error_message = "Tunnel ingress must target the private codexia-api or codexia-api-proxy container."
  }
}

variable "frontend_route_enabled" {
  type        = bool
  description = "Enable only the explicit UI routes after Access and routing acceptance; false leaves UI on the retained origin during rollback."
  default     = false
}
