---
title: "Progressive Delivery with Argo Rollouts: Canary, Blue-Green, and AnalysisTemplates That Actually Gate"
published: false
description: Argo Rollouts replaces the all-or-nothing Kubernetes Deployment rollout with a strategy that pauses, runs automated analysis against real traffic, and only proceeds — or reverses — based on the result.
tags: kubernetes, gitops, devops, progressive-delivery
canonical_url: https://aloknecessary.in/blogs/argo-rollouts-progressive-delivery/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=argo-rollouts-progressive-delivery
cover_image:
---

A standard Kubernetes `Deployment` rolling update has no concept of "check whether this is actually working before replacing more Pods." It replaces old Pods with new ones at the pace you configured, and if the new version is broken, it finds out the same way your users do — by serving it to more and more of them until someone notices.

Argo Rollouts replaces the `Deployment` resource with a `Rollout` — API-compatible in its Pod template, but with an explicit strategy for how traffic shifts and, critically, automated checks that can halt or reverse that shift before it reaches everyone. This post covers the two strategies that matter in practice and the `AnalysisTemplate` mechanism that makes the gating real rather than cosmetic.

---

## Why a Deployment Isn't Enough

A `Deployment`'s rolling update is governed by `maxSurge` and `maxUnavailable` — how many extra Pods can exist during the rollout, how many can be unavailable. Neither is a correctness check. A `Deployment` will happily roll a broken version to 100% of Pods because nothing in its model asks "is this new version actually healthy" — only "are enough Pods reporting ready," which a broken-but-still-passing-liveness-probe version satisfies just fine.

The two strategies have fundamentally different blast-radius profiles:

```text
Canary                                    Blue-Green
  100% ─┐                                   100% ─┐ old (active)
        │                                         │
   10%  │ old          10% new                new │ 100% (preview,
        │              ▲                           │      no live traffic)
   50%  │ old      50% │ new                        │
        │              │ analysis gate               │ prePromotionAnalysis
    0%  │              │ new: 100%                    │ gate
        └──────────────┴──────────────►          cutover: 100% new,
        traffic shifts in steps,                  0% old, in one move
        gated between each step
```

Canary spreads risk across several small, gated exposures. Blue-green concentrates verification into one pre-cutover check, then moves all traffic at once.

---

## Canary Strategy

Canary shifts traffic to the new version incrementally, in named steps, with a pause (manual or timed) between each. The key YAML shape:

```yaml
strategy:
  canary:
    steps:
      - setWeight: 10
      - pause: { duration: 5m }
      - analysis:
          templates:
            - templateName: checkout-success-rate
          args:
            - name: service-name
              value: checkout-service-canary
      - setWeight: 50
      - pause: { duration: 5m }
      - analysis:
          templates:
            - templateName: checkout-success-rate
      - setWeight: 100
```

Each `setWeight` step shifts that percentage of traffic to the new ReplicaSet via whichever traffic-management integration is configured — an Ingress controller, a service mesh, or a load balancer controller. The `analysis` steps between weight increases are where this stops being "a slower rolling update" and becomes an actual gate: the rollout does not proceed to the next `setWeight` unless the referenced `AnalysisTemplate` reports success.

**The traffic-router gap worth knowing:** if the Ingress controller isn't one of Rollouts' supported traffic-router plugins, it silently falls back to a ReplicaSet-ratio approximation. A single canary Pod out of 10 total is not the same as a precise 10% of requests. Confirming which traffic-router plugin is actually active — not just assumed — is worth doing before trusting `setWeight` values as precise.

---

## Blue-Green Strategy

Blue-green skips the incremental traffic shift and instead runs the full new version alongside the full old version, with a single cutover once the new version is verified:

```yaml
strategy:
  blueGreen:
    activeService: checkout-service-active
    previewService: checkout-service-preview
    autoPromotionEnabled: false
    prePromotionAnalysis:
      templates:
        - templateName: checkout-smoke-test
      args:
        - name: service-name
          value: checkout-service-preview
    scaleDownDelaySeconds: 300
```

The new version scales up fully behind `previewService` — reachable for testing, not yet receiving production traffic. `prePromotionAnalysis` runs against the preview version before any cutover is possible. With `autoPromotionEnabled: false`, cutover requires an explicit `kubectl argo rollouts promote` even after analysis passes — a deliberate human checkpoint on top of the automated one.

`scaleDownDelaySeconds` keeps the old ReplicaSet running for 5 minutes after cutover so a rollback is a service-selector flip back, not a fresh Pod startup. Setting it too low defeats the rollback advantage — if Pods take 90 seconds to become traffic-ready and `scaleDownDelaySeconds` is 30, the old ReplicaSet is already gone by the time a problem surfaces.

---

## AnalysisTemplates — What Actually Gates the Rollout

Both strategies are only as good as the analysis behind them. An `AnalysisTemplate` defines a metric query and a success condition; Rollouts polls it on an interval and compares the result against thresholds:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: checkout-success-rate
  namespace: checkout
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 1m
      count: 5
      successCondition: result[0] >= 0.95
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}", status!~"5.."}[1m]))
            /
            sum(rate(http_requests_total{service="{{args.service-name}}"}[1m]))
```

This queries Prometheus for the canary's success rate every minute, five times, and requires each sample to hold at or above 95%. Rollouts supports the same pattern against Datadog, New Relic, CloudWatch, and others — the shape of "query a metric, define a success condition, sample N times" is the transferable part.

**The two failure modes worth planning for explicitly:**

- A `successCondition` that's too loose (`result[0] >= 0.50`, left over from testing) will pass a canary that's failing half its requests. The gate is present but not gating.
- A `count` too low to be statistically meaningful on a low-traffic service — one or two failures in a handful of requests swing the ratio well outside a 95% threshold on pure noise, triggering rollbacks on releases that were actually fine.

Both point to the same discipline: AnalysisTemplate thresholds need to be tuned against the actual traffic volume and baseline error rate of the specific service, not copied from another service's template.

---

## Where This Sits Against CI/CD Pipeline Stages

Kargo's Stage-level verification (or a CI-to-GitOps handoff) answers "should this artifact be allowed into this environment at all." Argo Rollouts answers a different question, one layer down: "given that this artifact is now allowed into this environment, how carefully should it be exposed to that environment's traffic."

The two compose rather than compete. A Kargo `Stage` promoting into prod can just as easily be updating a `Rollout` resource as a plain `Deployment`. Nothing about progressive delivery requires picking a different CI-to-GitOps mechanism.

Running both isn't redundant defense in depth for its own sake — each catches a class of failure the other structurally cannot. A service can pass every pre-promotion check and still fail an in-flight Rollouts analysis: a load-dependent memory leak, a connection pool exhausting under real concurrency, a downstream dependency behaving differently under production traffic patterns than under a synthetic staging test.

---

## Decision Framework

| Situation | Recommended strategy |
| --- | --- |
| Stateless service, traffic-splitting infrastructure already in place | Canary — gradual blast-radius limiting, most granular control |
| No traffic-splitting infrastructure available | Blue-green, or canary via ReplicaSet ratio approximation |
| Release needs real-traffic-pattern validation before any production exposure | Blue-green — preview service gives you that validation window |
| Workload has strict version-coupling to a shared schema | Neither — fix the deployment pattern first |

---

## Read the Full Article

The full post covers:

- Complete annotated YAML for both canary and blue-green `Rollout` resources
- The exact traffic-router gap that makes `setWeight` values imprecise without a supported plugin
- Why `scaleDownDelaySeconds` sizing directly determines whether blue-green's rollback advantage is real or theoretical
- How AnalysisTemplate `count` and `successCondition` interact with low-traffic services to produce false rollbacks
- The precise relationship between Kargo/CI promotion gates and in-flight Rollouts analysis — why both are required and what each catches that the other cannot

**👉 [Progressive Delivery with Argo Rollouts — Full Article](https://aloknecessary.in/blogs/argo-rollouts-progressive-delivery/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=argo-rollouts-progressive-delivery)**
