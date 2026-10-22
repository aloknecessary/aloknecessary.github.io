---
title: "Drift, Self-Heal, and Failure Modes: When ArgoCD's Reconciliation Loop Fights Something Else"
published: false
description: A practical map of where ArgoCD's auto-sync and self-heal break down — HPA replica oscillation, sync-wave partial failure, and operator-owned field conflicts — and how to fix each one.
tags: gitops, argocd, kubernetes, devops
canonical_url: https://aloknecessary.in/blogs/gitops-drift-self-heal-failure-modes/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-drift-self-heal-failure-modes
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a Kubernetes reconciliation loop in conflict — two opposing force arrows pulling at the same resource object, one labelled Git and one labelled HPA, with neon circuit lines oscillating between them. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Auto-sync and self-heal are usually presented as unambiguous wins. They are — right up until something else in the cluster has a legitimate reason to change the same resource ArgoCD thinks it owns exclusively. When that happens, the result isn't a clear error. It's a quiet oscillation that looks like ArgoCD misbehaving, when it's actually doing exactly what it was told.

This article maps the three most common shapes of that collision, why each one happens, and the precise fix for each.

---

## What Self-Heal Actually Does

ArgoCD's `OutOfSync` status means live cluster state doesn't match what's declared in Git. With `selfHeal: true`, ArgoCD doesn't just refuse to accept the drift — it actively overwrites it back to the Git-declared state on every reconciliation pass.

```yaml
spec:
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

That's the right default for almost everything a Deployment touches directly. The failure modes below all share one shape: a resource ArgoCD considers itself the sole owner of is also, legitimately, being modified by something else that has no idea ArgoCD exists.

---

## HPA vs. Self-Heal: The Replica Count Fight

This is the most common collision. A `HorizontalPodAutoscaler` manages `spec.replicas` dynamically. Git, in a naive GitOps setup, also declares `spec.replicas`. The result:

```text
Load spikes ──► HPA scales Deployment to 8 replicas
                        │
                        ▼
        ArgoCD reconciliation runs
                        │
                        ▼
        Live replicas (8) != Git-declared replicas (3)
                        │
                        ▼
        selfHeal reverts Deployment back to 3 replicas
                        │
                        ▼
        HPA scales back to 8
                        │
                        └──── repeats every reconciliation interval
```

At a 3-minute reconciliation interval during a traffic spike, this produces roughly ten full oscillation cycles over 30 minutes — the service spends a meaningful fraction of the spike window under-provisioned, and the sawtoothing replica count reads as ArgoCD being broken rather than working exactly as configured.

The fix is `ignoreDifferences` scoped to that field:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: checkout-service
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

ArgoCD stops treating `spec.replicas` as part of what it reconciles for this resource. The HPA becomes the sole owner of that field. Worth auditing across every HPA-managed Deployment in a fleet before `selfHeal: true` is enabled fleet-wide — not reactively after the first incident.

---

## Sync Waves and Partial Failure

Sync-wave ordering is a *sequencing* guarantee, not a *transactional* one. A wave-0 database migration Job that fails partway through doesn't roll back what wave-1 already applied — the Deployment's Pods may already be running against a schema mid-migration before ArgoCD retries wave 0.

For anything where partial application genuinely can't be tolerated, a `PreSync` hook with `hook-failure-policy: Abort` is the safer pattern:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-failure-policy: Abort
```

`Abort` stops the entire sync — including later waves — the moment the hook fails, rather than leaving later waves to apply against a database that's still mid-migration. Self-heal's retry behavior on a failed wave is useful for transient failures; it's the wrong tool when partial application has real consequences.

---

## Operators Mutating ArgoCD-Owned Resources

The third shape is structurally identical to the HPA case: a Kubernetes operator — a cert-manager controller, a service mesh sidecar injector, a mutating admission webhook — modifying a field on a resource ArgoCD also tracks. ArgoCD sees a live-vs-Git diff, self-heal reverts it, the operator re-mutates it, and the oscillation repeats.

The fix is identical — `ignoreDifferences` scoped to the contested field:

```yaml
spec:
  ignoreDifferences:
    - group: ""
      kind: Pod
      jsonPointers:
        - /spec/containers/0/resources
```

The harder part isn't the fix — it's noticing the collision exists. Unlike the HPA case, which announces itself through a visibly oscillating replica count, a webhook fight over a less visible field presents as intermittent `OutOfSync` with no obvious pattern. When an Application shows unexplained intermittent drift, check `kubectl get events` on the affected resource and the list of registered mutating webhooks before assuming the drift is a Git or ArgoCD problem.

---

## Decision Framework

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Replica count oscillates on a fixed interval | HPA fighting a Git-declared `spec.replicas` | `ignoreDifferences` on `/spec/replicas` |
| Downstream Application fails with no clear cause after a transient upstream wave failure | Sync-wave retry without transactional guarantees | `PreSync` hook with `hook-failure-policy: Abort` |
| `OutOfSync` appears and clears with no clear pattern on a specific field | Mutating webhook or operator modifying a field ArgoCD tracks | `ignoreDifferences` scoped to the contested field |
| Unclear which field is contested | Diff noise | `argocd app diff <app-name>` against live state to identify the exact field before scoping `ignoreDifferences` |

---

## Read the Full Article

The full article covers:

- The precise mechanism of `selfHeal: true` and why it's correct by default
- The HPA oscillation failure at real numbers — 10 oscillation cycles over a 30-minute traffic spike, what it looks like on a dashboard, and why it reads as ArgoCD being broken
- The sync-wave partial failure scenario in detail — a backfill Job, a lock timeout, and application code reading nulls it wasn't written to handle
- The service mesh sidecar injector collision — why it presents as intermittent `OutOfSync` with no obvious trigger, and how to trace it to the actual controller
- Series takeaways across all six articles — the thread connecting hub-and-spoke architecture, ApplicationSets, CI handoff, secrets management, progressive delivery, and failure modes into one coherent GitOps discipline

**👉 [Drift, Self-Heal, and Failure Modes — Full Article](https://aloknecessary.in/blogs/gitops-drift-self-heal-failure-modes/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-drift-self-heal-failure-modes)**
