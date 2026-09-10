terraform {
  required_version = ">= 1.7.0, < 2.0.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.60.0"
    }
  }
}

# Read HCLOUD_TOKEN from the environment; never embed credentials in user_data.
provider "hcloud" {}
