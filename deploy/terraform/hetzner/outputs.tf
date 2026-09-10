output "installations" {
  description = "DNS targets and SSH endpoints. Server creation is not proof that bootstrap or HTTPS has completed."
  value = {
    for id, server in hcloud_server.customer : id => {
      server_id = server.id
      ipv4      = server.ipv4_address
      ipv6      = server.ipv6_address
      url       = "https://${var.customers[id].domain}"
      calls_url = var.customers[id].calls_domain == null ? null : "wss://${var.customers[id].calls_domain}"
      ssh       = "ssh root@${server.ipv4_address}"
    }
  }
}
