terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  cloud {
    organization = "iqbal-hakim"

    workspaces {
      name = "doks-prod"
    }
  }
}

provider "digitalocean" {}

resource "digitalocean_kubernetes_cluster" "prod" {
  name    = "prod"
  region  = "sgp1"
  version = "1.35.1-do.1"

  node_pool {
    name       = "prod-pool"
    size       = "s-2vcpu-4gb" 
    node_count = 1
  }
}

resource "local_file" "kubeconfig" {
  content         = digitalocean_kubernetes_cluster.prod.kube_config[0].raw_config
  filename        = "${path.module}/kubeconfig.yaml"
  file_permission = "0600"
}

resource "null_resource" "bootstrap" {
  depends_on = [local_file.kubeconfig]

  provisioner "local-exec" {
    command = "KUBECONFIG=${path.module}/kubeconfig.yaml ../scripts/bootstrap.sh prod"
  }
}

output "cluster_id" {
  value = digitalocean_kubernetes_cluster.prod.id
}

output "kubeconfig" {
  value     = digitalocean_kubernetes_cluster.prod.kube_config[0].raw_config
  sensitive = true
}
