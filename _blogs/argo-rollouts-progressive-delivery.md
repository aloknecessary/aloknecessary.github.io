---
layout: blog
title: "Progressive Delivery with Argo Rollouts: Canary, Blue-Green, and AnalysisTemplates That Actually Gate"
date: 2026-09-03
last_modified_at: 2026-09-03T13:17:42+05:30
author: Alok Ranjan Daftuar
description: "Argo Rollouts replaces the all-or-nothing Kubernetes Deployment rollout with a strategy that pauses, runs automated analysis against real traffic, and only proceeds — or reverses — based on the result. This post covers canary and blue-green strategies, AnalysisTemplate gating, and where progressive delivery fits against a CI/CD pipeline."
excerpt: "A standard Deployment rollout is all-or-nothing once it starts. Argo Rollouts adds the pause points and automated gates that decide, without a human watching a dashboard, whether a release should continue or reverse."
keywords: "argo rollouts, progressive delivery, canary deployment, blue-green deployment, kubernetes, analysis template, gitops, ci-cd, traffic management, deployment strategy"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [argocd, gitops, kubernetes, argo-rollouts, progressive-delivery, platform-engineering, canary, blue-green, ci-cd, observability]
series: "GitOps in Practice"
series_order: 5
---

> Every article so far in this series has assumed a sync succeeds cleanly: the new manifest applies, the new Pods come up, done. That's also exactly how a standard Kubernetes `Deployment` behaves — a rolling update that replaces old Pods with new ones on a fixed schedule, with no concept of "check whether this is actually working before replacing more of them." If the new version is broken, a standard rolling update finds out the same way your users do: by serving it to more and more of them until someone notices.

Argo Rollouts replaces the `Deployment` resource with a `Rollout` — API-compatible with `Deployment` in its Pod template, but with an explicit strategy for how traffic shifts and, critically, automated checks that can halt or reverse that shift before it reaches everyone. This article covers the two strategies that matter in practice, the `AnalysisTemplate` mechanism that makes the gating real rather than cosmetic, and where this fits against the CI/CD pipeline built up in Articles 3 and 4.

## Why a Deployment isn't enough

A `Deployment`'s rolling update is governed by `maxSurge` and `maxUnavailable` — how many extra Pods can exist during the rollout, how many can be unavailable. Neither of those is a correctness check. A `Deployment` will happily roll a broken version out to 100% of Pods at the pace you configured, because nothing in the resource's model asks "is this new version actually healthy" — only "are enough Pods reporting ready," which a broken-but-still-passing-liveness-probe version satisfies just fine.

Argo Rollouts' `Rollout` resource keeps the same Pod template but replaces the update mechanism with a `strategy` that can pause, run automated analysis, and only proceed — or roll back — based on the result.

```text
Canary                                    Blue-Green
  100% ─┐                                   100% ─┐ old (active)
        │                                         │
   90%  │ old          10% new                new │ 100% (preview,
        │              ▲                           │      no live traffic)
   50%  │ old      50% │ new                        │
        │              │ analysis gate               │ prePromotionAnalysis
    0%  │              │ new: 100%                    │ gate
        └──────────────┴──────────────►          cutover: 100% new,
        traffic shifts in steps,                  0% old, in one move
        gated between each step                   (old kept warm for rollback)
```

The shapes make the tradeoff visible: canary spreads risk across several small, gated exposures; blue-green concentrates verification into one pre-cutover check, then moves all traffic at once.

## Canary strategy

Canary shifts traffic to the new version incrementally, in named steps, with a pause (manual or timed) between each:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-service
  namespace: checkout
spec:
  replicas: 10
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
            args:
              - name: service-name
                value: checkout-service-canary
        - setWeight: 100
  selector:
    matchLabels:
      app: checkout-service
  template:
    metadata:
      labels:
        app: checkout-service
    spec:
      containers:
        - name: checkout-service
          image: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service:v1.4.2
```

Each `setWeight` step shifts that percentage of traffic to the new ReplicaSet, via whichever traffic-management integration is configured — an Ingress controller, a service mesh, or an AWS/Azure load balancer controller, all supported through Rollouts' traffic router plugins. The `analysis` steps between weight increases are where this stops being "a slower rolling update" and becomes an actual gate: the rollout does not proceed to the next `setWeight` unless the referenced `AnalysisTemplate` reports success.

**What you get:** blast radius on a bad release is capped at whatever the first `setWeight` step exposed — 10% of traffic in the example above, not 100%. Automated analysis between steps means the decision to proceed doesn't depend on a human watching a dashboard in real time during the rollout window.

**What it costs you:** canary needs a traffic-splitting mechanism that can actually route a precise percentage of traffic to two versions simultaneously — a service mesh, a compatible Ingress controller, or a supported load balancer integration. Without one of those, Rollouts falls back to a cruder approximation using ReplicaSet Pod count ratios, which is directionally similar but not a precise percentage. It also assumes the workload can safely run two versions concurrently, serving live traffic to both — true for most stateless services, not automatically true for anything with strict version-coupling to a shared datastore schema.

A representative shape of the traffic-router gap causing a real problem: a canary configured with a 10% `setWeight` step, but running on a cluster where the Ingress controller isn't one of Rollouts' supported traffic-router plugins. Rollouts silently falls back to the ReplicaSet-ratio approximation — 1 canary Pod out of 10 total, rather than a precise 10% of requests — and because a single Ingress-level Service load-balances across all Pods behind it without weighting, that one canary Pod can end up receiving anywhere from 0% to well over 10% of requests in a given window depending on connection distribution, not the clean 10% the `setWeight` value implies. The analysis step still runs and still gates correctly on whatever traffic the canary actually received — but "correctly gated" and "gated on a representative sample" aren't the same guarantee, and the gap between them only becomes visible when a canary that received an unusually small, unrepresentative slice of traffic passes analysis on noise rather than signal. Confirming which traffic-router plugin is actually active — not just assumed — is worth doing before trusting `setWeight` values as precise.

## Blue-green strategy

Blue-green skips the incremental traffic shift and instead runs the full new version alongside the full old version, with a single cutover once the new version is verified:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-service
  namespace: checkout
spec:
  replicas: 10
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
  selector:
    matchLabels:
      app: checkout-service
  template:
    metadata:
      labels:
        app: checkout-service
    spec:
      containers:
        - name: checkout-service
          image: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout-service:v1.4.2
```

The new version scales up fully behind `previewService` — reachable for testing, not yet receiving production traffic through `activeService`. `prePromotionAnalysis` runs against the preview version before any cutover is even possible. With `autoPromotionEnabled: false`, cutover requires an explicit `kubectl argo rollouts promote checkout-service` (or a manual approval step wired into CI) even after analysis passes — a deliberate human checkpoint layered on top of the automated one. `scaleDownDelaySeconds` keeps the old ReplicaSet running for 5 minutes after cutover specifically so a rollback is a service-selector flip back, not a fresh Pod startup.

**What you get:** the full new version is tested against real traffic patterns via the preview service before a single production request hits it — a meaningfully stronger check than a canary's "10% of live traffic, hope the sample is representative." Rollback is close to instant, since the old ReplicaSet is still warm and ready during the scale-down delay window.

**What it costs you:** double the resource footprint during the transition — both versions fully scaled simultaneously, not incrementally. No gradual blast-radius limiting the way canary's `setWeight` steps provide; cutover is effectively all 10 Pods at once, so if `prePromotionAnalysis` has a blind spot the analysis didn't catch, that gap shows up at 100% of traffic immediately rather than at 10%.

The `scaleDownDelaySeconds` value is worth sizing deliberately rather than leaving at a default, since it directly trades resource cost against rollback speed. At 300 seconds, the old ReplicaSet sits fully scaled for 5 minutes post-cutover — doubled compute cost for that window, in exchange for a rollback that's a Service selector change (seconds) rather than a fresh Pod startup (however long the container takes to become ready, plus any warm-up the application needs before it's actually healthy under load). Setting it too low defeats much of the point of blue-green's rollback advantage — a `scaleDownDelaySeconds` of 30 on a service whose Pods take 90 seconds to become traffic-ready means the old ReplicaSet is already gone by the time a problem serious enough to need rollback typically surfaces, leaving the team no faster a recovery path than canary would have offered at a fraction of the resource cost.

## AnalysisTemplates — what actually gates the rollout

Both strategies are only as good as the analysis behind them. An `AnalysisTemplate` defines a metric query and a success condition; Rollouts polls it on an interval and compares the result against thresholds that determine pass, fail, or inconclusive.

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
            sum(rate(http_requests_total{service="{% raw %}{{args.service-name}}{% endraw %}", status!~"5.."}[1m]))
            /
            sum(rate(http_requests_total{service="{% raw %}{{args.service-name}}{% endraw %}"}[1m]))
```

This queries Prometheus for the canary's success rate every minute, five times, and requires each of those five samples to hold at or above 95% — `failureLimit: 1` means a single sample below threshold fails the whole analysis and, by extension, halts or reverses the rollout depending on how the step is configured. Rollouts supports the same pattern against Datadog, New Relic, CloudWatch, and a handful of other providers, so this isn't Prometheus-specific — the shape of "query a metric, define a success condition, sample N times" is the transferable part.

The failure mode worth planning for explicitly is a *misconfigured* AnalysisTemplate, not just a genuinely broken release. A `successCondition` that's too loose — `result[0] >= 0.50`, say, left over from an early testing phase and never tightened — will pass a canary that's actually failing half its requests, and the rollout proceeds to 100% having "passed" a gate that never meaningfully gated anything. The inverse mistake is just as common and less discussed: a `successCondition` set correctly but a `count` too low to be statistically meaningful — a single 1-minute sample on a low-traffic service might contain a handful of requests, where one or two failures swing the ratio well outside a 95% threshold on pure noise, triggering rollbacks on releases that were actually fine. Both failure shapes point to the same underlying discipline: an AnalysisTemplate's threshold and sample count need to be tuned against the actual traffic volume and baseline error rate of the specific service it's gating, not copied wholesale from another service's template and assumed to transfer.

Treat AnalysisTemplate thresholds with the same review rigor as the AppProject `destinations` restrictions from Article 2: a gate that's technically present but too permissive to reject a bad release provides exactly the same false confidence as an AppProject with a wildcarded destination list.

## Where this sits against Articles 3 and 4

Article 3's CI-to-GitOps handoff and Kargo's staged promotion answer "should this artifact be allowed into this environment at all." Argo Rollouts answers a different question, one layer down: "given that this artifact is now allowed into this environment, how carefully should it be exposed to that environment's traffic." The two compose rather than compete — a Kargo `Stage` promoting into prod, or a CI commit landing in the prod overlay from Article 3, can just as easily be updating a `Rollout` resource as it would a plain `Deployment`. Nothing about progressive delivery requires picking a different CI-to-GitOps mechanism; it changes what happens inside the cluster once that mechanism has done its job.

Worth being explicit about where the two layers' verification differs, since it's easy to assume one makes the other redundant. Kargo's Stage-level verification (Article 3) checks whether an artifact is *fit to promote* — typically a smoke test or integration suite run once, before promotion happens. Rollouts' AnalysisTemplate gates check whether the *live rollout* is behaving correctly under real production traffic, continuously, during the exposure itself. A service can pass every pre-promotion check Kargo runs and still fail an in-flight Rollouts analysis — a load-dependent memory leak, a connection pool exhausting under real concurrency, a downstream dependency behaving differently under production traffic patterns than under a synthetic staging test. Running both isn't redundant defense in depth for its own sake; each catches a class of failure the other structurally cannot.

## Decision framework

| Situation | Recommended strategy |
| --- | --- |
| Stateless service, traffic-splitting infrastructure (mesh or compatible Ingress) already in place | Canary — gradual blast-radius limiting, most granular control |
| No traffic-splitting infrastructure available | Blue-green, or canary via ReplicaSet ratio approximation if resource footprint for full blue-green is a concern |
| Release needs real-traffic-pattern validation before any production exposure, and double resource footprint during transition is acceptable | Blue-green — the preview service gives you that validation window canary can't |
| Workload has strict version-coupling to a shared schema or can't safely run two versions concurrently | Neither — this is a signal the deployment needs a different pattern (expand-contract schema migration, versioned APIs) before progressive delivery strategy is the right lever to pull |

## What's next

Every article in this series so far has covered the pipeline working as designed — sync succeeding, images updating, secrets resolving, rollouts gating correctly. Article 6 closes the series with the opposite: what auto-sync and self-heal actually do when they collide with something else changing cluster state — an HPA fighting ArgoCD's declared replica count, a sync wave failing partway, an operator mutating a resource ArgoCD also considers its own — grounded in the incident shapes these failures actually take.
