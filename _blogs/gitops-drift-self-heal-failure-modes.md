---
title: "Drift, Self-Heal, and Failure Modes: When ArgoCD's Reconciliation Loop Fights Something Else"
date: 2026-09-09
last_modified_at: 2026-09-09T12:36:04+05:30
author: Alok Ranjan Daftuar
description: "A practical map of where ArgoCD's auto-sync and self-heal break down — HPA replica oscillation, sync-wave partial failure, and operator-owned field conflicts — and how to fix each one."
excerpt: "Auto-sync and self-heal are usually presented as unambiguous wins. They are, right up until something else in the cluster has a legitimate reason to change the same resource ArgoCD thinks it owns exclusively."
keywords: "argocd, gitops, self-heal, drift, hpa, sync-waves, ignoreDifferences, kubernetes, platform-engineering"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [argocd, gitops, kubernetes, self-heal, hpa, sync-waves, platform-engineering]
series: "GitOps in Practice"
series_order: 6
---

Every article in this series so far has described a pipeline working as designed: Applications generated correctly ([Article 2](/blogs/gitops-repo-structure-application-patterns/)), images landing in Git on schedule ([Article 3](/blogs/ci-to-gitops-handoff/)), secrets resolving cleanly ([Article 4](/blogs/gitops-secrets-management/)), rollouts gating on real analysis ([Article 5](/blogs/argo-rollouts-progressive-delivery/)). That's the right way to learn the pieces, and it's also not what running ArgoCD in production actually feels like most weeks. This closing article covers what happens when the reconciliation loop's core assumption — "Git is the source of truth, and nothing else should be changing this resource" — turns out to be false for a specific resource, and ArgoCD's self-heal behavior meets something else with an equally legitimate claim to changing the same object.

None of what follows is an argument against auto-sync or self-heal. It's a map of exactly where their edges are, so the first time you hit one it's recognizable rather than mysterious.

## Drift, in ArgoCD's own terms

ArgoCD's `OutOfSync` status means the live cluster state doesn't match what's declared in Git. That's the entire mechanism the rest of this article is built on: ArgoCD diffs live state against desired state, and with `selfHeal: true` set, actively reverts any difference it detects — not just refusing to apply the drifted state, but overwriting it back to what Git says, on its next reconciliation pass.

```yaml
spec:
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

That's the right default for almost everything a Deployment touches directly — a manual `kubectl edit` on a ConfigMap that Git also declares should be reverted, and self-heal reverting it is the feature working exactly as intended. The failure modes below all share one shape: a resource ArgoCD's Application considers itself the sole owner of is also, legitimately, being modified by something else that has no idea ArgoCD exists.

## HPA vs. self-heal: the replica count fight

This is the single most common version of the collision, and it's almost always a surprise the first time a team hits it. A `HorizontalPodAutoscaler` manages `spec.replicas` on a Deployment dynamically, scaling up under load and back down when load drops. Git, in a naive GitOps setup, also declares `spec.replicas` — because that's what `kubectl create deployment --dry-run` or a basic Helm chart puts there by default.

```text
Load spikes ──► HPA scales Deployment to 8 replicas
                        │
                        ▼
        ArgoCD's next reconciliation pass runs
                        │
                        ▼
        Live replicas (8) != Git-declared replicas (3)
                        │
                        ▼
        selfHeal: true reverts Deployment back to 3 replicas
                        │
                        ▼
        HPA notices 3 replicas again, scales back to 8
                        │
                        └──── repeats every reconciliation interval
```

Under sustained load, this produces exactly the outcome nobody wants: the Deployment oscillates between the HPA's target and Git's declared value on every ArgoCD reconciliation cycle, capacity is unreliable exactly when the service needs it most, and from the outside it looks like ArgoCD is malfunctioning rather than doing precisely what `selfHeal: true` says it will do.

A representative version of this at real numbers: an Application with the default 3-minute reconciliation interval, a checkout service Git-declares at 3 replicas, and traffic that genuinely needs 8-10 during a sale event. The HPA scales to 8 within its own polling interval — typically 15-30 seconds — well before ArgoCD's next reconciliation pass. ArgoCD then reverts to 3 on schedule. The HPA, seeing 3 replicas and CPU utilization still well above its target, scales back to 8 almost immediately. Over a 30-minute traffic spike, that's roughly ten full oscillation cycles — the service spends a meaningful fraction of the spike window under-provisioned at 3 replicas rather than stably serving at 8, and whoever's watching a dashboard during the incident sees replica count sawtoothing in a way that reads as ArgoCD being broken, when the actual fault is `spec.replicas` being declared in Git at all for an HPA-managed resource.

The fix is to stop declaring `spec.replicas` in Git for any Deployment an HPA manages, and tell ArgoCD to ignore that field explicitly rather than relying on its absence from the manifest (which some templating setups will still populate with a default):

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

With that in place, ArgoCD stops treating `spec.replicas` as part of what it reconciles for this resource at all — the HPA becomes the sole owner of that field, and ArgoCD's diff simply excludes it from consideration. This is worth checking as a standing practice across every Deployment fronted by an HPA in a fleet, not something to fix reactively per-incident once the oscillation is noticed — it's one of the first things worth auditing for when adopting `selfHeal: true` fleet-wide.

## Sync waves and partial failure

Article 2 touched on sync-wave ordering breaking silently when an earlier wave fails — a shared ConfigMap Application failing at wave 0 while a dependent Application at wave 1 still syncs on schedule, producing a downstream failure with no obvious link back to the actual cause. The self-heal angle on the same mechanism is a slightly different failure shape, worth separating out.

A multi-wave Rollout — say, a database migration Job at wave 0, followed by the application Deployment at wave 1 — that fails partway through leaves the Application in a state where some resources are successfully synced and others aren't. If `selfHeal: true` is set and the failure is transient (the migration Job failed due to a brief database connection blip, for instance, not a genuine schema conflict), ArgoCD will retry that wave on its next reconciliation pass automatically. That's usually desirable. What's less obvious: if the *later* wave's resources were already partially applied — the Deployment's Pods came up briefly before the migration Job's failure was detected — self-heal's retry of the earlier wave doesn't roll back what the later wave already did. The result can be application Pods running against a schema mid-migration, neither fully old nor fully new, for however long it takes the earlier wave to succeed on retry.

This isn't really an argument against sync waves — it's a reminder that sync-wave ordering is a *sequencing* guarantee, not a *transactional* one. ArgoCD does not roll back wave 1 because wave 0 needs a retry; each wave's resources are reconciled independently once created.

A representative shape of this: a wave-0 migration Job that adds a new, initially-nullable column and starts a backfill, and a wave-1 Deployment whose new code path expects that column to be fully backfilled before reading from it. The migration Job fails partway — the backfill hits a lock timeout on a large table under load — and gets marked failed. ArgoCD's next reconciliation pass retries wave 0. In the window before that retry succeeds, if wave 1's Deployment had already started rolling (because its own sync condition was satisfied by the Job simply existing and starting, not by it having *completed* the backfill), the new application code is now running against a partially-backfilled column, reading nulls it wasn't written to handle. The incident that results — application errors on a subset of records, the ones not yet backfilled — traces back to an implicit assumption that wave ordering alone guaranteed wave 0's *completion* before wave 1 ran, when what it actually guaranteed was only wave 0's *creation* before wave 1 started.

For anything where partial application genuinely can't be tolerated — a schema migration is the canonical example — the safer pattern is a `PreSync` hook with `hook-failure-policy` set to abort the sync entirely on failure, rather than relying on wave ordering plus self-heal's retry behavior to eventually converge:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-failure-policy: Abort
```

`Abort` stops the entire sync — including any later waves — the moment this hook fails, rather than leaving later waves to sync against a database that might still be mid-migration.

## Operators mutating ArgoCD-owned resources

The third shape is structurally identical to the HPA case but shows up less often, which makes it more surprising when it does: a Kubernetes operator — a cert-manager `Certificate` controller injecting a resolved secret name, a service mesh sidecar injector adding a container to a Pod spec, an admission webhook mutating a Deployment's resource requests — modifying a field on a resource that ArgoCD also considers part of its desired state.

The mechanism is identical to the HPA fight: ArgoCD sees a live-vs-Git diff on the mutated field, and with self-heal enabled, reverts it — which then gets re-mutated by the operator on its next pass, producing the same oscillation. The `ignoreDifferences` fix is identical too, scoped to whichever field the operator legitimately owns:

```yaml
spec:
  ignoreDifferences:
    - group: ""
      kind: Pod
      jsonPointers:
        - /spec/containers/0/resources
```

The harder part isn't the fix — it's noticing the collision exists at all, since unlike the HPA case (which announces itself clearly through a visibly oscillating replica count), a mutating webhook fight over a less visible field can present as ArgoCD simply showing `OutOfSync` intermittently, with no obvious pattern, for reasons that aren't immediately traceable to a specific controller.

A representative version: a service mesh's sidecar injector adding an `istio-proxy` container to every Pod in a labeled namespace at admission time — a mutation that happens to the Pod, not the Deployment's Pod template, so it doesn't show up as drift on the Deployment resource itself, but does show up if the Application's manifest set also includes a `NetworkPolicy` or `PeerAuthentication` resource the mesh's own control plane subsequently adjusts based on observed traffic. The Application shows `OutOfSync` for a few minutes after every sync, self-heals, goes quiet, and repeats on some interval that doesn't map cleanly to any deploy or traffic event a team would think to check first — because the actual trigger is the mesh control plane's own reconciliation loop, running independently and on its own schedule, not anything happening in the GitOps pipeline at all.

Worth checking, when an Application shows unexplained intermittent drift: `kubectl get events` on the affected resource, and a look at what mutating webhooks or admission controllers are registered against that resource kind in the cluster, before assuming the drift is a Git or ArgoCD problem rather than a second controller with a legitimate claim on the same object.

## Decision framework

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Replica count oscillates on a fixed interval | HPA fighting a Git-declared `spec.replicas` | `ignoreDifferences` on `/spec/replicas` |
| Downstream Application fails with no clear cause, upstream wave shows a transient failure | Sync-wave retry without transactional guarantees | `PreSync` hook with `hook-failure-policy: Abort` for anything requiring atomicity |
| `OutOfSync` status appears and clears with no clear pattern, on a specific field | A mutating webhook or operator modifying a field ArgoCD also tracks | `ignoreDifferences` scoped to the contested field, after identifying the controller via `kubectl get events` and registered webhooks |
| Any of the above, but the fix is unclear which field is contested | Diff noise obscuring the actual contested field | `argocd app diff <app-name>` against live state to see exactly which fields ArgoCD considers out of sync, before guessing at an `ignoreDifferences` scope |

## Series takeaways

Six articles, one coherent shape: GitOps isn't a single tool decision, it's a chain of boundaries, each with a place it can fail if left implicit.

1. **Architecture ([Article 1](/blogs/multi-cluster-argocd-architecture/))** — hub-and-spoke and per-cluster aren't a universal choice; they trade centralized visibility against blast radius, and the right answer depends on cluster count, compliance boundary, and team topology, not a fixed rule.
2. **Application structure ([Article 2](/blogs/gitops-repo-structure-application-patterns/))** — repo structure, ApplicationSets, and AppProjects compose in one direction: repo shape determines what generators see, generators produce Applications, and AppProjects are the boundary that keeps generated Applications from reaching further than they should.
3. **CI handoff ([Article 3](/blogs/ci-to-gitops-handoff/))** — the choice between Image Updater, CI-writes-the-commit, and Kargo is really a choice about where promotion logic and its associated blast radius should live, not a search for the objectively best tool.
4. **Secrets ([Article 4](/blogs/gitops-secrets-management/))** — Sealed Secrets, External Secrets Operator, and Vault each solve a different piece of "safe in Git, rotatable, scoped correctly," and most fleets end up running more than one rather than picking a single winner.
5. **Progressive delivery ([Article 5](/blogs/argo-rollouts-progressive-delivery/))** — canary and blue-green trade gradual blast-radius limiting against stronger pre-cutover validation, and the AnalysisTemplate gating either one is only as trustworthy as its threshold and sample size are actually tuned to the service it's protecting.
6. **Failure modes (this article)** — auto-sync and self-heal are correct by default and wrong exactly where another controller has a legitimate, ArgoCD-unaware claim on the same resource; the fix is nearly always `ignoreDifferences`, scoped precisely, applied before the oscillation becomes a page rather than after.

The thread running through all six: nothing here is a default to apply uniformly and stop thinking about. Every pattern in this series earns its place by matching a specific cluster count, team structure, compliance boundary, or ownership conflict — and the same discipline that picked hub-and-spoke over per-cluster in [Article 1](/blogs/multi-cluster-argocd-architecture/) is the discipline that catches an HPA fighting self-heal before it's paged someone at 2am.
