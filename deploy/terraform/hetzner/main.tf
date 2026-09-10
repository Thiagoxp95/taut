resource "hcloud_ssh_key" "operator" {
  name       = "taut-operator-${substr(sha256(var.ssh_public_key), 0, 12)}"
  public_key = var.ssh_public_key
}

locals {
  cloud_init = {
    for id, customer in var.customers : id => "#cloud-config\n${yamlencode({
      ssh_pwauth = false
      write_files = [{
        path        = "/usr/local/sbin/taut-bootstrap"
        owner       = "root:root"
        permissions = "0700"
        encoding    = "b64"
        content = base64encode(templatefile("${path.module}/bootstrap.sh.tftpl", {
          repository_url = var.repository_url
          revision       = customer.revision
          domain         = customer.domain
          calls_domain   = customer.calls_domain
        }))
      }]
      runcmd = [["/usr/local/sbin/taut-bootstrap"]]
    })}"
  }
}

resource "hcloud_firewall" "customer" {
  for_each = var.customers
  name     = "taut-${each.key}"
  labels   = { app = "taut", customer = each.key }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
  dynamic "rule" {
    for_each = ["80", "443"]
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = rule.value
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  dynamic "rule" {
    for_each = each.value.calls_domain == null ? {} : {
      ice_tcp    = { protocol = "tcp", port = "7881" }
      ice_udp    = { protocol = "udp", port = "7882" }
      turn_tcp   = { protocol = "tcp", port = "3478" }
      turn_udp   = { protocol = "udp", port = "3478" }
      turn_relay = { protocol = "udp", port = "49160-49200" }
    }
    content {
      direction  = "in"
      protocol   = rule.value.protocol
      port       = rule.value.port
      source_ips = ["0.0.0.0/0"]
    }
  }
}

resource "hcloud_server" "customer" {
  for_each           = var.customers
  name               = "taut-${each.key}"
  image              = "ubuntu-24.04"
  server_type        = each.value.server_type
  location           = each.value.location
  ssh_keys           = [hcloud_ssh_key.operator.id]
  firewall_ids       = [hcloud_firewall.customer[each.key].id]
  backups            = each.value.backups
  labels             = { app = "taut", customer = each.key }
  user_data          = local.cloud_init[each.key]
  delete_protection  = true
  rebuild_protection = true
  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }
  lifecycle {
    prevent_destroy = true
    # cloud-init is first-boot only. Upgrade an existing host using the runbook;
    # edits here affect newly created hosts, never replace a customer's data disk.
    ignore_changes = [user_data]
  }
}
