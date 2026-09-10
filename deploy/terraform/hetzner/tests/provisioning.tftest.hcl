# Offline plans: no cloud account, API calls, or paid resources.
mock_provider "hcloud" {}

variables {
  ssh_public_key    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyNotARealKey"
  ssh_allowed_cidrs = ["203.0.113.10/32"]
  customers = {
    alpha = {
      domain       = "alpha.example.com"
      calls_domain = "calls.alpha.example.com"
      revision     = "0123456789abcdef0123456789abcdef01234567"
    }
    beta = {
      domain   = "beta.example.com"
      revision = "abcdef0123456789abcdef0123456789abcdef01"
    }
  }
}

run "independent_customer_hosts" {
  command = plan
  assert {
    condition     = length(hcloud_server.customer) == 2 && length(hcloud_firewall.customer) == 2
    error_message = "Each customer must have its own server and firewall."
  }
  assert {
    condition     = hcloud_server.customer["alpha"].delete_protection && hcloud_server.customer["beta"].rebuild_protection
    error_message = "Customer data disks must be protected against accidental deletion/rebuild."
  }
  assert {
    condition     = length(hcloud_firewall.customer["alpha"].rule) == 9 && length(hcloud_firewall.customer["beta"].rule) == 4
    error_message = "Only calls-enabled customers may expose ICE and TURN ports."
  }
  assert {
    condition     = alltrue([for rule in hcloud_firewall.customer["alpha"].rule : rule.port != "3080" && rule.port != "7880" && rule.port != "6379"])
    error_message = "App, signaling, and Redis ports must not be exposed by the firewall."
  }
  assert {
    condition     = strcontains(base64decode(yamldecode(local.cloud_init["alpha"]).write_files[0].content), "--calls --calls-url 'wss://calls.alpha.example.com'") && !strcontains(base64decode(yamldecode(local.cloud_init["beta"]).write_files[0].content), "--calls")
    error_message = "Cloud-init must enable calling only when configured."
  }
  assert {
    condition     = strcontains(base64decode(yamldecode(local.cloud_init["alpha"]).write_files[0].content), "checkout --detach '0123456789abcdef0123456789abcdef01234567'")
    error_message = "Provisioning must checkout the selected immutable application revision."
  }
}

run "reject_mutable_revision" {
  command = plan
  variables {
    customers = { alpha = { domain = "alpha.example.com", revision = "main" } }
  }
  expect_failures = [var.customers]
}

run "reject_domain_injection" {
  command = plan
  variables {
    customers = { alpha = { domain = "alpha.example.com\nroot /", revision = "0123456789abcdef0123456789abcdef01234567" } }
  }
  expect_failures = [var.customers]
}
