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

variable "allowed_emails" {
  type        = set(string)
  description = "Explicit Cloudflare Access identity allowlist."
  validation {
    condition     = length(var.allowed_emails) > 0 && alltrue([for email in var.allowed_emails : can(regex("^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$", email))])
    error_message = "Set at least one valid Cloudflare Access email."
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
  description = "Private Podman network address for the API container."
  default     = "http://codexia-api:3000"
  validation {
    condition     = var.origin_service == "http://codexia-api:3000"
    error_message = "Tunnel ingress must target the private codexia-api container."
  }
}

variable "frontend_route_enabled" {
  type        = bool
  description = "Enable only the explicit UI routes after Access and routing acceptance; false leaves UI on the retained origin during rollback."
  default     = false
}
