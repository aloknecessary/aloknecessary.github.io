---
title: "Multi-Cluster ArgoCD Architecture: Hub-and-Spoke vs. Per-Cluster, Done Right"
published: false
description: Where does ArgoCD live when you go from 1 cluster to 15? A practical decision framework for multi-cluster GitOps architecture.
tags: argocd, kubernetes, gitops, devops
canonical_url: https://aloknecessary.in/blogs/multi-cluster-argocd-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=multi-cluster-argocd-architecture
cover_image:
---

Every ArgoCD tutorial ends with one cluster, one ArgoCD instance, and `kubectl config current-context` pointing at the same place ArgoCD is installed. That works fine — until you have two clusters. By the time you're at 10 or 15, across AWS and Azure, the architecture you picked on day one is either quietly paying for itself or quietly costing you an incident a quarter.

The two dominant patterns — hub-and-spoke and ArgoCD-per-cluster — are both reasonable in the right context and both wrong when applied past the cluster count and team topology they were designed for.

---

## The Two Bad Defaults Teams Back Into

Rather than choosing deliberately, most teams end up at one of two failure modes:

1. **ArgoCD-per-cluster sprawl** — every cluster gets its own ArgoCD because that's what the getting-started guide showed. Nobody has a single view of what's deployed where. Upgrading ArgoCD becomes N separate change requests.
2. **A single hub that becomes a bottleneck** — one team stands up ArgoCD once, registers every cluster against it, and doesn't revisit that decision until the application controller is falling behind on reconciliation or a hub outage takes down deployments for every team at once.

---

## Pattern 1: Hub-and-Spoke

One management cluster runs ArgoCD. Every other cluster is registered as a remote destination via a `Secret` containing that cluster's API server address and credentials.

**What you get:** single pane of glass, centralized RBAC and SSO, one audit trail.

**What it costs you:** the hub becomes a scaling bottleneck at high cluster/Application count; blast radius covers every spoke if the hub is compromised; network reachability to every spoke's API server is a real design requirement, not just an IAM policy.

Two blast-radius shapes worth planning for specifically:

- **Redis under memory pressure** — ArgoCD's application controller caches live-vs-desired state in Redis across every Application it manages. An OOM or eviction storm on that single Redis instance stalls reconciliation for every cluster the hub manages simultaneously. From the outside it looks like "ArgoCD is stuck everywhere" — the root cause is capacity planning on a component most teams treat as an implementation detail.
- **A quietly broken peering path** — a security group rule tightened on one spoke's cluster security group doesn't fail loudly. It shows up as that spoke going `Unknown` in the UI while everything else stays green, easy to dismiss as a blip until someone needs to ship a fix to that cluster and can't.

### Network Reachability — The Part Tutorials Skip

On **AWS**: VPC peering or Transit Gateway gets the hub's control plane traffic to each spoke's private EKS API server endpoint. Private API server endpoints are the right default for spoke clusters, but every private-by-default decision adds a network path the hub now has to be deliberately connected to.

On **Azure**: VNet peering or Azure Private Link between the hub's VNet and each spoke AKS cluster's VNet. Same shape of problem — the hub's egress needs a routable, authorized path to a spoke's control plane.

### Controller Sharding Past 10 Clusters

A hub managing 12 spoke clusters with ~50 Applications each (600 total) on a single unsharded controller will start lagging live cluster state by 3-4 minutes during normal operation, and considerably longer after a bulk change. The fix is multiple controller replicas with shard annotations on cluster secrets:

```yaml
# argocd-application-controller StatefulSet
spec:
  replicas: 4
```

```yaml
# Cluster Secret with shard annotation
metadata:
  annotations:
    argocd.argoproj.io/shard: "2"
```

With `ARGOCD_CONTROLLER_REPLICAS=4` and shard annotations spread across 12 spoke secrets, each replica watches 3 clusters instead of all 12 — reconciliation lag drops back to single-digit seconds. This change isn't complete without also moving to a Redis HA (Sentinel-backed) deployment, since a single Redis becomes the new bottleneck once four controller replicas hit it concurrently.

---

## Pattern 2: ArgoCD-per-Cluster

Each cluster runs its own ArgoCD instance and manages only itself.

**What you get:** fault isolation, no cross-cluster network dependency, clean blast radius.

**What it costs you:** N places to upgrade and patch; fragmented visibility; RBAC and project config duplicated N times with all the drift that implies.

**Where this genuinely wins:** regulated environments where a cluster's isolation boundary is a compliance requirement; air-gapped clusters with no viable network path back to a central hub; edge deployments where each site operates independently.

---

## Cluster Registration — EKS

The clean way to register a spoke EKS cluster is IRSA or EKS access entries — not a static kubeconfig with a long-lived token. The cluster secret uses the `aws eks get-token` exec plugin:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: spoke-eks-prod-us-east-1
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: spoke-eks-prod-us-east-1
  server: https://EXAMPLE1234567890.gr7.us-east-1.eks.amazonaws.com
  config: |
    {
      "execProviderConfig": {
        "command": "aws",
        "args": [
          "eks", "get-token",
          "--cluster-name", "spoke-eks-prod",
          "--region", "us-east-1",
          "--role-arn", "arn:aws:iam::111122223333:role/argocd-hub-spoke-access"
        ],
        "apiVersion": "client.authentication.k8s.io/v1beta1"
      },
      "tlsClientConfig": { "insecure": false, "caData": "<base64 cluster CA>" }
    }
```

The full chain: create the IAM role on the spoke account with a trust policy scoped to the hub's IRSA role → create an EKS access entry mapping that role to a Kubernetes group → bind that group to a scoped `ClusterRole` (not cluster-admin) → grant the hub's IRSA service account `sts:AssumeRole` → apply the Secret → verify with `argocd cluster list`. A `Successful` status confirms the exec plugin chain worked end to end.

---

## Cluster Registration — AKS

On AKS, the equivalent is Azure AD Workload Identity with the `kubelogin` exec plugin:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: spoke-aks-prod-westeurope
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: spoke-aks-prod-westeurope
  server: https://spoke-aks-prod-dns-a1b2c3d4.hcp.westeurope.azmk8s.io
  config: |
    {
      "execProviderConfig": {
        "command": "kubelogin",
        "args": [
          "get-token",
          "--login", "workloadidentity",
          "--server-id", "6dae42f8-4368-4678-94ff-3960e28e3630"
        ],
        "apiVersion": "client.authentication.k8s.io/v1beta1"
      },
      "tlsClientConfig": { "insecure": false, "caData": "<base64 cluster CA>" }
    }
```

The full chain: create an Azure AD application + federated identity credential binding the hub's ArgoCD service account to it → grant that application a scoped AKS RBAC role on the spoke cluster → label the hub's ArgoCD service account for workload identity → apply the Secret → verify with `argocd cluster list`. Auth failures here are almost always a `--subject` mismatch in the federated credential or the workload identity label missing from the pod spec.

---

## Decision Framework

| Cluster count | Compliance boundary | Team topology | Recommended pattern |
| --- | --- | --- | --- |
| 2 | None | Single platform team | Hub-and-spoke |
| 3-5 | None | Single or lightly federated | Hub-and-spoke with AppProjects |
| 5-10 | Some (staging vs. prod) | Multiple product teams | Hub-and-spoke, watch controller sharding |
| 10-15 | Regulatory/contractual isolation on specific clusters | Multiple teams, some regulated | Hybrid — hub for general fleet, per-cluster for isolated outliers |
| Any | Air-gapped / no viable hub network path | Any | ArgoCD-per-cluster |

The hybrid row in practice: a platform team running 13 clusters — 10 standard clusters registering against the hub via IRSA/workload identity, plus 3 PCI-scoped clusters each running their own ArgoCD with no network path back to the hub, syncing from a separate access-restricted Git repository. The platform team accepts fragmented visibility for those 3 clusters in exchange for not having to argue, in every audit cycle, that the hub's blast radius doesn't touch the PCI boundary.

---

## Read the Full Article

This is Article 1 of the GitOps in Practice series. The full article includes:

- Hub-and-spoke network reachability deep-dive for EKS (VPC peering, private API server endpoints, Transit Gateway) and AKS (VNet peering, Azure Private Link)
- Complete step-by-step EKS auth chain: IAM role creation, EKS access entry, ClusterRoleBinding, hub-side IRSA policy
- Complete step-by-step AKS auth chain: Azure AD app, federated credential, AKS RBAC role assignment, workload identity label
- Controller sharding mechanics and Redis HA requirements for fleets past 10-15 clusters
- The trust-boundary thinking connecting IRSA/Workload Identity to ArgoCD's cluster auth model
- What's coming in Article 2: repo structure, App-of-Apps, ApplicationSets, and AppProjects

**👉 [Multi-Cluster ArgoCD Architecture — Full Article](https://aloknecessary.in/blogs/multi-cluster-argocd-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=multi-cluster-argocd-architecture)**
