---
title: "GitOps Repo Structure and Application Patterns: App-of-Apps, ApplicationSets, and AppProjects"
date: 2026-08-13
last_modified_at: 2026-08-13T18:07:48+05:30
author: Alok Ranjan Daftuar
description: "How to structure GitOps repositories for scale, when to use App-of-Apps vs ApplicationSets, and how AppProjects enforce the multi-tenancy boundary that keeps teams from deploying into each other's namespaces."
excerpt: "Mono-repo vs. repo-per-team, App-of-Apps vs. ApplicationSets at scale, and AppProjects as the multi-tenancy boundary that keeps teams from stepping on each other's Applications."
keywords: "gitops, argocd, applicationset, app-of-apps, appproject, kubernetes, multi-tenancy, platform-engineering, repo-structure, matrix-generator"
twitter_card: summary_large_image
categories:
  - devops
  - kubernetes
tags: [argocd, gitops, kubernetes, applicationsets, multi-tenancy, platform-engineering]
series: "GitOps in Practice"
series_order: 2
---

Article 1 in this series covered where ArgoCD lives — [Multi-Cluster ArgoCD Architecture](/blogs/multi-cluster-argocd-architecture/) walked through hub-and-spoke vs. per-cluster, with EKS and AKS registration mechanics. That's the plumbing. It says nothing about how Applications themselves get organized once you're managing dozens of them across a dozen clusters, or how the Git repositories driving all of it should be laid out.

That second question tends to be the first real disagreement a platform team has — usually before anyone's written a single ArgoCD manifest. Get it wrong and every later decision (how ApplicationSets generate Applications, how AppProjects enforce boundaries) inherits the mess.

<!--more-->

## Repo structure conventions

Three shapes dominate in practice, and each has a real cost, not just a stylistic preference:

**Mono-repo** — one repository holding manifests for every application, every team, every environment, typically organized by directory (`apps/payments/prod`, `apps/checkout/staging`).

- *Wins*: one place to search, one PR history, straightforward to reason about what's deployed where at a glance.
- *Costs*: every team's changes flow through the same repo, so PR review load and merge contention scale with team count, not with any one team's activity. Git history becomes a shared resource everyone has opinions about. Access control gets awkward — restricting who can touch `apps/payments/prod` inside a mono-repo means directory-level CODEOWNERS and branch protection, not repo-level permissions, which is weaker isolation than most compliance-conscious teams want.

**Repo-per-team** — each team owns a repository containing manifests for everything it deploys, across all its environments and clusters.

- *Wins*: access control is a repo permission, not a directory convention. A team's deploy cadence doesn't create merge contention with any other team. Blast radius of a bad commit is scoped to one team's repo.
- *Costs*: cross-cutting changes (a shared base image bump, a cluster-wide policy change) now touch N repos instead of one directory. Platform teams end up writing automation just to fan a single change out across every team repo.

**Repo-per-app** — the finest grain: each application gets its own repository, environments as directories or branches within it.

- *Wins*: tightest possible blast radius and access control — exactly matches the unit teams actually reason about (`this` service, `this` deploy).
- *Costs*: repo sprawl. A platform managing 60 services means 60 repos to bootstrap, template, and keep consistent. Cross-app changes (again, shared base images, policy) are now the worst version of the mono-repo cost — N repos, each requiring a separate PR and separate review.

None of these is correct in isolation — the choice is really about where you want change friction to live. Mono-repo puts friction on cross-team coordination inside one repo. Repo-per-team and repo-per-app push friction outward into cross-cutting automation. Teams under roughly 5-8 services with a single platform group tend to do fine with mono-repo. Past that, once teams are shipping independently and access control matters more than a unified view, repo-per-team is the more common landing point — and it's the structure the rest of this article assumes, since it maps cleanly onto the AppProjects boundary covered later.

| Service count | Team count | Access control need | Recommended structure |
| --- | --- | --- | --- |
| Under 8 | 1 platform team owns everything | Low — shared trust | Mono-repo |
| 8–30 | 2–5 independent teams | Moderate — teams shouldn't block each other | Repo-per-team |
| 30+ | 5+ teams, some with regulatory or contractual isolation needs | High — repo-level access control is a requirement, not a preference | Repo-per-app, or repo-per-team with the highest-sensitivity services split out individually |

As with the cluster-architecture table in Article 1, treat the boundaries as directional rather than hard cutoffs — a 6-service platform team that already has strict compliance segmentation between two of those services has more in common with the repo-per-team row than the service count alone would suggest.

Whichever shape you pick, the choice isn't just aesthetic — it directly determines which ApplicationSet generator does the work of turning repo structure into ArgoCD Applications, which is where this article is headed next.

## App-of-Apps

The simplest way to manage many Applications from one place: a root Application whose only job is to deploy more Applications. ArgoCD syncs the root, which in turn creates and syncs its children.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-checkout-team
  namespace: argocd
spec:
  project: checkout-team
  source:
    repoURL: https://github.com/example-org/checkout-team-gitops.git
    targetRevision: main
    path: apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

The `apps` directory in that repo holds one Application manifest per child — one per service per environment. It's simple, it's explicit, and for a handful of Applications it's genuinely the right tool: no templating layer to reason about, just Kubernetes manifests referencing other Kubernetes manifests.

It breaks down in two predictable ways as scale increases. First, sync-wave ordering: if child Applications have dependencies on each other (a shared ConfigMap Application that other Applications' Helm charts read from), you're manually annotating `argocd.argoproj.io/sync-wave` across every child and hoping the ordering holds as more get added.

A representative shape of this failure: a `shared-config` Application at `sync-wave: "0"` and a `checkout-service` Application at `sync-wave: "1"`, intended so the ConfigMap exists before checkout's Deployment tries to mount it. That ordering holds as long as both Applications sync cleanly on the first pass. It breaks the moment `shared-config` fails to sync — a bad value in the ConfigMap, an unrelated RBAC error — because ArgoCD's wave ordering governs *when* a sync is attempted, not a hard dependency gate. `checkout-service` at wave 1 still syncs on schedule, its Deployment comes up referencing a ConfigMap key that was never written, and the resulting failure surfaces as a checkout-service CrashLoopBackOff with no obvious link back to the actual cause upstream. The fix at small scale is manual — go find the failed wave-0 Application — but it's exactly the kind of implicit, easy-to-miss coupling that gets worse, not better, as more children are added to the same root Application.

Second, and more fundamentally: adding a new cluster or a new environment to an existing service means hand-writing a new Application manifest, every time, for every combination. At 3 clusters and 5 services, that's 15 manifests to keep in sync by hand. At 12 clusters and 30 services, it's 360 — and every one of them was written, not generated.

## ApplicationSets — the scaling answer

ApplicationSets solve exactly that problem: instead of writing N Application manifests, you write one ApplicationSet with a generator that produces them. This is genuinely the mechanism that makes hub-and-spoke tractable at the cluster counts covered in Article 1 — without it, hub-and-spoke just relocates the App-of-Apps manual-authoring problem onto a single control plane instead of solving it.

The generators that matter in practice:

- **List** — a static, inline list of values (name, path, cluster) you maintain by hand. Fine for a handful of known combinations, not a real scaling mechanism.
- **Cluster** — generates one Application per cluster registered with ArgoCD (the cluster Secrets from Article 1), optionally filtered by label. This is the generator that turns "register a new spoke cluster" into "Applications for it appear automatically," rather than a manual step per service.
- **Git directory / file** — generates Applications from the structure of a Git repo itself: one Application per subdirectory, or one per matched file (commonly a `config.json` sitting alongside each service's manifests). This is what maps cleanly onto repo-per-team: each new service directory added to the repo produces a new Application with no ApplicationSet edit required.
- **Matrix** — combines two generators, producing the cross-product. Cluster × Git directory is the combination that matters most here: every service in the repo, deployed to every cluster carrying a matching label, with zero manual Application authoring on either axis.

A representative Matrix generator, deploying every service directory in a team's repo to every cluster labeled for that team's environment:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: checkout-team-services
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - git:
              repoURL: https://github.com/example-org/checkout-team-gitops.git
              revision: main
              directories:
                - path: apps/*
          - clusters:
              selector:
                matchLabels:
                  team: checkout
                  env: prod
  template:
    metadata:
      name: '{% raw %}{{path.basename}}{% endraw %}-{% raw %}{{name}}{% endraw %}'
    spec:
      project: checkout-team
      source:
        repoURL: https://github.com/example-org/checkout-team-gitops.git
        targetRevision: main
        path: '{% raw %}{{path}}{% endraw %}'
      destination:
        server: '{% raw %}{{server}}{% endraw %}'
        namespace: checkout
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

Add a new service directory under `apps/` in the repo, and it deploys to every `team: checkout, env: prod` cluster automatically. Register a new cluster with that label pair, and every existing service deploys to it automatically. Neither event requires touching the ApplicationSet itself — which is the entire point, and the reason this generator, not App-of-Apps, is what you want driving Applications once cluster count and service count are both growing.

That same automatic fan-out is exactly why an ApplicationSet change deserves a dry run before it's applied — a mistyped label selector or a bad matrix combination doesn't fail one Application, it fails (or worse, mis-deploys) every Application it would have generated. The ArgoCD CLI supports exactly this:

```bash
argocd appset generate applicationset.yaml
```

This renders the full set of Applications the ApplicationSet would produce — every cluster/directory combination the Matrix generator resolves to — without applying anything. Running it against a changed label selector or a newly added generator, and diffing the output against what you expect, catches the "this now matches four more clusters than intended" class of mistake before it becomes a live sync rather than after.

## AppProjects — the multi-tenancy boundary

Everything so far describes how Applications get created. It says nothing about what stops one team's ApplicationSet, or a compromised credential, from deploying into another team's namespace on another team's cluster. That boundary is `AppProject`.

An `AppProject` scopes what any Application assigned to it is allowed to do: which Git repositories it may source from, which cluster/namespace combinations it may deploy to, and which Kubernetes resource kinds it may create. Every Application and ApplicationSet in the examples above references `project: checkout-team` — that reference is what makes the isolation real rather than aspirational.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: checkout-team
  namespace: argocd
spec:
  description: Checkout team — owns checkout, cart, and payments-adjacent services
  sourceRepos:
    - https://github.com/example-org/checkout-team-gitops.git
  destinations:
    - server: https://spoke-eks-prod-us-east-1
      namespace: checkout
    - server: https://spoke-eks-prod-us-east-1
      namespace: cart
    - server: https://spoke-aks-prod-westeurope
      namespace: checkout
  clusterResourceWhitelist: []   # no cluster-scoped resources — namespaced only
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
  roles:
    - name: checkout-team-sync
      description: Allows the checkout team's CI identity to trigger syncs
      policies:
        - p, proj:checkout-team:checkout-team-sync, applications, sync, checkout-team/*, allow
      groups:
        - checkout-team-engineers
```

Three things worth being deliberate about, since they're the parts teams tend to skip in a rush to get something working:

- **`sourceRepos` should list the team's actual repo(s), not `*`.** An empty or wildcarded source list means any Application assigned to this project can pull manifests from anywhere — which defeats the point of repo-per-team access control established earlier.
- **`destinations` should be an explicit cluster/namespace list, not a wildcard namespace on a wildcard server.** This is the line that stops a checkout-team ApplicationSet, misconfigured or compromised, from deploying into a payments-team namespace on a cluster it was never meant to touch. This isn't a theoretical concern: a Matrix generator with a slightly-too-broad cluster label selector (`env: prod` instead of `team: checkout, env: prod`, say) will happily generate Applications targeting every production cluster it can see — and without an AppProject destinations list narrowing what those Applications are actually allowed to sync to, ArgoCD will attempt every one of them. The label selector mistake in the ApplicationSet is the proximate cause; the AppProject destinations list is what turns that mistake into a rejected sync instead of an actual cross-team deployment.
- **`clusterResourceWhitelist: []`** is a deliberately restrictive default: most application teams have no legitimate reason to create `ClusterRole`s, `Namespace`s, or other cluster-scoped resources through their own AppProject. Reserve that capability for a separate, tightly held platform-team project rather than granting it by default and revoking it later.

At the 10-15 cluster range from Article 1, with multiple teams and a hybrid hub-and-spoke/per-cluster split, AppProjects are what make "multiple teams, one hub" a defensible statement rather than a hope. Without them, every team's Applications share one implicit blast radius on the hub regardless of how carefully the ApplicationSets themselves were written.

## Putting it together

The three pieces compose in one direction: repo structure determines what the ApplicationSet's Git generator sees, the ApplicationSet's Matrix generator combines that with cluster registration from Article 1 to produce Applications, and the AppProject referenced by every one of those Applications is what keeps the resulting sync operations inside the boundary that repo was ever supposed to have. Skip AppProjects and the first two pieces still function — they just function without a backstop, which tends to be fine until the day it very much isn't.

## What's next

Applications now exist, are generated automatically as services and clusters are added, and are boundaried by team. What's still missing is the other end of the pipeline — how a CI build actually gets a new image reference into one of these Git repos so ArgoCD picks it up. That's Article 3: CI to GitOps handoff, comparing Argo Image Updater, CI-writes-the-commit, and Kargo, and building directly on the OIDC trust model from your GitHub Actions post.
