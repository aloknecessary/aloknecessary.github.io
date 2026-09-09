---
layout: blog
title: "Secrets Management in a GitOps World: Sealed Secrets vs. External Secrets Operator vs. Vault"
date: 2026-08-25
last_modified_at: 2026-08-25T12:35:47+05:30
author: Alok Ranjan Daftuar
description: "A practical comparison of Sealed Secrets, External Secrets Operator, and Vault for managing secrets in a GitOps pipeline — covering what each approach actually protects against and where each one breaks down."
excerpt: "GitOps means everything a cluster needs lives in Git. Secrets very much don't belong in Git. Three ways teams actually resolve that contradiction, and what each one is really protecting against."
keywords: "gitops secrets management, sealed secrets, external secrets operator, vault agent injector, kubernetes secrets, argocd secrets, secrets rotation, gitops security"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [argocd, gitops, kubernetes, secrets, external-secrets-operator, vault, sealed-secrets, platform-engineering, aws, security]
series: "GitOps in Practice"
series_order: 4
---

> Three approaches resolve the core GitOps contradiction: everything the cluster needs is declared in a repo ArgoCD watches, but secrets can't safely live in that repo. Each approach breaks the "it's all just committed to Git" assumption in a different place.

Articles 1 through 3 built up a GitOps pipeline that's consistent about one thing: the Git repo is the source of truth. Article 1 covered where ArgoCD lives ([Multi-Cluster ArgoCD Architecture](/blogs/multi-cluster-argocd-architecture/)), Article 2 covered how Applications get generated from repo structure ([GitOps Repo Structure and Application Patterns](/blogs/gitops-repo-structure-application-patterns/)), Article 3 covered how CI hands off a new image reference into that same repo ([CI to GitOps Handoff](/blogs/ci-to-gitops-handoff/)). All of it rests on the assumption that whatever's in Git is safe to have in Git.

A database password isn't safe to have in Git. Neither is an API key, a TLS private key, or a service account credential — even in a private repo, even with tight access control, because Git history is forever and "who had read access to this repo eighteen months ago" is a much harder question to answer than "who has read access today." GitOps's core premise — everything the cluster needs is declared in a repo ArgoCD watches — runs directly into that constraint. Three approaches resolve it, each by breaking the "it's all just committed to Git" assumption in a different place.

## The shape of the problem

Before comparing tools, it's worth being precise about what "solving" secrets in GitOps actually means, because the three approaches solve different parts of it:

- **Never having the plaintext secret in Git, ever** — not even encrypted-and-committed, if the encryption key itself has a way to leak.
- **Rotating secrets without a Git commit** — if rotating a database password means someone has to open a PR, that's friction that guarantees rotation happens less often than it should.
- **Scoping which cluster, namespace, or Application can see which secret** — the same multi-tenancy question Article 2's AppProjects answered for Applications, but for secret values specifically.

No single approach here scores well on all three by default — each is a different set of tradeoffs, not a strictly better option.

```text
Sealed Secrets
  plaintext ──(kubeseal, client-side)──► ciphertext ──► committed to Git
                                                              │
                                                              ▼
                                          in-cluster controller (holds private key)
                                                              │ decrypts at apply time
                                                              ▼
                                                    Kubernetes Secret object

External Secrets Operator
  plaintext ──► lives only in AWS Secrets Manager / Azure Key Vault / Vault
                                                              ▲
                                                              │ fetched on refreshInterval
  ExternalSecret (just a reference — key path only) ──► ESO controller
        │
        └── committed to Git — contains no sensitive value at all
                                                              │
                                                              ▼
                                                    Kubernetes Secret object

Vault Agent Injector
  plaintext ──► lives only in Vault
                                                              ▲
                                                              │ fetched at Pod startup,
                                                              │ via Kubernetes auth method
  Pod annotations (role + path — no value) ──► Vault Agent sidecar
        │
        └── committed to Git — contains no sensitive value at all
                                                              │
                                                              ▼
                                        file mounted into Pod filesystem
                                        (no Kubernetes Secret object created)
```

The pattern across all three: Git only ever holds something that's useless without a second thing it doesn't have access to — a private key, a cloud IAM role, or a Vault auth method. That's the actual security property being bought here, not "the secret is encrypted" in isolation.

## Sealed Secrets

Bitnami's Sealed Secrets takes the most literal path to "it's fine to commit this to Git": encrypt the secret client-side with a public key, commit the resulting `SealedSecret` resource, and let a controller running in-cluster — the only holder of the matching private key — decrypt it into a normal Kubernetes `Secret` at apply time.

```bash
kubectl create secret generic checkout-db-creds \
  --dry-run=client \
  --from-literal=password='REPLACE_ME' \
  -o yaml | kubeseal --format yaml > checkout-db-creds-sealed.yaml
```

```yaml
# checkout-db-creds-sealed.yaml — safe to commit
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: checkout-db-creds
  namespace: checkout
spec:
  encryptedData:
    password: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEQ...
```

**What it gets you:** genuinely nothing sensitive ever touches Git — the ciphertext is only decryptable by the controller holding the private key, so a leaked repo (or a leaked Git history) doesn't leak the secret. No external dependency — it's a self-contained controller, no Vault cluster or cloud secrets service to run alongside it.

**What it doesn't get you:** rotation still requires a commit. Changing the database password means re-sealing and re-committing the `SealedSecret`, same PR friction as any other manifest change — Sealed Secrets solves the "safe in Git" problem, not the "rotation shouldn't require Git" problem.

A representative shape of that cost: a security policy requiring database credentials to rotate every 90 days, applied to a fleet of 40 services each with their own `SealedSecret`. In practice that's 40 separate re-seal-and-commit operations every quarter, each needing someone with `kubeseal` access to the right cluster's public key at the time rotation is due — not a single scheduled job, because Sealed Secrets has no mechanism for a controller to rotate a value on its own; the new plaintext has to originate somewhere a human or an external automation step controls, then get re-sealed. Teams that start with Sealed Secrets at a handful of services and grow past that count tend to discover this cost exactly when a compliance audit asks for evidence of rotation cadence — worth sizing before committing to the approach at scale, not after.

It's also cluster-scoped by design: the private key lives on one cluster's controller, so a `SealedSecret` sealed for cluster A's public key is meaningless on cluster B. At the multi-cluster scale from Article 1, that means either re-sealing the same secret per cluster, or restricting which secrets Sealed Secrets manages to genuinely cluster-local ones — it doesn't have a native answer for "this secret needs to exist, correctly, across all twelve spoke clusters."

## External Secrets Operator

External Secrets Operator (ESO) inverts the model entirely: the secret's actual value never enters Git at all, not even encrypted. What's committed is a reference — "fetch this key from AWS Secrets Manager" or "fetch this key from Azure Key Vault" — and a controller in-cluster resolves that reference into a real `Secret` by calling out to the actual secrets backend at sync time.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: checkout
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: checkout-eso-sa
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: checkout-db-creds
  namespace: checkout
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: checkout-db-creds
  data:
    - secretKey: password
      remoteRef:
        key: checkout-service/prod/db-password
```

Both of those manifests are entirely safe to commit — there's no ciphertext, no encoded value, nothing to leak. What's sensitive is `checkout-service/prod/db-password`'s *value*, and that lives in AWS Secrets Manager (or Azure Key Vault, or GCP Secret Manager, or Vault itself — ESO supports all of them through the same `SecretStore` abstraction), never in the cluster's Git repo at any point.

The `auth.jwt.serviceAccountRef` in the `SecretStore` is the same IRSA/workload-identity pattern from Article 1's cluster registration walkthrough — ESO's controller assumes a scoped IAM role or federated Azure AD identity to read from the secrets backend, rather than holding a static credential. That consistency matters: it means the auth-chain thinking from Article 1 (short-lived, assumable, scoped-not-broad) extends cleanly into secrets management instead of needing a separate credential model bolted on.

**What it gets you:** rotation with zero Git commits — update the value in Secrets Manager or Key Vault, and every `ExternalSecret` referencing it picks up the change on its next `refreshInterval` cycle, no PR required. Centralized secret storage, so the same underlying secrets service you'd use for non-Kubernetes workloads covers Kubernetes too, rather than maintaining a Kubernetes-specific secrets story alongside a separate one for everything else.

**What it doesn't get you:** a live dependency on the secrets backend being reachable from every cluster running ESO — which reintroduces exactly the network-reachability planning from Article 1's hub-and-spoke section, this time for every spoke's path to AWS Secrets Manager or Azure Key Vault rather than to a hub. And ESO's `ExternalSecret` resources are legible about *which* secret exists — the key path `checkout-service/prod/db-password` is right there in a committed manifest — even though the value isn't. For most teams that's an acceptable, even useful, level of transparency; for a small number of extremely sensitive systems, even the existence and naming of a secret being visible in Git is more disclosure than the compliance posture allows.

The multi-tenancy question from Article 2's AppProjects applies here too, and it's worth being just as deliberate about it. A `SecretStore` scoped with an overly broad IAM role — one that can read every key under `checkout-service/*` in Secrets Manager, say, rather than the specific `db-password` key a given `ExternalSecret` actually needs — means a compromised or misconfigured `ExternalSecret` in one namespace can pull secrets that namespace was never meant to see. The fix mirrors Article 2's AppProject `destinations` restriction almost exactly: scope the IAM policy behind each `SecretStore` to the narrowest key path prefix that namespace or team actually owns, the same way an AppProject's `destinations` list narrows which clusters and namespaces an Application can reach, rather than granting broad read access once for convenience.

## Vault plugin (Vault Agent / CSI provider)

Where ESO pulls a secret into a Kubernetes `Secret` object, HashiCorp Vault's Kubernetes integrations more often avoid creating a `Secret` object at all. The two common patterns — Vault Agent Injector (sidecar-based) and the Secrets Store CSI Driver's Vault provider — mount secrets directly into a Pod's filesystem as files, at Pod startup, authenticated via Kubernetes' own service account token exchanged against Vault's Kubernetes auth method.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-service
  namespace: checkout
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: checkout-service
        vault.hashicorp.com/agent-inject-secret-db-creds: secret/data/checkout-service/prod/db
    spec:
      serviceAccountName: checkout-service
      containers:
        - name: checkout-service
          image: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service:v1.4.2
          # application reads the secret from the injected file path,
          # e.g. /vault/secrets/db-creds — never from an env var or ConfigMap
```

**What it gets you:** the closest thing to "the secret was never a Kubernetes API object" — no `Secret` resource exists to be over-broadly RBAC'd, listed via `kubectl get secrets`, or accidentally dumped in a debug script that logs all Secret data in a namespace. Fine-grained, short-lived leases are native to Vault's model — a database credential injected this way can be scoped to expire and auto-rotate on a timeline Vault enforces, not one your team has to build.

That last point is worth making concrete, since it's the sharpest contrast with the other two approaches. Vault's database secrets engine can generate a unique, short-lived database username and password per Pod, on demand, with a lease duration Vault itself enforces — a 1-hour lease means Vault revokes that specific credential at the database level after an hour, independent of whether the Pod is still running or whether anyone remembered to rotate anything. Compare that to the 90-day manual re-seal cycle described in the Sealed Secrets section: Vault's dynamic credential model doesn't just make rotation less painful, it changes rotation from "a scheduled human or automation task" into "an enforced property of every credential issued," which is a meaningfully different compliance posture, not just a convenience improvement.

**What it doesn't get you:** for free, simplicity. Running Vault well — unsealing, storage backend, HA, policy management — is a genuinely larger operational commitment than either of the other two approaches, and it's not one you'd take on for secrets management alone if you don't already have other reasons to run Vault (dynamic database credentials, PKI issuance, and similar Vault-native capabilities beyond static secret storage). If Vault isn't already part of your platform, adopting it purely to solve the GitOps secrets problem is usually the wrong-sized tool for the job.

## Decision framework

| Situation | Recommended approach |
| --- | --- |
| Small team, few clusters, no external secrets backend already in use, rotation cadence is low | Sealed Secrets — simplest, no external dependency |
| Already using AWS Secrets Manager, Azure Key Vault, or another cloud-native secrets service for non-Kubernetes workloads | External Secrets Operator — extends existing secret storage into Kubernetes rather than duplicating it |
| Multi-cluster fleet from Article 1, secrets need to exist consistently across many clusters without per-cluster re-sealing | External Secrets Operator — the reference-not-value model isn't cluster-scoped the way Sealed Secrets is |
| Already running Vault for dynamic database credentials, PKI, or other Vault-native capabilities | Vault Agent Injector or CSI provider — extends a tool you're already operating rather than introducing a second secrets story |
| Extremely sensitive secrets where even a `Secret` object existing in the cluster's API is more exposure than acceptable | Vault, via the injector pattern — no `Secret` object is ever created |

As with every table in this series, these aren't exclusive: it's entirely reasonable to run ESO for the bulk of a fleet's secrets and reserve Vault's injector pattern specifically for the small set of credentials — often database creds needing dynamic, short-lived leases — that justify the added operational weight. The decision isn't "pick the best tool once," it's "match each secret's actual sensitivity and rotation requirement to the approach that handles it well," which for most fleets means at least two of these three coexisting rather than a single tool covering everything uniformly.

## What's next

Every article so far has assumed a sync goes well: Application syncs, image updates, secret resolves, done. Article 5 covers what happens when it doesn't — Argo Rollouts, canary and blue-green strategies, and the AnalysisTemplates that decide, automatically, whether a rollout should proceed or reverse.
