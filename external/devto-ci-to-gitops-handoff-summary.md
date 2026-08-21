---
title: "CI to GitOps Handoff: Argo Image Updater vs. CI-Writes-the-Commit vs. Kargo"
published: false
description: How to close the gap between a CI image push and an ArgoCD sync, comparing Argo Image Updater, CI-writes-the-commit, and Kargo on promotion model, auth chain, and operational cost.
tags: argocd, gitops, kubernetes, github-actions
canonical_url: https://aloknecessary.in/blogs/ci-to-gitops-handoff/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=ci-to-gitops-handoff
cover_image:
---

ArgoCD only reconciles what's in Git. A CI pipeline builds an image, pushes it to a registry — and then what? Something has to turn "a new image exists" into "a commit exists in the GitOps repo referencing it." That handoff is where a surprising number of GitOps implementations quietly go wrong: either it's done manually, or it's automated in a way that reintroduces the exact imperative-deploy risk GitOps was supposed to remove.

Three approaches cover almost every real setup. The choice isn't just operational preference — it interacts directly with your repo structure and how much promotion-stage enforcement you actually need.

---

## The structural difference in one picture

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

Approaches 1 and 2 go straight from "new image" to "commit" with no concept of one environment gating another. Kargo inserts an explicit, enforced step between them. Everything below is detail on why you'd pick one over another.

---

## Argo Image Updater

Image Updater runs alongside ArgoCD, polls registries for new tags matching a pattern, and writes the updated tag back into the GitOps repo. CI's job stays exactly "build, test, push image" — no GitOps-repo awareness required.

Configuration lives as annotations on the Application itself:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: checkout=111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service
  argocd-image-updater.argoproj.io/checkout.update-strategy: semver
  argocd-image-updater.argoproj.io/checkout.allow-tags: 'regexp:^v[0-9]+\.[0-9]+\.[0-9]+$'
  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/git-branch: main
```

The `write-back-method: git` setting is the important one. The alternative (`argocd`) writes to the Application object only, meaning the running state and the Git repo can silently diverge — undermining the entire premise of GitOps as the source of truth. If you use Image Updater, `git` write-back is the only mode consistent with a real GitOps model.

**Trade-off:** polling-based (1-2 minute delay), and no native concept of promotion stages. Getting a build to flow dev → staging → prod with any gate means bolting that logic on separately — which is exactly the gap Kargo exists to close.

---

## CI writes the manifest commit

No separate controller. The CI job itself pushes the commit after a successful build. The auth chain here deserves the same scrutiny as cloud credentials — a long-lived PAT with write access to the GitOps repo is the wrong answer for the same reasons a long-lived AWS access key is wrong.

The right pattern: a GitHub App scoped to exactly the one GitOps repo, with an installation token minted per workflow run:

```yaml
jobs:
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
        run: yq -i '.image.tag = "${{ github.sha }}"' apps/checkout-service/prod/values.yaml
      - name: Commit and push
        run: |
          git config user.name "gitops-bot"
          git config user.email "gitops-bot@example.org"
          git commit -am "checkout-service: bump to ${{ github.sha }}"
          git push
```

The token is scoped to one installation (one repo) and expires roughly an hour after issuance — no long-lived credential sitting in a secrets store.

**Trade-off:** no delay, no extra controller. But CI now has push access to the thing that controls production. A GitHub App token scoped org-wide instead of to one repo turns a compromised CI secret from a one-service incident into an org-wide one. The scoping isn't optional hardening — it's the difference between those two outcomes.

---

## Kargo

Image Updater and CI-writes-the-commit both update one Application at a time with no native concept of "this build must pass staging before prod." Kargo models that as a first-class API.

Two core resources: a `Warehouse` (watches for new artifacts, like Image Updater) and a `Stage` (one step in a promotion pipeline). The key field:

```yaml
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

`sources: stages: [staging]` means prod is structurally incapable of promoting an image that hasn't gone through staging — enforced by Kargo, not by convention. Verification gates (smoke tests, analysis runs) attach to each Stage, and Kargo tracks exactly which artifact made it through which Stages.

The distinction from bolting a manual approval onto Image Updater: the gate is a property of the Stage graph itself, checked by Kargo before it constructs a promotion for the next Stage. Not a step someone has to remember to run.

**Trade-off:** another controller with its own resource model on top of ArgoCD's. Earns its cost specifically when multi-stage promotion with gated, auditable progression is a real requirement — not as a default for every service.

---

## Decision framework

| Situation | Recommended approach |
| --- | --- |
| Single environment, or environments promote independently | Argo Image Updater — simplest, no CI changes needed |
| Simple promotion logic already visible in CI (merge to main = staging, tag = prod) | CI writes the commit — keeps logic in one place, no extra controller |
| Hard requirement that prod only receives artifacts that passed staging with automated verification | Kargo — this is the exact problem it's built to solve |
| Regulated workloads needing an auditable promotion trail as a first-class object | Kargo — Stage/Freight model gives you that, not something reconstructed from CI logs |

These aren't mutually exclusive across a platform — a team running mostly independent services on Image Updater might still put its most compliance-sensitive service through Kargo specifically.

---

## Read the Full Article

The summary covers the shape of each approach and the key trade-offs. The full article goes deeper on:

- The complete Image Updater Application manifest — `image-list`, `update-strategy`, `allow-tags`, and `write-back-method` in context, not just the annotation snippet
- The full two-job GitHub Actions workflow (build + update-gitops-repo), including the step that verifies the App token *fails* against repos it shouldn't reach — confirming blast radius, not just that it works
- The complete Kargo `Warehouse` + `Stage` YAML including the `verification` block that wires an `AnalysisTemplate` smoke test to the staging Stage — the part that makes "staging verified" mean something concrete
- Why a Matrix generator with a too-broad cluster label selector connects directly to the auth chain here: AppProject destinations as the backstop when the ApplicationSet generates more than intended
- Article 4 preview: secrets management (Sealed Secrets, External Secrets Operator, Vault plugin) — what each actually protects against and what it doesn't

**👉 [CI to GitOps Handoff: Argo Image Updater vs. CI-Writes-the-Commit vs. Kargo — Full Article](https://aloknecessary.in/blogs/ci-to-gitops-handoff/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=ci-to-gitops-handoff)**
