---
title: "Consumer Lag, Backpressure and KEDA Autoscaling"
published: false
description: CPU is the wrong autoscaling signal for message consumers — lag is what your users actually feel, and KEDA is how you act on it.
tags: kubernetes, kafka, event-driven, devops
canonical_url: https://aloknecessary.in/blogs/consumer-lag-backpressure-and-keda-autoscaling/
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a distributed message queue system under autoscaling pressure. A stream of glowing messages flows into a broker node, with Kubernetes pod replicas spinning up in response to a rising lag counter displayed on a floating dashboard. The visual suggests intelligent, metric-driven scaling — not chaos. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

The queue held forty thousand messages. The Kubernetes dashboard showed the workers at 12% CPU. The Horizontal Pod Autoscaler did exactly what it was told — CPU was low, so no scaling happened. The workers were not busy computing. They were waiting on a payment gateway, sitting idle for most of every message while the backlog grew.

The assumption that failed is "autoscale consumers like web servers." A web server's load arrives as requests that burn CPU in proportion. A message consumer's load is *work waiting to be done*, and the broker already knows how much of it there is. CPU measures how hard the pods are working. Lag measures how far behind they are. Those are different questions, and the second one is the one your users feel.

---

## What lag actually is

Lag is the gap between what has been produced and what has been processed. Every broker exposes it differently:

| Broker | Raw lag signal | Caveat |
| --- | --- | --- |
| SQS | `ApproximateNumberOfMessagesVisible` + in-flight | Approximate by design; `ApproximateAgeOfOldestMessage` is the better SLO signal |
| Service Bus | Active message count on queue or subscription | Excludes dead-letter sub-queue; scheduled/deferred counted separately |
| Kafka / MSK | Sum of log-end offset minus committed offset per partition | Parallelism capped at partition count — more replicas than partitions add nothing |
| Event Hubs | Last enqueued sequence minus checkpointed sequence | Lag is only as fresh as the last Blob checkpoint |

On Kafka, always look at lag *per partition* before looking at the total. Lag concentrated on one partition points to a hot key or stuck consumer — adding replicas cannot help. Lag spread evenly across all partitions is a genuine capacity problem, and scaling is the right response.

**Depth vs age:** depth says how much work is waiting; age says how late you are. A queue of 10,000 messages that drains in five seconds is healthy. A queue of 50 messages whose oldest has waited an hour is not. Scale on depth (cheap and predictive), alert on age (what users experience).

## Turning lag into a replica target

Autoscalers need a per-replica target — how much backlog one replica should own. Derive it from throughput and the wait you can tolerate:

```text
target backlog per replica = per-replica throughput (msg/s) × acceptable wait (s)

example: 5 msg/s × 60 s = 300 messages per replica
         backlog of 3,000 → 10 replicas
         backlog of 30    → 1 replica
```

This is Little's Law applied to a queue. Measure per-replica throughput under realistic load — the number depends on downstream latency, not your code. This target maps directly to KEDA's `queueLength` (SQS), `messageCount` (Service Bus), or `lagThreshold` (Kafka).

## KEDA configuration

KEDA reads the broker directly through a scaler — for SQS it calls the queue attributes API itself, bypassing CloudWatch delay entirely.

### SQS on EKS

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: billing-worker, namespace: billing }
spec:
  scaleTargetRef: { name: billing-worker }
  minReplicaCount: 1
  maxReplicaCount: 20          # sized from downstream capacity, not queue depth
  pollingInterval: 15
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          policies: [{ type: Pods, value: 4, periodSeconds: 60 }]
        scaleDown:
          stabilizationWindowSeconds: 300
          policies: [{ type: Percent, value: 25, periodSeconds: 60 }]
  triggers:
  - type: aws-sqs-queue
    authenticationRef: { name: aws-auth }
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/billing-order-events
      queueLength: "300"
      awsRegion: us-east-1
```

The `behavior` block is critical — HPA defaults can add four pods or double the count every 15 seconds, which is good for draining a backlog and harsh on whatever the consumers call downstream.

### Kafka / MSK

```yaml
triggers:
- type: kafka
  metadata:
    bootstrapServers: broker-1:9092,broker-2:9092
    consumerGroup: billing
    topic: order-events
    lagThreshold: "500"
    activationLagThreshold: "1"
    allowIdleConsumers: "false"       # keeps replicas ≤ partition count
    limitToPartitionsWithLag: "true"  # ignores caught-up partitions
```

`allowIdleConsumers: "false"` enforces the parallelism ceiling automatically — KEDA will not scale beyond partition count.

## Backpressure: scaling consumers is not scaling the system

Scaling consumers raises load on everything they call. Twenty replicas each holding ten database connections means two hundred connections — the autoscaler just turned a slow queue into an outage.

Four mechanisms, from the outside in:

1. **Cap replicas from downstream capacity.** Work backwards: `maxReplicaCount × concurrency per replica × connections per call` must stay under the database or API limit. This is the most important number in the whole configuration.
2. **Bound per-replica concurrency.** Fix SQS batch size, Service Bus `MaxConcurrentCalls`, or Kafka `max.poll.records` explicitly. Bound prefetch too — a large prefetch holds messages locked on a replica that hasn't started them yet.
3. **Pause on downstream distress.** When a call returns a throttling signal, stop pulling instead of retrying in a tight loop.
4. **Let the queue absorb the burst.** A growing queue is not a failure — it is the buffer working. The goal is to keep the oldest message's age inside the SLO, not to keep depth at zero.

A concrete example: database allows 100 connections, other services use 30, each replica holds a pool of 5. Ceiling = `(100 − 30) / 5 = 14` replicas. Setting `maxReplicaCount: 50` would not drain the queue faster — it would exhaust connections and fail other services too.

## Scale-down and rebalance hazards

**Scale-down kills in-flight work.** On `SIGTERM`, stop pulling new messages, finish what is in flight, then exit. Set `terminationGracePeriodSeconds` higher than your longest handler:

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 120
```

**Timeouts must track latency under load, not at rest.** SQS visibility timeout, Service Bus lock duration, and Kafka's `max.poll.interval.ms` are deadlines on how long a handler may hold a message. When a downstream slows under extra load, handler time grows, and a timeout tuned for the quiet case expires mid-processing — causing the broker to redeliver to another replica while the first is still working on it.

**Every Kafka replica change triggers a rebalance.** An autoscaler that flaps produces a rebalance storm where the group spends more time rebalancing than consuming. Three defenses: the HPA behavior block (slow, stepwise changes), the cooperative-sticky assignor (moves only partitions that need to move), and static membership (`group.instance.id`) for workloads where restarts should not trigger reassignment.

---

## Read the Full Article

The full post covers:

- The complete KEDA configuration for Service Bus on AKS and Event Hubs
- The `scale to zero` pattern and what `cooldownPeriod` actually controls (hint: not what most people think)
- When CPU *is* the right signal and how to combine it with lag as a secondary trigger
- A worked Kafka pause-on-throttle implementation in TypeScript
- A full signal-reading table mapping what you see in dashboards to what it means operationally
- How to test your `ScaledObject` configuration against a synthetic burst before a real backlog does it for you

**👉 [Consumer Lag, Backpressure and KEDA Autoscaling — Full Article](https://aloknecessary.in/blogs/consumer-lag-backpressure-and-keda-autoscaling/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=consumer-lag-backpressure-and-keda-autoscaling)**
