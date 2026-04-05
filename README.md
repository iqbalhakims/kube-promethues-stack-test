# kube-prometheus-stack

Kubernetes infrastructure setup running on DigitalOcean Kubernetes (DOKS).

## Table of Contents

- [Deployment Guide](#deployment-guide)
  - [1. Terraform — Provision Infrastructure](#1-terraform--provision-infrastructure)
  - [2. AWS Secrets Manager — Create Secrets](#2-aws-secrets-manager--create-secrets)
  - [3. Bootstrap the Cluster](#3-bootstrap-the-cluster)
  - [4. DOCR Pull Secret](#4-docr-pull-secret)
  - [5. CI/CD — Build & Push Images](#5-cicd--build--push-images)
  - [6. ArgoCD — Deploy Apps](#6-argocd--deploy-apps)
  - [7. Live Endpoints](#7-live-endpoints)
- [Known Fixes Applied](#known-fixes-applied)
- [Cluster](#cluster)
- [Resource Usage](#resource-usage)
- [Components](#components)
- [Application Helm Charts](#application-helm-charts)
  - [Chart structure](#chart-structure)
  - [Customizing per environment](#customizing-per-environment)
  - [Before deploying](#before-deploying)
- [Domains](#domains)
- [Secrets Management](#secrets-management)
- [Known issues / Gotchas](#known-issues--gotchas)
- [Homelab Migration Plan](#homelab-migration-plan-raspberry-pi-5-8gb-ram-single-node)
  - [Phase 1: Pre-Migration Assessment](#phase-1-pre-migration-assessment)
  - [Phase 2: Infrastructure Setup (Pi 5)](#phase-2-infrastructure-setup-pi-5)
  - [Phase 3: Replace Cloud Dependencies](#phase-3-replace-cloud-dependencies)
  - [Phase 4: Homelab Kustomize Overlay](#phase-4-homelab-kustomize-overlay)
  - [Phase 5: Networking & Access](#phase-5-networking--access)
  - [Phase 6: Migration Execution](#phase-6-migration-execution)
  - [Key Risks](#key-risks)
  - [Recommended Simplifications for Homelab](#recommended-simplifications-for-homelab)
- [Observability Demo Checklist](#observability-demo-checklist)
  - [Metrics to Highlight](#metrics-to-highlight)
  - [Simulate Failure Scenarios](#simulate-failure-scenarios)
  - [Observe in Grafana](#observe-in-grafana)
  - [SLO & Error Budget](#slo--error-budget)
  - [Resource Usage & Right-Sizing](#resource-usage--right-sizing)
- [How TLS Certificate Issuance Works](#how-tls-certificate-issuance-works)
- [Apply order](#apply-order)
- [Verify secrets sync](#verify-secrets-sync)

---

## Deployment Guide

End-to-end steps to provision and deploy the stack from scratch.

### 1. Terraform — Provision Infrastructure

```bash
cd terraform
terraform init
terraform apply
```

This creates:
- DOKS cluster (`prod`, region `sgp1`, `s-2vcpu-8gb-amd`, 1 node)
- AWS IAM OIDC provider + role `github-actions-coffman` for GitHub Actions
- Runs `scripts/bootstrap.sh prod` automatically after cluster creation

Get the GitHub Actions role ARN:
```bash
terraform output github_actions_role_arn
```

Set it as a GitHub repo variable: **Settings → Secrets and variables → Actions → Variables → `AWS_ROLE_ARN`**

### 2. AWS Secrets Manager — Create Secrets

```bash
# DigitalOcean token (for CI to push images to DOCR)
aws secretsmanager create-secret \
  --name coffman/digitalocean-token \
  --secret-string "dop_v1_<your-token>" \
  --region ap-southeast-1

# Cloudflare API token (for external-dns and cert-manager DNS-01)
aws secretsmanager create-secret \
  --name external-dns/cloudflare-token \
  --secret-string '{"CF_API_TOKEN":"<your-cloudflare-token>"}' \
  --region ap-southeast-1
```

Cloudflare token requires **Zone → DNS → Edit** permission for your domain.

### 3. Bootstrap the Cluster

If the Terraform bootstrap didn't run (cluster wasn't ready in time), run manually:

```bash
kubectl apply -k environments/prod/ --server-side --force-conflicts
sleep 30
kubectl apply -k environments/prod/ --server-side --force-conflicts
sleep 30
kubectl apply -k environments/prod/ --server-side --force-conflicts
```

Then create the bootstrap secret for External Secrets Operator (one-time, never stored in git):

```bash
kubectl create secret generic aws-sm-credentials \
  -n external-secrets \
  --from-literal=access-key=<AWS_ACCESS_KEY_ID> \
  --from-literal=secret-access-key=<AWS_SECRET_ACCESS_KEY>
```

Restart external-secrets to pick it up:
```bash
kubectl rollout restart deployment external-secrets -n external-secrets
```

### 4. DOCR Pull Secret

Allow the cluster to pull images from DigitalOcean Container Registry:

```bash
doctl registry kubernetes-manifest | kubectl apply -f -
```

The `registry-coffman` pull secret is referenced in `charts/*/values.yaml` via `imagePullSecrets`.

### 5. CI/CD — Build & Push Images

The GitHub Actions workflow (`.github/workflows/ci.yaml`) triggers on pushes to `apps/**`:

1. Authenticates to AWS via OIDC using `AWS_ROLE_ARN`
2. Fetches the DO token from AWS SM (`coffman/digitalocean-token`)
3. Logs in to DOCR and builds/pushes `backend` and `frontend` images

To trigger manually:
```bash
git commit --allow-empty -m "chore: trigger CI" && git push
# or touch a file in apps/
```

Images are pushed to `registry.digitalocean.com/coffman/{backend,frontend}:{latest,<sha>}`.

### 6. ArgoCD — Deploy Apps

ArgoCD auto-syncs from this repo. Apps are defined in `argocd/apps/`:
- `backend.yaml` → deploys `charts/backend/` with `values.yaml` + `values-prod.yaml`
- `frontend.yaml` → deploys `charts/frontend/` with `values.yaml` + `values-prod.yaml`

Access ArgoCD at `https://argo.prod.iqbalhakim.ink`.

### 7. Live Endpoints

| Service | URL |
|---|---|
| Frontend | `https://app.iqbalhakim.ink` |
| Backend API | `https://api.iqbalhakim.ink` |
| ArgoCD | `https://argo.prod.iqbalhakim.ink` |
| Grafana | `https://grafana.prod.iqbalhakim.ink` |

---

## Known Fixes Applied

| Issue | Fix |
|---|---|
| external-dns using Route53 instead of Cloudflare | Switched `--provider=cloudflare` in `external-dns/prod/deployment.yaml` |
| cert-manager DNS-01 using Route53 | Switched to Cloudflare solver in `cert-manager/prod/cluster-issuer.yaml` |
| App images failing to pull from DOCR | Added `imagePullSecrets: registry-coffman` to `charts/*/values.yaml` |
| App pods crashing (port mismatch) | Changed `service.port` from `80` → `8080` in `charts/*/values.yaml` |
| app/api not routed through Istio | Added VirtualServices in `istio/prod/virtualservices.yaml` |
| app/api DNS not created by external-dns | Added hostnames to `external-dns.alpha.kubernetes.io/hostname` annotation in `istio/prod/ingress-service.yaml` |
| CPU pressure on single node | Scaled `minReplicas` from `2` → `1` in `charts/*/values-prod.yaml` |
| Grafana loses Prometheus data connection | ArgoCD + ESO sync loop: incomplete ExternalSecret specs in git caused ArgoCD to detect drift, triggering repeated syncs that ran the `admission-create` job and disrupted the Prometheus webhook. Fixed by completing ExternalSecret specs in `grafana/prod/external-secrets.yaml` and adding `ignoreDifferences` for ESO-managed Secret `/data` fields in `argocd/apps/grafana.yaml` |

---

## Cluster

| Property | Value |
|---|---|
| Provider | DigitalOcean Kubernetes (DOKS) |
| Node size | s-2vcpu-4gb (1 node) |
| Region | ap-southeast-1 |

## Resource Usage

Node capacity: **2 vCPU / ~3GB allocatable RAM**
Current allocation: **1302m CPU (68%) / 2971Mi RAM (98%) — nearly maxed out**

> Prometheus pod is not running (operator only), and most infra pods have no resource requests defined — actual usage is likely higher than what the scheduler sees.

### Pods with defined resource requests

| Namespace | Pod | CPU Request | Mem Request | CPU Limit | Mem Limit |
|---|---|---|---|---|---|
| istio-system | istiod | 500m | 2048Mi | — | — |
| kube-system | cilium | 500m | 410Mi | 1000m | 1024Mi |
| apps | backend (×2) | 250m each | 256Mi each | 500m | 512Mi |
| kube-system | coredns (×2) | 100m each | 170Mi each | — | 170Mi |
| apps | frontend (×2) | 100m each | 128Mi each | 200m | 256Mi |
| istio-system | istio-ingress | 100m | 128Mi | 2000m | 1024Mi |
| kube-system | do-node-agent | 102m | 80Mi | — | 300Mi |
| kube-system | cpc-bridge-proxy | 100m | 75Mi | — | — |

### Pods with no resource requests (unconstrained)

- ArgoCD (8 pods), cert-manager (3 pods), argo-rollouts (2 pods)
- Grafana, kube-state-metrics, prometheus-operator, node-exporter
- external-secrets (3 pods), external-dns, tailscale operator
- kube-system DaemonSets (hubble, konnectivity, csi-do-node, etc.)

### Key observations

- **istiod alone requests 2GB RAM** — the single biggest consumer. Replacing it with nginx-ingress would free ~2GB on the Pi.
- RAM is already at **98% allocated** on the current node and Prometheus isn't running yet.
- `backend` and `frontend` pods are `Pending` due to no remaining scheduling headroom.
- The Pi's 8GB gives more room, but Istio staying would still consume 2GB+ for the control plane alone.

## Components



| Component | Directory | Description |
|---|---|---|
| ArgoCD | `argocd/` | GitOps continuous delivery |
| Cert Manager | `cert-manager/` | TLS certificate management via Let's Encrypt (DNS-01 with Route53) |
| External DNS | `external-dns/` | Automatic DNS record management |
| External Secrets | `external-secrets/` | Sync secrets from AWS Secrets Manager |
| Grafana / Prometheus | `grafana/` | Monitoring stack (kube-prometheus-stack) |
| Istio | `istio/` | Service mesh + ingress gateway |
| Tailscale | `tailscale/` | VPN operator for secure access |
| Frontend | `charts/frontend/` | Helm chart for frontend application |
| Backend | `charts/backend/` | Helm chart for backend application |

## Application Helm Charts

Frontend and backend are deployed as Helm charts managed by ArgoCD.

### Chart structure

```
charts/
├── frontend/
│   ├── values.yaml           # base values
│   ├── values-prod.yaml      # prod overrides
│   ├── values-staging.yaml   # staging overrides
│   └── templates/
└── backend/
    ├── values.yaml
    ├── values-prod.yaml
    ├── values-staging.yaml
    └── templates/
```

ArgoCD Application manifests live in `argocd/apps/`:

| File | Environment | App |
|---|---|---|
| `frontend.yaml` | prod | Frontend |
| `backend.yaml` | prod | Backend |
| `frontend-staging.yaml` | staging | Frontend |
| `backend-staging.yaml` | staging | Backend |

These are included via `environments/prod/kustomization.yaml` and `environments/staging/kustomization.yaml` and picked up by the app-of-apps.

### Customizing per environment

Edit the relevant `values-<env>.yaml` to override image tags, replica counts, hosts, and autoscaling:

```yaml
# charts/frontend/values-prod.yaml
replicaCount: 2
image:
  tag: "prod-latest"
ingress:
  hosts:
    - host: app.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
```

### Before deploying

1. Replace `your-registry/frontend` and `your-registry/backend` in `charts/*/values.yaml` with your actual image repositories.
2. Replace `yourdomain.com` with your actual domain in all `values-*.yaml` files.
3. Update `service.port` in `charts/backend/values.yaml` if your backend listens on a non-80 port (e.g. `8080`).
4. Update `readinessProbe.path` for backend if it exposes a dedicated health endpoint (e.g. `/health`).

## Domains

| Service | Environment | Domain |
|---|---|---|
| ArgoCD | prod | `argocd.iqbalhakim.ink` |
| ArgoCD | staging | `argocd.staging.iqbalhakim.ink` |
| Grafana | prod | `grafana.iqbalhakim.ink` |
| Grafana | staging | `grafana.staging.iqbalhakim.ink` |

## Secrets Management

Secrets are stored in **AWS Secrets Manager** (`ap-southeast-1`) and synced into the cluster using [External Secrets Operator](https://external-secrets.io).

### Secret paths in AWS SM

| AWS SM Path | Kubernetes Secret | Namespace |
|---|---|---|
| `argocd/argocd-secret` | `argocd-secret` | `argocd` |
| `argocd/argocd-notifications-secret` | `argocd-notifications-secret` | `argocd` |
| `monitoring/kube-prometheus-stack-grafana` | `kube-prometheus-stack-grafana` | `monitoring` |
| `monitoring/alertmanager-kube-prometheus-stack-alertmanager` | `alertmanager-kube-prometheus-stack-alertmanager` | `monitoring` |
| `monitoring/staging/kube-prometheus-stack-grafana` | `staging-kube-prometheus-stack-grafana` | `monitoring` |
| `monitoring/staging/alertmanager-kube-prometheus-stack-alertmanager` | `staging-alertmanager-kube-prometheus-stack-alertmanager` | `monitoring` |

### IAM credentials

ESO authenticates to AWS using a static IAM user. Store the credentials in `external-secrets/cluster-secret-store.yaml` before applying:

```yaml
stringData:
  access-key: <AWS_ACCESS_KEY_ID>
  secret-access-key: <AWS_SECRET_ACCESS_KEY>
```

## Known issues / Gotchas

### namePrefix on cluster-singleton components

cert-manager and istiod are **cluster-scoped singletons** — they must only be deployed once. Do NOT apply `namePrefix: staging-` to their base manifests.

The `cert-manager/staging/` and `istio/staging/` overlays only patch environment-specific resources (ClusterIssuer, Certificate, Gateway, VirtualService). If you accidentally apply the staging overlay with `namePrefix` on the full base, the webhook TLS certs will break because the service names change (e.g. `staging-cert-manager-webhook`) but the certs are valid for the original names.

**Recovery:**
```bash
# Delete broken webhook configs
kubectl delete mutatingwebhookconfiguration staging-cert-manager-webhook --ignore-not-found
kubectl delete validatingwebhookconfiguration staging-istio-validator-istio-system staging-istiod-default-validator --ignore-not-found

# Delete broken deployments
kubectl delete deployment staging-cert-manager staging-cert-manager-cainjector staging-cert-manager-webhook -n cert-manager --ignore-not-found
```

### Istio VirtualService gateway reference

With `namePrefix: staging-`, the staging Istio Gateway is named `staging-istio-ingress-gateway`. VirtualServices must reference it as `istio-system/staging-istio-ingress-gateway`, not `istio-system/istio-ingress-gateway`.

If a VS ends up with the wrong gateway reference after apply, patch it directly:
```bash
kubectl patch virtualservice staging-grafana -n monitoring --type=merge \
  -p '{"spec":{"gateways":["istio-system/staging-istio-ingress-gateway"],"http":[{"route":[{"destination":{"host":"staging-kube-prometheus-stack-grafana.monitoring.svc.cluster.local","port":{"number":80}}}]}]}}'
```

## Homelab Migration Plan (Raspberry Pi 5, 8GB RAM, Single Node)

### Overview

Migration from DOKS (DigitalOcean, sgp1) to a self-hosted Raspberry Pi 5. The Pi has comparable RAM but key differences: **ARM64 architecture**, **no cloud LoadBalancer**, **no managed storage**, and **no cloud secrets manager**.

---

### Phase 1: Pre-Migration Assessment

**1.1 ARM64 Image Compatibility Audit**

Every image must support `linux/arm64`. Capture the full image list from the current cluster:

```bash
kubectl get pods -A -o jsonpath='{..image}' | tr ' ' '\n' | sort -u
```

| Component | Image | ARM64 |
|---|---|---|
| Prometheus | `quay.io/prometheus/prometheus:v3.5.0` | ✅ |
| Grafana | `docker.io/grafana/grafana:v12.1.0` | ✅ |
| AlertManager | `quay.io/prometheus/alertmanager:v0.28.1` | ✅ |
| kube-state-metrics | `v2.16.0` | ✅ |
| node-exporter | `v1.9.1` | ✅ |
| Istio | `v1.29.1` | ✅ |
| cert-manager | `v1.20.1` | ✅ |
| ArgoCD | v2.10+ | ✅ |
| External Secrets Operator | — | ✅ |
| External DNS | — | ✅ |
| Tailscale operator | — | ✅ |

**1.2 Resource Baseline**

Capture current usage before migrating:

```bash
kubectl top nodes
kubectl top pods -A
kubectl get pvc -A
```

Pi 5 has 8GB RAM — same as current node. Istio sidecars add ~50–100MB per pod. Running prod + staging with full Istio will be tight (~5–6GB peak). Consider dropping staging or replacing Istio with nginx-ingress (saves ~1GB).

---

### Phase 2: Infrastructure Setup (Pi 5)

**2.1 OS & Kubernetes**

- Install **Ubuntu 24.04 LTS arm64** (better k8s compatibility than Raspberry Pi OS)
- Install **k3s** (lighter than kubeadm; includes local-path-provisioner):

```bash
curl -sfL https://get.k3s.io | sh -s - \
  --disable traefik \
  --disable servicelb \
  --write-kubeconfig-mode 644
```

Disable k3s's built-in Traefik (keeping Istio) and servicelb (using MetalLB).

**2.2 LoadBalancer Replacement**

No cloud LB on homelab — use **MetalLB** in L2 mode:

1. Assign a static IP to the Pi on your home network (e.g. `192.168.1.100`)
2. Configure MetalLB `IPAddressPool` with that IP
3. The `istio-ingress` LoadBalancer service will claim this IP
4. Forward ports `80`/`443` on your router to `192.168.1.100`

Add to `istio/base/ingress.yaml`:

```yaml
annotations:
  metallb.universe.tf/loadBalancerIPs: "192.168.1.100"
```

**2.3 Storage**

k3s ships `local-path-provisioner` as the default StorageClass. Add PVCs to components currently running ephemeral (Prometheus, Grafana, AlertManager):

```yaml
# In grafana/base/mainfest.yaml — Prometheus spec
storage:
  volumeClaimTemplate:
    spec:
      storageClassName: local-path
      resources:
        requests:
          storage: 20Gi
```

> **Important:** Use a USB SSD, not the microSD card. Prometheus TSDB write patterns will destroy an SD card within months.

---

### Phase 3: Replace Cloud Dependencies

**3.1 Secrets Management (AWS SM → SOPS + Age)**

External Secrets Operator currently pulls from AWS Secrets Manager. Replace with **SOPS-encrypted secrets in git** + ArgoCD's SOPS decryption plugin:

1. Generate an Age key pair; store the private key securely on the Pi
2. Encrypt existing secrets with `sops --age`
3. Remove `external-secrets/` from the stack
4. Replace `ExternalSecret` resources with regular SOPS-encrypted `Secret` manifests
5. Configure ArgoCD with the SOPS helm plugin or `argocd-vault-plugin`

Alternatively: **Bitwarden Secrets Manager** (free tier) keeps the ESO pattern without AWS.

**3.2 External DNS (no changes needed)**

External DNS can manage Route53 from anywhere — AWS API is not region-locked. Keep `external-dns/` as-is; just ensure IAM credentials are available on the new cluster.

**3.3 cert-manager (no changes needed)**

Let's Encrypt DNS-01 via Route53 works from any network. cert-manager reaches out to Let's Encrypt and updates Route53 via the AWS API. No changes required.

**3.4 Terraform**

`terraform/` becomes obsolete — the Pi is provisioned manually or via Ansible. Archive the directory for reference but remove it from active use.

---

### Phase 4: Homelab Kustomize Overlay

Create a new environment overlay:

```
environments/
  homelab/
    kustomization.yaml
```

Key patches for the homelab overlay:

- Drop staging environment (too much RAM overhead for a single Pi node)
- Reduce Prometheus retention to 15d (disk constraint)
- Tune Istio sidecar resources: `requests: {cpu: 10m, memory: 64Mi}`
- Point domains to the Pi's Tailscale hostname or home IP

**Consider replacing Istio with nginx-ingress** on the homelab — Istio adds ~1GB RAM overhead. For a single-node setup where Tailscale handles secure access, nginx-ingress is sufficient and much lighter.

---

### Phase 5: Networking & Access

**Tailscale (keep as-is):** The operator works on ARM64 with no cloud dependency. The `iqbalhakim-ingress` Tailscale hostname continues to work unchanged.

**Home router:**

- Reserve a static DHCP lease for the Pi (`192.168.1.100`)
- Forward ports `80`/`443` for public access, OR rely solely on Tailscale (no port forwarding — more secure)

**DNS:** If going Tailscale-only, point `grafana.iqbalhakim.ink` and `argocd.iqbalhakim.ink` at the Pi's Tailscale IP. No public port forwarding needed.

---

### Phase 6: Migration Execution

```
Day 1  Provision Pi 5, install Ubuntu + k3s, install MetalLB, verify kubectl access
Day 2  Deploy cert-manager, Tailscale operator, External DNS
Day 3  Deploy Istio (or nginx-ingress), deploy ArgoCD, connect to this git repo
Day 4  Migrate secrets (SOPS or Bitwarden), deploy kube-prometheus-stack
Day 5  Deploy apps (frontend/backend), verify all ArgoCD apps Synced/Healthy
Day 6  Lower Route53 TTLs, cut DNS over to Pi IP, monitor for 24h
Day 7  Tear down DOKS cluster after confirming stable
```

---

### Key Risks

| Risk | Mitigation |
|---|---|
| ARM64 image gap | Audit all images in Phase 1 before touching infra |
| RAM pressure with Istio | Replace Istio with nginx-ingress; saves ~1GB |
| No persistent storage today | Add PVCs before migrating — don't lose Prometheus history |
| SD card I/O for Prometheus | Use USB SSD for Pi storage |
| Single point of failure | No HA; document recovery steps and back up PVCs regularly |
| Home IP change | Use Tailscale exclusively + DDNS (Route53 dynamic update) |

---

### Recommended Simplifications for Homelab

1. **Drop staging overlay** — single environment on Pi
2. **Replace Istio with nginx-ingress** — saves ~1GB RAM
3. **Replace AWS SM with SOPS** — removes cloud dependency
4. **Use USB SSD** — not microSD
5. **Keep Tailscale** — best zero-config secure access for homelab

---

## Observability Demo Checklist

A structured walkthrough to demonstrate the full monitoring stack in action.

### Metrics to Highlight

- [ ] **Request rate** — `rate(http_requests_total[5m])` per service, visible in Grafana
- [ ] **Latency** — p50 / p95 / p99 via `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))`
- [ ] **Errors** — `rate(http_requests_total{status=~"5.."}[5m])` error rate per endpoint

---

### Simulate Failure Scenarios

#### Pod Crash
```bash
# Delete a pod to trigger CrashLoopBackOff / restart counter spike
kubectl delete pod -n apps -l app=backend --grace-period=0
# Or inject a crash via bad command override in the deployment
```

#### High CPU
```bash
# Run a CPU stress container in the cluster
kubectl run cpu-stress --image=containerstack/cpustress --restart=Never \
  -- --cpu 2 --timeout 120s
```

#### Memory Leak
```bash
# Spin up a container that slowly allocates memory
kubectl run mem-leak --image=polinux/stress --restart=Never \
  -- stress --vm 1 --vm-bytes 256M --vm-hang 60
```

---

### Observe in Grafana

- [ ] **Alert fired** — AlertManager fires and routes to configured receiver (Slack / email)
- [ ] **Grafana visualization** — Dashboard shows spike in error rate, latency, CPU/memory
- [ ] **Recovery** — Metrics return to baseline after pod restarts / stress removed

---

### SLO & Error Budget

- [ ] **SLO definition** — 99.9% availability (≤ 43.2 min downtime/month)
- [ ] **Alert rule based on SLO** — Multi-window burn rate alert (5m + 1h windows):

```yaml
# PrometheusRule example
- alert: HighErrorBudgetBurn
  expr: |
    (
      rate(http_requests_total{status=~"5.."}[5m]) /
      rate(http_requests_total[5m])
    ) > 0.001  # 0.1% error rate = burning budget 14x fast
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Error budget burning too fast"
```

- [ ] **Error budget remaining** — `1 - (total_errors / total_requests)` over rolling 30d window
- [ ] **Budget exhaustion ETA** — visible on Grafana SLO dashboard

---

### Resource Usage & Right-Sizing

- [ ] **Current usage vs requests** — `kubectl top pods -A` vs defined requests/limits
- [ ] **Over-provisioned pods** — containers with requests >> actual usage (wasted cost)
- [ ] **Under-resourced pods** — containers hitting CPU throttle or OOM kills

#### HPA Tuning
```bash
# Check current HPA state
kubectl get hpa -n apps
# Watch scaling events
kubectl describe hpa -n apps backend
```

- [ ] **Scale-out trigger** — drive load with k6, observe HPA scale from 1 → N replicas
- [ ] **Scale-in cooldown** — verify pods scale back down after load drops

#### VPA (optional)
```bash
# Install VPA if not present
kubectl apply -f https://github.com/kubernetes/autoscaler/releases/latest/download/vpa-v1-crd.yaml
# Check VPA recommendations
kubectl describe vpa -n apps
```

- [ ] **VPA recommendation** — `lowerBound` / `target` / `upperBound` for CPU and memory
- [ ] **Apply recommendation** — update `resources.requests` in `charts/*/values-prod.yaml` to match VPA target

---

## How TLS Certificate Issuance Works

1. **You request a cert** — cert-manager asks Let's Encrypt for a certificate for `grafana.prod.iqbalhakim.ink`
2. **Let's Encrypt challenges you** — "prove you own this domain" by placing a specific token at a known URL or DNS record
3. **Your setup uses DNS-01 challenge** — cert-manager creates a `_acme-challenge.grafana.prod.iqbalhakim.ink` TXT record via Cloudflare to prove domain ownership
4. **Let's Encrypt verifies** — it queries that DNS TXT record, sees the token, and says "ok you own it"
5. **Cert is issued** — cert-manager stores it as a Kubernetes secret `iqbalhakim-prod-tls`
6. **Istio uses it** — the Gateway reads that secret to terminate HTTPS

---

## Apply order

```bash
# 1. Install ESO (server-side apply required for large CRDs)
kubectl create namespace external-secrets
kubectl apply --server-side -f external-secrets/manifest.yaml

# 2. Apply remaining components
kubectl apply -f cert-manager/manifest.yaml
kubectl apply -f cert-manager/cluster-issuer.yaml
kubectl apply -f argocd/manifest.yaml
kubectl apply -f grafana/mainfest.yaml
kubectl apply -f external-dns/manifest.yaml
kubectl apply -f tailscale/manifest.yaml
kubectl apply -f istio/base/base.yaml
kubectl apply -f istio/istiod/istiod.yaml
kubectl apply -f istio/ingress/ingress.yaml
kubectl apply -f istio/ingress/gateway.yaml

# 3. Create IAM credentials secret (never store in git)
kubectl create secret generic aws-sm-credentials \
  --namespace external-secrets \
  --from-literal=access-key=YOUR_ACCESS_KEY_ID \
  --from-literal=secret-access-key=YOUR_SECRET_ACCESS_KEY

# 4. Apply ClusterSecretStore + ExternalSecrets
kubectl apply -f external-secrets/cluster-secret-store.yaml
kubectl apply -f grafana/external-secrets.yaml
kubectl apply -f argocd/external-secrets.yaml
```

## Verify secrets sync

```bash
kubectl get clustersecretstore aws-secrets-manager
kubectl get externalsecret -n monitoring
kubectl get externalsecret -n argocd
```
