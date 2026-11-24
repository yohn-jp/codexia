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

variable "access_ci_policy_id" {
  type        = string
  description = "Existing account-owned reusable Service Auth policy UUID, restricted to the Codexia CI token and attached only to identity probes."
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.access_ci_policy_id))
    error_message = "Set an existing reusable Service Auth policy UUID."
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
  description = "Canonical API on the private Podman network."
  default     = "http://codexia-api:3000"
  validation {
    condition     = var.origin_service == "http://codexia-api:3000"
    error_message = "Tunnel ingress must target only the canonical private codexia-api container."
  }
}

variable "frontend_route_enabled" {
  type        = bool
  description = "Enable only the explicit UI routes after Access and routing acceptance; false leaves UI on the retained origin during rollback."
  default     = false
}

variable "owner_setup_route_enabled" {
  type        = bool
  description = "Attach only first-owner enrollment assets under Access. Keep normal UI routes inactive until the setup API stops."
  default     = false
}

variable "public_oauth_edge_enabled" {
  type        = bool
  description = "Enable exact-path Access Bypass apps and Tunnel routes for OAuth/MCP only after Passkey-first OAuth acceptance; false keeps every path under the existing Access boundary."
  default     = false
}

variable "passkey_oauth_runtime_ready" {
  type        = bool
  description = "Operator confirmation that Passkey-first Better Auth, registered OAuth clients, and remote MCP OAuth acceptance are deployed and verified. Required when public_oauth_edge_enabled is true."
  default     = false
}
