variable "ssh_public_key" {
  description = "Operator public SSH key. Keep its private key on your computer."
  type        = string
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+", var.ssh_public_key))
    error_message = "Supply an OpenSSH public key, not a private key or file path."
  }
}

variable "ssh_allowed_cidrs" {
  description = "Operator/VPN CIDRs permitted to SSH. Use your public IPv4/32 or IPv6/128."
  type        = list(string)
  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0 && alltrue([for cidr in var.ssh_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Supply at least one valid SSH source CIDR."
  }
}

variable "repository_url" {
  description = "Public HTTPS Git repository containing the self-host installer and Dockerfiles. No embedded credentials."
  type        = string
  default     = "https://github.com/Thiagoxp95/taut.git"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]+$", var.repository_url))
    error_message = "Use a public HTTPS repository URL without credentials, query parameters, or shell metacharacters."
  }
}

variable "customers" {
  description = "Stable customer IDs mapped to independently provisioned hosts. Each revision must already exist in repository_url."
  type = map(object({
    domain       = string
    revision     = string
    server_type  = optional(string, "cx33")
    location     = optional(string, "hel1")
    backups      = optional(bool, true)
    calls_domain = optional(string)
  }))
  validation {
    condition     = length(var.customers) > 0 && alltrue([for id, customer in var.customers : can(regex("^[a-z][a-z0-9-]{0,39}$", id))])
    error_message = "Provide at least one customer with a lowercase hostname-safe ID (maximum 40 characters)."
  }
  validation {
    condition     = alltrue([for customer in values(var.customers) : length(customer.domain) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", customer.domain))])
    error_message = "Each domain must be a lowercase public DNS hostname, without scheme, port, wildcard, or path."
  }
  validation {
    condition     = length(distinct([for customer in values(var.customers) : customer.domain])) == length(var.customers)
    error_message = "Each customer needs a unique domain."
  }
  validation {
    condition = alltrue([for customer in values(var.customers) : customer.calls_domain == null ? true : (
      length(customer.calls_domain) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", customer.calls_domain)) &&
      !contains([for item in values(var.customers) : item.domain], customer.calls_domain)
    )]) && length(distinct(compact([for customer in values(var.customers) : customer.calls_domain]))) == length(compact([for customer in values(var.customers) : customer.calls_domain]))
    error_message = "Each optional calls_domain must be a unique public hostname, separate from every app domain."
  }
  validation {
    condition     = alltrue([for customer in values(var.customers) : can(regex("^[a-f0-9]{40}$", customer.revision))])
    error_message = "Pin each customer to a full 40-character lowercase Git commit SHA."
  }
}
