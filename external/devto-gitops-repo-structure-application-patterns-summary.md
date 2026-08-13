---
title: "GitOps Repo Structure and Application Patterns: App-of-Apps, ApplicationSets, and AppProjects"
published: false
description: Mono-repo vs. repo-per-team, App-of-Apps vs. ApplicationSets at scale, and AppProjects as the multi-tenancy boundary that keeps teams from deploying into each other's namespaces.
tags: argocd, gitops, kubernetes, devops
canonical_url: https://aloknecessary.in/blogs/gitops-repo-structure-application-patterns/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-repo-structure-application-patterns
cover_image:
---

Article 1 of this series covered where ArgoCD lives — hub-and-spoke vs. per-cluster, EKS and AKS registration mechanics. That's the plumbing. It says nothing about how Applications get organized once you're managing dozens of them across a dozen clusters, or how the Git repositories driving all of it should be laid out.

That second question tends to be the first real disagreement a platform team has — usually before anyone's written a single ArgoCD manifest. Get it wrong and every later decision (how ApplicationSets generate Applications, how AppProjects enforce boundaries) inherits the mess.

---

## Repo Structure: Where Change Friction Lives

Three shapes dominate in practice. The choice isn't aesthetic — it determines where friction lives.

**Mono-repo** — one repository, all teams, all environments, organized by directory.

- Wins: one place to search, one PR history, easy to see what's deployed where
- Costs: PR review load and merge contention scale with team count; access control is directory-level CODEOWNERS, not repo permissions — weaker isolation than compliance-conscious teams want

**Repo-per-team** — each team owns a repository for everything it deploys.

- Wins: access control is a repo permission; a team's deploy cadence doesn't create merge contention with others; blast radius of a bad commit is scoped to one team
- Costs: cross-cutting changes (shared base image bump, cluster-wide policy) now touch N repos

**Repo-per-app** — finest grain, one repo per service.

- Wins: tightest blast radius and access control
- Costs: repo sprawl; cross-app changes are the worst version of the mono-repo problem — N repos, each requiring a separate PR

| Service count | Team count | Access control need | Recommended structure |
| --- | --- | --- | --- |
| Under 8 | 1 platform team | Low | Mono-repo |
| 8–30 | 2–5 independent teams | Moderate | Repo-per-team |
| 30+ | 5+ teams, some with regulatory isolation | High | Repo-per-app, or repo-per-team with sensitive services split out |

---

## App-of-Apps: Simple, Until It Isn't

The simplest multi-Application pattern: a root Application whose only job is to deploy more Applications.

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

It breaks down in two predictable ways at scale:

**Sync-wave ordering is not a dependency gate.** A `shared-config` Application at `sync-wave: "0"` and a `checkout-service` at `sync-wave: "1"` looks correct — until `shared-config` fails to sync. ArgoCD's wave ordering governs *when* a sync is attempted, not whether it's a hard prerequisite. `checkout-service` still syncs on schedule, its Deployment references a ConfigMap key that was never written, and the failure surfaces as a CrashLoopBackOff with no obvious link to the upstream cause.

**Adding a new cluster or environment means hand-writing a new Application manifest every time.** At 3 clusters and 5 services that's 15 manifests. At 12 clusters and 30 services it's 360 — every one written, not generated.

---

## ApplicationSets: The Scaling Answer

Instead of writing N Application manifests, write one ApplicationSet with a generator that produces them.

The generators that matter:

- **Cluster** — generates one Application per registered cluster, optionally filtered by label. Register a new spoke cluster and Applications for it appear automatically.
- **Git directory** — generates Applications from repo structure: one per subdirectory. Add a new service directory and a new Application appears — no ApplicationSet edit required.
- **Matrix** — combines two generators, producing the cross-product. Cluster × Git directory is the combination that matters most: every service in the repo, deployed to every cluster carrying a matching label.

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
      name: '{{path.basename}}-{{name}}'
    spec:
      project: checkout-team
      source:
        repoURL: https://github.com/example-org/checkout-team-gitops.git
        targetRevision: main
        path: '{{path}}'
      destination:
        server: '{{server}}'
        namespace: checkout
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

Add a new service directory — it deploys to every matching cluster automatically. Register a new cluster with the right labels — every existing service deploys to it automatically. Neither event requires touching the ApplicationSet.

That same automatic fan-out is why an ApplicationSet change deserves a dry run before it's applied — a mistyped label selector doesn't fail one Application, it fails every Application it would have generated:

```bash
argocd appset generate applicationset.yaml
```

This renders the full set of Applications the ApplicationSet would produce without applying anything — catching "this now matches four more clusters than intended" before it becomes a live sync.

---

## AppProjects: The Multi-Tenancy Boundary

Everything so far describes how Applications get created. It says nothing about what stops one team's ApplicationSet from deploying into another team's namespace. That boundary is `AppProject`.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: checkout-team
  namespace: argocd
spec:
  sourceRepos:
    - https://github.com/example-org/checkout-team-gitops.git
  destinations:
    - server: https://spoke-eks-prod-us-east-1
      namespace: checkout
    - server: https://spoke-eks-prod-us-east-1
      namespace: cart
    - server: https://spoke-aks-prod-westeurope
      namespace: checkout
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
  roles:
    - name: checkout-team-sync
      policies:
        - p, proj:checkout-team:checkout-team-sync, applications, sync, checkout-team/*, allow
      groups:
        - checkout-team-engineers
```

Three things worth being deliberate about:

**`sourceRepos` should list the team's actual repos, not `*`.** A wildcarded source list means any Application in this project can pull manifests from anywhere — defeating the point of repo-per-team access control.

**`destinations` should be an explicit cluster/namespace list, not a wildcard.** This is the line that stops a checkout-team ApplicationSet, misconfigured or compromised, from deploying into a payments-team namespace. A Matrix generator with a slightly-too-broad label selector (`env: prod` instead of `team: checkout, env: prod`) will happily generate Applications targeting every production cluster it can see. Without an AppProject destinations list, ArgoCD will attempt every one of them. The label selector mistake is the proximate cause; the AppProject destinations list is what turns that mistake into a rejected sync instead of an actual cross-team deployment.

**`clusterResourceWhitelist: []`** is a deliberately restrictive default. Most application teams have no legitimate reason to create `ClusterRole`s or `Namespace`s through their own AppProject. Reserve that capability for a separate, tightly held platform-team project.

---

## How the Three Pieces Compose

Repo structure determines what the ApplicationSet's Git generator sees. The ApplicationSet's Matrix generator combines that with cluster registration from Article 1 to produce Applications. The AppProject referenced by every one of those Applications keeps the resulting sync operations inside the boundary that repo was ever supposed to have.

Skip AppProjects and the first two pieces still function — they just function without a backstop, which tends to be fine until the day it very much isn't.

---

## Read the Full Article

This is Article 2 of the GitOps in Practice series. The full article includes:

- Detailed cost/benefit analysis for all three repo structure shapes with the decision table
- App-of-Apps sync-wave failure mode explained in full with the CrashLoopBackOff scenario
- Complete Matrix generator YAML with all four ApplicationSet generator types explained
- `argocd appset generate` dry-run workflow for catching label selector mistakes before they go live
- Full AppProject YAML with `sourceRepos`, `destinations`, `clusterResourceWhitelist`, `namespaceResourceBlacklist`, and role definitions
- The cross-team deployment scenario that AppProject destinations prevent — and why the label selector mistake alone isn't enough to cause it
- What's next: Article 3 — CI to GitOps handoff, Argo Image Updater vs. CI-writes-the-commit vs. Kargo

**👉 [GitOps Repo Structure and Application Patterns — Full Article](https://aloknecessary.in/blogs/gitops-repo-structure-application-patterns/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=gitops-repo-structure-application-patterns)**
