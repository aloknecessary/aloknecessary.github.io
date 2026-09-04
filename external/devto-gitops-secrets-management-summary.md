---
title: "Secrets Management in a GitOps World: Sealed Secrets vs. External Secrets Operator vs. Vault"
published: false
description: A practical comparison of three approaches to secrets management in a GitOps pipeline — what each one actually protects against, where each breaks down, and how to choose between them.
tags: gitops, kubernetes, devops, security
canonical_url: https://aloknecessary.in/blogs/gitops-secrets-management-/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-secrets-management-
cover_image:
---

GitOps means everything a cluster needs lives in Git. Secrets very much don't belong in Git — not even in a private repo, because Git history is forever and "who had read access eighteen months ago" is a much harder question than "who has read access today."

Three approaches resolve that contradiction. Each breaks the "it's all just committed to Git" assumption in a different place, and each solves a different subset of the actual problem.

---

## What "Solving" Secrets in GitOps Actually Means

Before comparing tools, it's worth being precise about what's being solved — because the three approaches solve different parts of it:

- **Never having plaintext in Git** — not even encrypted-and-committed, if the encryption key itself can leak
- **Rotating secrets without a Git commit** — if rotation requires a PR, it happens less often than it should
- **Scoping which cluster or namespace can see which secret** — the same multi-tenancy question AppProjects answer for Applications, but for secret values

No single approach scores well on all three by default. Each is a different set of tradeoffs.

---

## Sealed Secrets

Bitnami's Sealed Secrets takes the most literal path: encrypt the secret client-side with a public key, commit the resulting `SealedSecret` resource, and let an in-cluster controller — the only holder of the matching private key — decrypt it at apply time.

```bash
kubectl create secret generic checkout-db-creds \
  --dry-run=client \
  --from-literal=password='REPLACE_ME' \
  -o yaml | kubeseal --format yaml > checkout-db-creds-sealed.yaml
```

```yaml
# safe to commit — only the in-cluster controller can decrypt this
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: checkout-db-creds
  namespace: checkout
spec:
  encryptedData:
    password: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEQ...
```

**What it gets you:** nothing sensitive ever touches Git. No external dependency — self-contained controller, no Vault cluster or cloud secrets service required.

**What it doesn't get you:** rotation still requires a commit. Changing a database password means re-sealing and re-committing — same PR friction as any other manifest change. At 40 services rotating every 90 days, that's 40 separate re-seal-and-commit operations per quarter, each needing someone with `kubeseal` access to the right cluster's public key at the time rotation is due.

It's also cluster-scoped by design: a `SealedSecret` sealed for cluster A's public key is meaningless on cluster B. At multi-cluster scale, that means either re-sealing per cluster or restricting Sealed Secrets to genuinely cluster-local secrets.

---

## External Secrets Operator

ESO inverts the model entirely: the secret's actual value never enters Git at all. What's committed is a reference — "fetch this key from AWS Secrets Manager" — and a controller resolves that reference into a real `Secret` by calling the secrets backend at sync time.

```yaml
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

This manifest is entirely safe to commit — there's no ciphertext, no encoded value. The sensitive part is the *value* at `checkout-service/prod/db-password`, which lives only in AWS Secrets Manager.

**What it gets you:** rotation with zero Git commits — update the value in Secrets Manager and every `ExternalSecret` referencing it picks up the change on its next `refreshInterval` cycle. Centralized secret storage that extends your existing cloud secrets service into Kubernetes rather than maintaining a separate story.

**What it doesn't get you:** the secrets backend must be reachable from every cluster running ESO — reintroducing the network-reachability planning from multi-cluster architecture, this time for every spoke's path to Secrets Manager or Key Vault.

One scoping risk worth calling out: a `SecretStore` backed by an overly broad IAM role — one that can read every key under `checkout-service/*` rather than the specific key a given `ExternalSecret` needs — means a misconfigured `ExternalSecret` in one namespace can pull secrets it was never meant to see. Scope the IAM policy behind each `SecretStore` to the narrowest key path prefix that namespace actually owns.

---

## Vault Agent Injector

Where ESO pulls a secret into a Kubernetes `Secret` object, Vault's Kubernetes integrations more often avoid creating a `Secret` object at all. The Vault Agent Injector mounts secrets directly into a Pod's filesystem as files, at Pod startup, authenticated via Kubernetes' own service account token exchanged against Vault's Kubernetes auth method.

```yaml
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
          # application reads from /vault/secrets/db-creds — never from an env var
```

**What it gets you:** the closest thing to "the secret was never a Kubernetes API object" — no `Secret` resource exists to be over-broadly RBAC'd, listed via `kubectl get secrets`, or accidentally dumped in a debug script.

More importantly: Vault's database secrets engine can generate a unique, short-lived database username and password *per Pod*, on demand, with a lease duration Vault itself enforces. A 1-hour lease means Vault revokes that specific credential at the database level after an hour, independent of whether anyone remembered to rotate anything. This changes rotation from "a scheduled human task" into "an enforced property of every credential issued" — a meaningfully different compliance posture.

**What it doesn't get you:** simplicity. Running Vault well — unsealing, storage backend, HA, policy management — is a larger operational commitment than either of the other two approaches. If Vault isn't already part of your platform, adopting it purely to solve the GitOps secrets problem is usually the wrong-sized tool.

---

## Decision Framework

| Situation | Recommended approach |
| --- | --- |
| Small team, few clusters, low rotation cadence | Sealed Secrets — simplest, no external dependency |
| Already using AWS Secrets Manager or Azure Key Vault | External Secrets Operator — extends existing storage into Kubernetes |
| Multi-cluster fleet, secrets needed consistently across clusters | External Secrets Operator — reference model isn't cluster-scoped |
| Already running Vault for dynamic credentials or PKI | Vault Agent Injector — extends a tool you're already operating |
| Secrets where even a `Secret` object existing in the cluster is too much exposure | Vault injector — no `Secret` object is ever created |

These aren't exclusive. Running ESO for the bulk of a fleet's secrets and reserving Vault's injector for the small set of credentials needing dynamic short-lived leases is a reasonable production posture — matching each secret's sensitivity to the approach that handles it well.

---

## Read the Full Article

The full article covers:

- The precise three-part definition of what "solving" secrets in GitOps actually means — and why no single tool covers all three
- The 90-day rotation cost at 40 services with Sealed Secrets, and why it surfaces at compliance audit time
- The cluster-scoping limitation of Sealed Secrets at multi-cluster scale
- Full `SecretStore` + `ExternalSecret` YAML with IRSA/workload-identity auth chain
- The IAM scoping risk with ESO and how it mirrors AppProject destinations restriction
- Vault's dynamic credential model explained — why it changes rotation from a task to an enforced property
- How all three approaches compose in a real fleet rather than requiring a single tool choice

**👉 [Secrets Management in a GitOps World — Full Article](https://aloknecessary.in/blogs/gitops-secrets-management-/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-secrets-management-)**
