variable "account_id" {
  type = string
}

variable "worker_id" {
  type = string
}

variable "tag" {
  type = string
}

variable "compatibility_date" {
  type = string
}

resource "cloudflare_worker_version" "candidate" {
  account_id         = var.account_id
  worker_id          = var.worker_id
  deploy             = false
  compatibility_date = var.compatibility_date
  annotations = {
    workers_tag = var.tag
  }
  assets = {
    directory = "${path.module}/assets"
    config = {
      html_handling      = "none"
      not_found_handling = "none"
    }
  }
  modules = [for name in ["_headers", "_redirects"] : {
    name         = name
    content_type = "text/plain"
    content_file = "${path.module}/${name}"
  }]
}

output "version_id" {
  value = cloudflare_worker_version.candidate.id
}
