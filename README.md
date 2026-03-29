# kube-prometheus-stack

Kubernetes infrastructure setup running on DigitalOcean Kubernetes (DOKS).

## Cluster

| Property | Value |
|---|---|
| Provider | DigitalOcean Kubernetes (DOKS) |
| Node size | s-2vcpu-4gb (1 node) |
| Region | ap-southeast-1 |

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

## Domains

| Service | Environment | Domain |
|---|---|---|
| ArgoCD | prod | `argocd.iqbalhakim.live` |
| ArgoCD | staging | `argocd.staging.iqbalhakim.live` |
| Grafana | prod | `grafana.iqbalhakim.live` |
| Grafana | staging | `grafana.staging.iqbalhakim.live` |

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
