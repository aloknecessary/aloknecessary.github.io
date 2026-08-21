---
title: "CI to GitOps Handoff: Argo Image Updater vs. CI-Writes-the-Commit vs. Kargo"
date: 2026-08-13
last_modified_at: 2026-08-13T10:00:00+05:30
author: Alok Ranjan Daftuar
description: "How to close the gap between a CI image push and an ArgoCD sync: comparing Argo Image Updater, CI-writes-the-commit, and Kargo on promotion model, auth chain, and operational cost."
excerpt: "A build produces an image. Something has to get that image reference into the Git repo ArgoCD is watching. Three ways to close that gap, what each costs you, and how the auth chain from your CI pipeline should actually work."
keywords: "gitops, argocd, argo image updater, kargo, ci cd, github actions, image promotion, kubernetes, platform-engineering, gitops handoff"
twitter_card: "summary_large_image"
categories:
  - devops
  - kubernetes
tags: [argocd, gitops, kubernetes, github-actions, kargo, ci-cd, platform-engineering]
series: "GitOps in Practice"
series_order: 3
---

Articles 1 and 2 in this series covered where ArgoCD lives ([Multi-Cluster ArgoCD Architecture](/blogs/multi-cluster-argocd-architecture/)) and how Applications get generated from repo structure ([GitOps Repo Structure and Application Patterns](/blogs/gitops-repo-structure-application-patterns/)). Both assume the Git repo already contains the right image tag. Nothing so far explains how it gets there.

That's the part GitOps introductions gloss over. CI builds an image, pushes it to a registry, and then — what? ArgoCD only reconciles what's in Git. Somebody, or something, has to turn "a new image exists in the registry" into "a commit exists in the GitOps repo referencing it." That handoff is where a surprising amount of GitOps implementations quietly go wrong: either it's done manually (defeating half the point of GitOps), or it's automated in a way that reintroduces the exact imperative-deploy risk GitOps was supposed to remove.

```text
Approach 1 — Argo Image Updater
  CI: build → push image ──────────────► registry
                                              │ (polled every 1-2 min)
                                              ▼
                                    Image Updater controller
                                              │ writes tag
                                              ▼
                                     GitOps repo commit ──► ArgoCD syncs

Approach 2 — CI writes the commit
  CI: build → push image ──► registry
       │
       └── same workflow, next job: bump tag, commit, push ──► GitOps repo ──► ArgoCD syncs

Approach 3 — Kargo
  CI: build → push image ──► registry
                                 │
                                 ▼
                            Kargo Warehouse (watches registry)
                                 │
                                 ▼
                          Stage: staging ──(verify)──► Stage: prod
                                 │                          │
                                 ▼                          ▼
                          GitOps repo commit          GitOps repo commit
                          (staging path)               (prod path, only if
                                                         staging verified)
```

The structural difference to notice: approaches 1 and 2 both go straight from "new image" to "commit," with no concept of one environment gating another. Kargo inserts an explicit, enforced step between them. That's the entire decision in one picture — everything below is detail on why you'd pick one over another.

## The three approaches

**1. Argo Image Updater** — a controller that runs alongside ArgoCD, polls container registries for new tags matching a pattern, and writes the updated tag back into the GitOps repo (or directly into the Application's Helm/Kustomize parameters, bypassing Git entirely if configured that way).

**2. CI writes the manifest commit** — the CI pipeline itself, after a successful build and push, makes the commit: updates the image tag in the GitOps repo and pushes, no separate controller involved. ArgoCD picks up the new commit through its normal poll or webhook.

**3. Kargo** — a purpose-built promotion controller that sits between CI and ArgoCD, modeling multi-stage promotion (dev → staging → prod) as a first-class resource rather than a series of independent commits.

## Argo Image Updater

Image Updater's appeal is that it closes the loop without CI needing to know anything about the GitOps repo at all — CI's job stays exactly "build, test, push image," and a separate controller handles noticing the new tag exists and writing it into Git (or, in write-back methods that skip Git, directly into the Application).

Configuration lives as annotations on the Application itself:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: checkout-service-prod
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: checkout=111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service
    argocd-image-updater.argoproj.io/checkout.update-strategy: semver
    argocd-image-updater.argoproj.io/checkout.allow-tags: 'regexp:^v[0-9]+\.[0-9]+\.[0-9]+$'
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: checkout-team
  source:
    repoURL: https://github.com/example-org/checkout-team-gitops.git
    targetRevision: main
    path: apps/checkout-service/prod
    helm:
      parameters:
        - name: image.tag
          value: v1.4.2
```

The `write-back-method: git` setting is the important one — it means Image Updater commits the new tag back into the repo rather than mutating the live Application's Helm values directly (the alternative `write-back-method: argocd` writes to the Application object only, which means the running state and the Git repo can silently diverge, undermining the entire premise of GitOps as the source of truth). If you use Image Updater, `git` write-back is the only mode consistent with the rest of this series.

**What you get:** zero GitOps-repo awareness required in CI — any pipeline that pushes an image works, unmodified. Centralized update logic, configured once per Application rather than duplicated across every CI workflow.

**What it costs you:** it's polling-based by default, so there's a delay (configurable, typically 1-2 minutes) between image push and repo commit — not a real problem for most teams, but worth knowing if you're expecting webhook-speed promotion. It has no concept of promotion stages — it updates whatever Application it's configured against, independently. Getting a build to flow dev → staging → prod with any kind of gate means bolting that logic on separately (different Applications with different `allow-tags` patterns, manual promotion between them), which is exactly the gap Kargo exists to close.

## CI writes the manifest commit

The more direct approach: no separate controller, the CI job itself pushes the commit. After a successful build:

```yaml
# .github/workflows/build-and-promote.yml (excerpt)
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write     # OIDC token for registry auth — see the GitHub Actions OIDC post
      contents: read
    steps:
      - uses: actions/checkout@v6
      - name: Build and push image
        run: |
          docker build -t $ECR_REGISTRY/checkout-service:${{ github.sha }} .
          docker push $ECR_REGISTRY/checkout-service:${{ github.sha }}

  update-gitops-repo:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Generate GitHub App token for GitOps repo
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ vars.GITOPS_BOT_APP_ID }}
          private-key: ${{ secrets.GITOPS_BOT_PRIVATE_KEY }}
          owner: example-org
          repositories: checkout-team-gitops
      - uses: actions/checkout@v6
        with:
          repository: example-org/checkout-team-gitops
          token: ${{ steps.app-token.outputs.token }}
      - name: Bump image tag
        run: |
          yq -i '.image.tag = "${{ github.sha }}"' apps/checkout-service/prod/values.yaml
      - name: Commit and push
        run: |
          git config user.name "gitops-bot"
          git config user.email "gitops-bot@example.org"
          git commit -am "checkout-service: bump to ${{ github.sha }}"
          git push
```

The auth chain here deserves the same scrutiny your GitHub Actions OIDC post applied to cloud credentials — a long-lived PAT with write access to the GitOps repo is the wrong answer for the same reasons a long-lived AWS access key was the wrong answer there. A GitHub App scoped to exactly the one GitOps repo, with an installation token minted per workflow run and expiring shortly after, keeps this consistent with the rest of your CI trust model rather than introducing a second, weaker credential pattern alongside it.

Setting that up end to end, mirroring the scoped-credential approach from Article 1:

**1. Create the GitHub App**, granting it only `contents: write` on the GitOps repo — nothing broader:

```bash
# Via github.com/settings/apps/new, or the API — key settings:
# - Repository permissions: Contents = Read & write
# - No other permissions granted
# - Installed only on example-org/checkout-team-gitops, not org-wide
```

**2. Store the App ID and private key as repo/org secrets**, then reference them in the workflow exactly as shown above with `actions/create-github-app-token`. The resulting token is scoped to the one installation (one repo), and expires roughly an hour after issuance — there's no long-lived credential sitting in a secrets store for someone to find later.

**3. Verify scope, not just that it works.** A token that successfully pushes doesn't confirm it's properly scoped — test that the same token fails against a different repo the App isn't installed on, confirming the blast radius is actually the one repo and not the whole org.

**What you get:** no delay — the commit happens the moment the build succeeds, and no separate controller to run, monitor, or upgrade. Promotion logic (which environments get updated, in what order, behind what gate) is entirely visible in the workflow file, not split across Application annotations and a controller's polling behavior.

**What it costs you:** every CI pipeline that deploys anything now needs write access to a GitOps repo and the logic to update it correctly — which either means duplicating that logic across every service's workflow, or investing in a shared reusable workflow so it isn't duplicated. There's also a subtler cost: CI now has push access to the thing that controls production. That's a meaningfully larger blast radius for a compromised CI pipeline than "CI can push images, a separate controller with narrower permissions decides what deploys" — worth weighing explicitly against Image Updater's separation of concerns rather than assuming direct-commit is automatically simpler because it has fewer moving parts.

A concrete version of that blast-radius cost: if the GitOps bot's GitHub App token (or, worse, a legacy PAT predating the App migration) is scoped with write access to more than the one repo it needs — org-wide `contents: write`, say, granted once for convenience and never revisited — a compromised or leaked CI secret doesn't just mean an attacker can push a bad image tag to one service's staging environment. It means every repo that token can reach is a viable target, prod GitOps repos included. The App-scoped-to-one-repo setup above isn't a nice-to-have hardening step; it's the difference between a compromised token being a one-service incident and an org-wide one.

## Kargo

Image Updater and CI-writes-the-commit both update one Application at a time. Neither has a native concept of "this build needs to pass through staging before it's allowed anywhere near prod." Kargo exists specifically to model that.

Kargo introduces two core resources: a `Warehouse`, which watches for new artifacts (images, Helm charts, or Git commits) the same way Image Updater does, and a `Stage`, which represents one step in a promotion pipeline — each Stage can require the previous Stage to have successfully verified before it's eligible for promotion.

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Warehouse
metadata:
  name: checkout-service
  namespace: checkout-team
spec:
  subscriptions:
    - image:
        repoURL: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service
        semverConstraint: ^1.0.0
---
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: staging
  namespace: checkout-team
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: checkout-service
      sources:
        direct: true
  promotionTemplate:
    spec:
      steps:
        - uses: git-clone
        - uses: yaml-update
          config:
            path: apps/checkout-service/staging/values.yaml
            updates:
              - key: image.tag
                value: ${% raw %}{{ imageFrom("checkout-service").Tag }}{% endraw %}
        - uses: git-commit
        - uses: git-push
---
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: prod
  namespace: checkout-team
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: checkout-service
      sources:
        stages: [staging]   # prod can only promote freight that passed through staging
```

That `sources: stages: [staging]` line is the entire value proposition in one field: prod's Stage is structurally incapable of promoting an image that hasn't already gone through staging, enforced by Kargo itself rather than by convention or a manual checklist. Verification gates (automated tests, manual approval) attach to each Stage, and Kargo tracks exactly which artifact — which "freight," in its terminology — made it through which Stages.

A verification gate on the staging Stage looks like an additional step in that same promotion pipeline — commonly an `AnalysisRun`-style check or a call out to an external test suite, with the Stage only marked verified, and therefore eligible for the prod Stage to consume, if that step passes:

```yaml
  verification:
    analysisTemplates:
      - name: checkout-smoke-test
    args:
      - name: staging-url
        value: https://checkout-staging.internal.example.org
```

With that in place, the promotion isn't "staging deployed, therefore eligible for prod" — it's "staging deployed *and* the smoke test suite passed against it, therefore eligible for prod." That distinction is exactly what separates Kargo from bolting a manual approval step onto Image Updater or a CI workflow: the gate is a property of the Stage graph itself, checked by Kargo before it will construct a promotion for the next Stage, not a step someone has to remember to run.

**What you get:** promotion pipelines with dependency ordering as an actual API object, not a mental model your team has to hold and enforce manually. A clear audit trail of what was promoted, through which stages, and when.

**What it costs you:** it's another controller to run and understand, with its own resource model on top of ArgoCD's. For a single-environment or single-cluster setup, it's meaningfully more machinery than the problem needs. It earns its cost specifically when the number of promotion stages and the need for gated, auditable progression between them is real — not as a default choice for every service.

## Decision framework

| Situation | Recommended approach |
| --- | --- |
| Single environment, or environments promote independently with no dependency between them | Argo Image Updater — simplest, no CI changes needed |
| A handful of services, promotion logic is simple and already lives in CI thinking (e.g., "merge to main deploys to staging, tag deploys to prod") | CI writes the commit — keeps promotion logic visible in one place, avoids running an extra controller |
| Multiple environments with a hard requirement that prod can only receive artifacts that passed staging, verified by automated checks | Kargo — this is the exact problem it's built to solve |
| Regulated workloads needing an auditable promotion trail, independent of CI pipeline history | Kargo — the Stage/Freight model gives you that audit trail as a first-class object, not something reconstructed from CI logs |

These aren't mutually exclusive across an entire platform, either — a team running mostly independent services on Image Updater might still put its most compliance-sensitive service through Kargo specifically, the same way Article 1's hybrid cluster pattern carved out per-cluster ArgoCD only where the boundary demanded it.

## What's next

None of the three approaches above touch what's arguably the sharpest edge in GitOps: how do you get a database password or an API key into a running Pod, when the whole model is "everything lives in Git" and Git is very much not where secrets belong. That's Article 4 — Sealed Secrets, External Secrets Operator, and the Vault plugin, compared on what they actually protect against and what they don't.
