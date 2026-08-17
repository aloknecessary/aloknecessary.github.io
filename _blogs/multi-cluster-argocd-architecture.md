---
title: "Multi-Cluster ArgoCD Architecture: Hub-and-Spoke vs. Per-Cluster, Done Right"
date: 2026-07-31
last_modified_at: 2026-07-31T14:28:00+05:30
author: Alok Ranjan Daftuar
description: "A practical guide to multi-cluster ArgoCD architecture — comparing hub-and-spoke vs. per-cluster patterns, covering EKS and AKS cluster registration mechanics, and a decision framework tied to team topology and compliance boundaries."
excerpt: "Where does ArgoCD live when you go from 1 cluster to 15? Hub-and-spoke vs. ArgoCD-per-cluster, EKS and AKS cluster registration mechanics, and a decision framework tied to team topology and compliance boundaries."
keywords: "argocd, multi-cluster, gitops, hub-and-spoke, eks, aks, kubernetes, platform engineering, cluster registration, workload identity"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [argocd, gitops, kubernetes, multi-cluster, eks, aks, platform-engineering]
series: "GitOps in Practice"
series_order: 1
---

Every ArgoCD tutorial ends the same way: one cluster, one ArgoCD instance, `kubectl config current-context` pointing at the same place ArgoCD is installed. It works, and it teaches you the sync loop. It does not teach you the thing that actually determines whether your GitOps platform holds up: **where does ArgoCD live once you have more than one cluster to manage?**

That question shows up faster than most teams expect. Two clusters — dev and prod — is enough to force the decision. By the time you're at 10 or 15, across AWS and Azure, with multiple teams pushing through the same pipeline, the architecture you picked on day one is either quietly paying for itself or quietly costing you an incident a quarter.

This article covers the two dominant patterns, the EKS and AKS mechanics for registering a spoke cluster with a hub, and a decision framework for picking between them based on cluster count, compliance boundaries, and team topology.

<!--more-->

## Two failure modes, not one

Teams tend to back into one of two bad defaults rather than choosing deliberately:

1. **ArgoCD-per-cluster sprawl** — every cluster gets its own ArgoCD because that's what the getting-started guide showed. Nobody has a single view of what's deployed where. Upgrading ArgoCD itself becomes N separate change requests.
2. **A single hub ArgoCD that becomes a bottleneck** — one team stands up ArgoCD once, registers every cluster against it because it's the path of least resistance, and doesn't revisit that decision until the application controller is falling behind on reconciliation or a hub outage takes down deployments for every team at once.

Neither is wrong in every context — that's the point of the decision framework at the end of this piece. But both become wrong when applied past the cluster count and team topology they were reasonable for.

## Pattern 1: Hub-and-spoke

One management cluster runs ArgoCD. Every other cluster — call them spokes — is registered as a remote destination via a `Secret` containing that cluster's API server address and credentials. The hub's application controller reconciles Applications across all of them.

**What you get:**

- A single pane of glass — one Argo UI, one place to check sync status across every environment and cluster
- Centralized RBAC and SSO — one set of ArgoCD projects and policies, not N copies to keep in sync
- One audit trail for who synced what, where

**What it costs you:**

- The hub cluster becomes a scaling bottleneck. The application controller reconciles every Application across every spoke; at high cluster or Application count, you're tuning controller concurrency and Redis cache behavior instead of shipping features.
- Blast radius. If the hub is compromised or misconfigured, every spoke's deployment pipeline is affected, not just one team's.
- Network reachability requirements — the hub's application controller needs a path to every spoke's Kubernetes API server, which means real network design, not just an IAM policy.

The blast-radius point is easy to state abstractly and easy to underestimate in practice. Two shapes it tends to take:

- **Redis under memory pressure.** ArgoCD's application controller leans on Redis for its cache of live-vs-desired state across every Application it manages. Push Application count up without revisiting Redis sizing, and an OOM or eviction storm on that single Redis instance stalls reconciliation for every cluster the hub manages at once — not just the cluster that grew. From the outside this looks like "ArgoCD is stuck" everywhere simultaneously, and the root cause is capacity planning on a component most teams treat as an implementation detail.
- **A quietly broken peering path.** A security group rule tightened on one spoke's cluster security group, or a route table entry dropped during a VPC cleanup, doesn't fail loudly. It shows up as that one spoke going `Unknown` in the ArgoCD UI while everything else stays green — easy to dismiss as a blip until someone needs to ship a fix to that cluster and can't.

Neither is exotic. Both are the direct cost of putting one control plane in the path of every cluster's deployments, and worth planning monitoring and capacity headroom around before they show up as a page.

### Network reachability

This is the part hub-and-spoke tutorials skip, and it's where the architecture either works cleanly or turns into a debugging session involving three different teams.

**On AWS**, if the hub and spokes are EKS clusters in the same account, VPC peering or a Transit Gateway gets the hub's control plane traffic to each spoke's API server endpoint. If the spokes are private EKS clusters (API server endpoint not publicly reachable — which it usually shouldn't be), the hub needs a route to the private endpoint, which means peering plus the right security group rules on the spoke's cluster security group.

**On Azure**, the equivalent is VNet peering between the hub's VNet and each spoke AKS cluster's VNet, or Azure Private Link if the AKS API server is private. Same shape of problem: the hub's egress needs a routable, authorized path to a spoke's control plane, and that's a networking decision independent of ArgoCD itself.

If you've already read the [private-endpoints piece](/blogs/hidden-cost-of-private-endpoints-everywhere/) in the Cloud Defaults Reconsidered series, this is the same tradeoff showing up again: private API server endpoints are the right default for spoke clusters, but every private-by-default decision adds a network path the hub now has to be deliberately connected to. Nothing here is free — it's a cost you're choosing to pay for reduced exposure, not a cost you can architect away.

### A note on HA, once you're past 10 clusters

Below roughly five clusters, the default ArgoCD installation's single application controller replica is fine. Past 10-15, or once Application count climbs into the hundreds, you'll start to notice reconciliation lag — changes taking longer to sync than your team is comfortable with.

A representative shape of this: a hub managing 12 spoke clusters with roughly 50 Applications each (600 total) on a single, unsharded application controller. Sync status starts lagging live cluster state by 3-4 minutes during normal operation, and considerably longer right after a bulk change — a shared Helm chart bump that touches 80 Applications at once, for instance. The fix is splitting the controller into multiple replicas, each responsible for a subset of clusters:

```yaml
# argocd-application-controller StatefulSet, patched via kustomize or Helm values
spec:
  replicas: 4
```

```yaml
# Each cluster Secret gets a shard annotation, distributing clusters across the 4 replicas
apiVersion: v1
kind: Secret
metadata:
  name: spoke-eks-prod-us-east-1
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
  annotations:
    argocd.argoproj.io/shard: "2"
```

With `ARGOCD_CONTROLLER_REPLICAS=4` set on the controller and shard annotations spread across the 12 spoke secrets, each replica ends up watching 3 clusters instead of one replica watching all 12 — reconciliation lag on the environment above drops back to single-digit seconds under normal load. The other half of this fix is Redis: a single non-HA Redis instance becomes the new bottleneck once four controller replicas are hitting it concurrently, so this change generally isn't complete without also moving to a Redis HA deployment (Sentinel-backed, which the ArgoCD Helm chart supports as a values flag) at the same time. Sharding strategy in more depth — static shard assignment vs. dynamic, and how to reshard without a reconciliation gap — is a big enough topic to earn its own treatment later in this series rather than a paragraph here. The callout for now: know the fix exists, and don't wait until reconciliation lag is a live incident to learn about it.

## Pattern 2: ArgoCD-per-cluster

Each cluster runs its own ArgoCD instance and manages only itself.

**What you get:**

- Fault isolation — one cluster's ArgoCD having a bad day doesn't touch any other cluster's deployments
- No cross-cluster network dependency — ArgoCD only ever talks to the API server it's running on
- A clean mental model: cluster is the unit of failure, and ArgoCD's blast radius matches it exactly

**What it costs you:**

- N places to upgrade and patch. ArgoCD CVEs are not rare; per-cluster means a fleet-wide upgrade every time
- Fragmented visibility — there's no single place to answer "what's the sync status of the payments service across all our clusters"
- RBAC and project configuration duplicated N times, with all the drift that implies unless you're managing ArgoCD's own config as code (which you should be, either way)

**Where this genuinely wins:** regulated environments where a cluster's isolation boundary is a compliance requirement, not a preference; air-gapped clusters with no viable network path back to a central hub; edge deployments where the whole point is that each site operates independently of a central control plane. In those cases, the "cost" of per-cluster ArgoCD is actually the isolation you're paying for on purpose.

## Cluster registration and auth — EKS

Registering a spoke EKS cluster with a hub ArgoCD instance means the hub's `argocd-application-controller` needs valid Kubernetes credentials for the spoke, stored as a `Secret` in the hub's `argocd` namespace.

The clean way to do this on EKS is IAM Roles for Service Accounts (IRSA), or EKS access entries if you're on a newer cluster version that supports them directly, rather than a static kubeconfig with a long-lived token. The cluster secret uses the `aws-iam-authenticator` (or `aws eks get-token`) exec plugin so the hub authenticates to the spoke using a short-lived, assumable IAM role rather than a credential that sits in a Secret forever.

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
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64 cluster CA>"
      }
    }
```

The IAM role referenced (`argocd-hub-spoke-access`) needs to be mapped in the spoke cluster's `aws-auth` ConfigMap (or, on newer EKS versions, an access entry) to a Kubernetes RBAC identity scoped to exactly what ArgoCD needs — typically a `ClusterRole` allowing management of the resource kinds your Applications actually deploy, not cluster-admin. The hub's own IAM role or IRSA-bound service account then needs `sts:AssumeRole` permission on that role. This is the same "who can assume what, and what does that identity map to" chain your OIDC work already established for CI — the mechanics are different, the trust-boundary thinking is identical.

Putting the full chain together, end to end:

**1. Create the role the hub will assume, on the spoke's account** (trust policy restricted to the hub's IRSA role, not open to the account):

```bash
aws iam create-role \
  --role-name argocd-hub-spoke-access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::999900001111:role/argocd-hub-irsa" },
      "Action": "sts:AssumeRole"
    }]
  }'
```

**2. Grant that role an EKS access entry on the spoke cluster**, mapped to a Kubernetes group rather than directly to a role — this keeps the RBAC binding declarative and reviewable:

```bash
aws eks create-access-entry \
  --cluster-name spoke-eks-prod \
  --principal-arn arn:aws:iam::111122223333:role/argocd-hub-spoke-access \
  --kubernetes-groups argocd-hub-access
```

**3. Bind that Kubernetes group to a scoped ClusterRole**, not `cluster-admin`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: argocd-hub-access-binding
subjects:
  - kind: Group
    name: argocd-hub-access
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: argocd-hub-access-role   # scoped to Deployments, Services, ConfigMaps, etc. — not "*"
  apiGroup: rbac.authorization.k8s.io
```

**4. On the hub side**, grant the hub's IRSA-bound service account `sts:AssumeRole` on `argocd-hub-spoke-access` via an inline policy, apply the cluster Secret shown above, then verify:

```bash
argocd cluster list
# NAME                        SERVER                                                          STATUS      MESSAGE
# spoke-eks-prod-us-east-1    https://EXAMPLE1234567890.gr7.us-east-1.eks.amazonaws.com        Successful
```

A `Successful` status confirms the exec plugin chain worked end to end: the hub assumed the role, exchanged it for a token via `aws eks get-token`, and that token was accepted by the spoke's access entry. If it instead shows `Unknown` or an auth error, the fault is almost always in step 1 (trust policy scoped too narrowly or to the wrong principal ARN) or step 2 (access entry pointing at a role ARN that doesn't match what the hub actually assumes) — check those two before touching RBAC.

## Cluster registration and auth — AKS

On AKS, the equivalent short-lived-credential path is Azure AD Workload Identity: the hub's ArgoCD pod is bound to a Kubernetes service account federated with an Azure AD application, which is then granted Azure Kubernetes Service RBAC access on the spoke cluster. Authentication happens through the `kubelogin` exec plugin, which exchanges an Azure AD token for a Kubernetes-usable one at connection time rather than relying on a static kubeconfig.

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
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64 cluster CA>"
      }
    }
```

The `server-id` above is the well-known AKS AAD server application ID, constant across tenants. What varies per environment is the federated identity credential binding the hub's ArgoCD service account to an Azure AD application, and the Azure Kubernetes Service RBAC role assignment on the spoke cluster that grants that application scoped access — again, matched to the resource kinds ArgoCD actually manages, not `Azure Kubernetes Service RBAC Cluster Admin`.

If you're running AKS with Entra ID-integrated cluster authentication already (most production AKS clusters should be), this fits directly into that model rather than working around it — the hub's identity is just one more Entra-authenticated caller, scoped down.

The full chain, mirroring the EKS steps above:

**1. Create the Azure AD application and federated identity credential**, binding the hub's ArgoCD Kubernetes service account (namespace + service account name, on the hub cluster) to it — this is what lets the hub's pod present a token Azure AD will trust, with no stored secret:

```bash
az ad app create --display-name argocd-hub-spoke-access

az identity federated-credential create \
  --name argocd-hub-workload-identity \
  --identity-name argocd-hub-spoke-access \
  --resource-group platform-rg \
  --issuer "$(az aks show -g platform-rg -n hub-aks --query oidcIssuerProfile.issuerUrl -o tsv)" \
  --subject system:serviceaccount:argocd:argocd-application-controller \
  --audience api://AzureADTokenExchange
```

**2. Grant that application's managed identity a scoped Azure Kubernetes Service RBAC role on the spoke cluster** — `Azure Kubernetes Service RBAC Writer` or a custom role restricted to the resource kinds ArgoCD manages, not `Cluster Admin`:

```bash
az role assignment create \
  --assignee-object-id "$(az identity show -g platform-rg -n argocd-hub-spoke-access --query principalId -o tsv)" \
  --role "Azure Kubernetes Service RBAC Writer" \
  --scope "$(az aks show -g platform-rg -n spoke-aks-prod --query id -o tsv)"
```

**3. Label the hub's ArgoCD service account for workload identity**, so the pod actually picks up the federated token exchange at runtime:

```bash
kubectl label serviceaccount argocd-application-controller \
  -n argocd \
  azure.workload.identity/use=true
```

**4. Apply the cluster Secret shown above, then verify the same way as EKS:**

```bash
argocd cluster list
# NAME                              SERVER                                                        STATUS      MESSAGE
# spoke-aks-prod-westeurope         https://spoke-aks-prod-dns-a1b2c3d4.hcp.westeurope.azmk8s.io  Successful
```

As with EKS, an auth failure here is rarely an RBAC problem on first pass — it's almost always the federated credential's `--subject` not exactly matching the hub's service account namespace and name, or the workload identity label missing from the pod spec, so the token exchange never happens in the first place.

## Decision framework

None of this has a universally correct answer — it's a tradeoff, the same way Multi-AZ and private endpoints are tradeoffs rather than defaults to apply blindly. Here's how cluster count, compliance boundary, and team topology tend to point the decision:

| Cluster count | Compliance boundary | Team topology | Recommended pattern |
| --- | --- | --- | --- |
| 2 | None / shared ownership | Single platform team | Hub-and-spoke — the overhead of per-cluster ArgoCD isn't justified yet |
| 3-5 | None | Single or lightly federated teams | Hub-and-spoke, with AppProjects for isolation (covered in Article 2) |
| 5-10 | Some (e.g., staging vs. prod separation) | Multiple product teams | Hub-and-spoke, with attention to controller sharding as you approach the top of this range |
| 10-15 | Regulatory or contractual isolation on specific clusters | Multiple teams, some regulated workloads | Hybrid — hub-and-spoke for the general fleet, ArgoCD-per-cluster carved out for the clusters with a hard isolation requirement |
| Any | Air-gapped or no viable hub network path | Any | ArgoCD-per-cluster, no real alternative |

The hybrid row is worth calling out explicitly: hub-and-spoke and per-cluster aren't mutually exclusive across your whole fleet. It's common, and reasonable, to run a hub for most clusters and carve out per-cluster ArgoCD instances for the specific clusters where compliance or network isolation makes a hub connection the wrong answer — rather than forcing one pattern to fit every cluster you own.

A concrete version of that row: a platform team running 13 clusters — 10 standard product-team clusters (dev, staging, prod across a handful of services) plus 3 clusters carrying PCI-scoped payment workloads, where the compliance requirement is explicit network and control-plane isolation from anything outside the PCI boundary. The 10 standard clusters register against the hub exactly as described above — IRSA or workload identity, one Argo UI, one RBAC model. The 3 PCI clusters each run their own ArgoCD instance instead, with no network path back to the hub at all, syncing from a separate, access-restricted Git repository. The platform team accepts fragmented visibility for those 3 clusters specifically — a small, known cost — in exchange for not having to argue, in every audit cycle, that the hub's blast radius doesn't touch the PCI boundary. That's the hybrid pattern in practice: not a compromise applied everywhere, but hub-and-spoke as the default with per-cluster carved out exactly where the compliance boundary demands it.
