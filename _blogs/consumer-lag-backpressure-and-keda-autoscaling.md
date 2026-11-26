---
title: "Consumer Lag, Backpressure and KEDA Autoscaling"
date: 2026-11-26
last_modified_at: 2026-11-26T11:28:04+05:30
author: Alok Ranjan Daftuar
description: "CPU is the wrong autoscaling signal for message consumers. Learn how to read lag on SQS, Service Bus, Kafka and Event Hubs, derive a replica target, protect downstream systems with backpressure, and configure KEDA on EKS and AKS without rebalance storms or killed in-flight work."
excerpt: "CPU tells you how hard your consumers are working. Lag tells you how far behind they are. Here is how to scale on the right signal."
keywords: "keda autoscaling, consumer lag, backpressure, kafka autoscaling, sqs keda, event-driven kubernetes, hpa consumer, rebalance storm"
twitter_card: "summary_large_image"
categories:
  - distributed-systems
  - devops
tags: [event-driven-architecture, keda, autoscaling, consumer-lag, backpressure, kubernetes, sqs, service-bus, kafka]
series: "Event-Driven Systems"
series_order: 4
---

The queue held forty thousand messages, and the Kubernetes dashboard showed the workers at 12% CPU. The Horizontal Pod Autoscaler, configured the way the team configures every service, was doing exactly what it was told: CPU was low, so no scaling. The workers were not busy computing. They were waiting on a payment gateway, so each pod sat idle for most of every message while the backlog grew.

The assumption that failed is "autoscale consumers like web servers." A web server's load arrives as requests, which burn CPU in proportion. A message consumer's load is **work waiting to be done**, and the broker already knows how much of it there is. CPU measures how hard the pods are working, and the number you care about is how far behind they are. Those are different questions, and the second one is the one your users feel.

---

## What lag actually is

Lag is the gap between what has been produced and what has been processed. Every broker exposes it differently, and each has a caveat that matters once you build scaling on top of it.

| Broker | Raw lag signal | Caveat |
| --- | --- | --- |
| SQS | `ApproximateNumberOfMessagesVisible`, plus in-flight (`...NotVisible`) | Approximate by design. `ApproximateAgeOfOldestMessage` is the better SLO signal |
| Service Bus | Active message count on the queue or subscription | Excludes the dead-letter sub-queue; scheduled and deferred messages are counted separately |
| Kafka / MSK | Sum over partitions of log-end offset minus committed offset | Parallelism is capped at partition count, so more replicas than partitions add nothing |
| Event Hubs | Last enqueued sequence number minus the checkpointed one | Needs a checkpoint store (Blob Storage), and lag is only as fresh as the last checkpoint |

On Kafka, look at lag per partition before you look at the total:

```bash
kafka-consumer-groups.sh --bootstrap-server "$BOOTSTRAP" --describe --group billing
# GROUP    TOPIC         PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG    CONSUMER-ID
# billing  order-events  0          1204550         1204610         60     consumer-1
# billing  order-events  7          998120          1041300         43180  consumer-4
```

The total hides the shape. Lag concentrated on one partition points to a hot key or a stuck consumer, and adding replicas cannot help, because that partition can only ever be read by one consumer in the group. Lag spread evenly across all partitions is a genuine capacity problem, and scaling is the right response.

Depth and age answer different questions. **Depth** says how much work is waiting. **Age** (how old the oldest unprocessed message is) says how late you are, which is what a latency SLO is about. A queue of 10,000 messages that drains in five seconds is healthy. A queue of 50 messages whose oldest has waited an hour is not. Scale on depth because it is cheap and predictive, and alert on age because it reflects what users experience.

---

## Turning lag into a replica target

Autoscalers need a *per-replica target*: how much backlog one replica should be responsible for. Derive it from throughput and the delay you can tolerate:

```text
target backlog per replica = per-replica throughput (msg/s) × acceptable wait (s)

example: 5 msg/s per replica × 60 s wait = 300 messages per replica
         backlog of 3,000 → 10 replicas; backlog of 30 → 1 replica
```

This is Little's law applied to a queue: the replicas you need are roughly arrival rate times processing time, divided by how many messages each replica handles concurrently. Measure the per-replica throughput under realistic load rather than guessing, since the number depends on your downstream latency, not your code.

That target is what KEDA calls `queueLength` or `messageCount` (SQS and Service Bus), or `lagThreshold` (Kafka). KEDA computes desired replicas as roughly `ceil(backlog / target)` and hands the result to a Horizontal Pod Autoscaler that it creates and manages for you.

---

## KEDA configuration

KEDA reads the broker directly through a scaler. For SQS it calls the queue attributes API itself, so it does not depend on the delay of CloudWatch metrics. Field names below follow the KEDA 2.x scaler docs, so confirm them against the version you have installed.

### AWS: SQS on EKS

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata: { name: aws-auth, namespace: billing }
spec:
  podIdentity:
    provider: aws   # the KEDA operator's identity needs sqs:GetQueueAttributes
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: billing-worker, namespace: billing }
spec:
  scaleTargetRef: { name: billing-worker }
  minReplicaCount: 1
  maxReplicaCount: 20          # sized from the downstream limit, not from the queue
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

Two settings deserve attention. `maxReplicaCount` is a safety limit for your downstream systems, and the next section explains how to choose it. The `behavior` block throttles how fast replicas change, because the HPA's defaults add up to four pods or double the count every fifteen seconds, which is good for draining a backlog and harsh on whatever the consumers call.

### Azure: Service Bus on AKS

```yaml
triggers:
- type: azure-servicebus
  authenticationRef: { name: azure-wi }   # TriggerAuthentication with podIdentity provider azure-workload
  metadata:
    namespace: sb-orders-prod
    topicName: order-events
    subscriptionName: billing
    messageCount: "300"
    activationMessageCount: "1"
```

### Kafka and MSK

```yaml
triggers:
- type: kafka
  metadata:
    bootstrapServers: broker-1:9092,broker-2:9092
    consumerGroup: billing
    topic: order-events
    lagThreshold: "500"
    activationLagThreshold: "1"
    allowIdleConsumers: "false"      # keep replicas ≤ partition count
    limitToPartitionsWithLag: "true" # don't count caught-up partitions toward the cap
```

With `allowIdleConsumers: "false"`, KEDA will not scale beyond the number of partitions, because any extra consumer would sit idle. It enforces the parallelism ceiling for you, which is why partition count has to be sized for future throughput up front. For Event Hubs, the `azure-eventhub` scaler reads the Blob checkpoint store and uses an `unprocessedEventThreshold` in the same way.

### Scale to zero, and what "cooldown" means

`minReplicaCount: 0` lets idle workers disappear, with `activationQueueLength` (or its Service Bus and Kafka equivalents) deciding when to wake them. The trade is cold-start latency on the first message. Note also that `cooldownPeriod` only governs the final step down to zero. Scaling from N to 1 is controlled by the HPA's scale-down stabilization window, which is why the example above sets it explicitly.

### When CPU is still the right signal

Not every consumer is I/O-bound. A worker that resizes images, parses large files, or runs an in-process model is CPU-bound, and for it CPU does track load. KEDA accepts several triggers on one `ScaledObject` and scales to whichever demands the most replicas, so you can combine queue lag with a `cpu` trigger and cover both cases. The queue trigger still handles the backlog, and the CPU trigger catches the case where a slow batch of messages saturates the pods before the backlog grows. Use CPU as a secondary signal, never as the only one.

---

## Backpressure: scaling the consumers is not scaling the system

Scaling consumers raises the load on everything they call. If twenty replicas each hold ten database connections, the database sees two hundred, and the autoscaler has just turned a slow queue into an outage. This is the same failure shape as the one described in [the partial failure article](/blogs/designing_for_partial_failure/): a healthy-looking component pushing a dependency past its limit.

Backpressure means the system makes the producer side wait, or at least makes the consumer side stop, when a downstream resource is saturated. Four mechanisms, from the outside in:

1. **Cap replicas from the downstream's capacity.** Work backwards: `maxReplicaCount × concurrency per replica × connections per call` must stay under the database or API limit. This is the most important number in the whole configuration.
2. **Bound per-replica concurrency.** Fix the SQS batch size, Service Bus `MaxConcurrentCalls`, or Kafka `max.poll.records` explicitly rather than inheriting defaults. Bound prefetch too: a large prefetch holds messages locked on a replica that has not started them yet, and they expire.
3. **Pause on downstream distress.** When a call returns a throttling or overload signal, stop pulling instead of failing and retrying immediately.
4. **Let the queue absorb the burst.** A growing queue is not a failure. It is the buffer working. The goal is to keep the oldest message's age inside the SLO, not to keep the depth at zero.

A worked example of the first mechanism makes the trade-off concrete. Suppose the database allows 100 connections and other services already use 30 of them. Each replica holds a pool of 5. The ceiling is `(100 − 30) / 5 = 14` replicas. At 5 messages per second per replica, that is 70 messages per second of sustained capacity. If peak arrival is 50 per second, there is headroom. If it is 120 per second, no amount of autoscaling helps: the bottleneck is the database, and the real options are batching writes, raising the database limit, or deferring non-urgent work. Setting `maxReplicaCount: 50` in that case would not drain the queue faster. It would exhaust connections and fail the other services too.

For the third mechanism, here is what pausing looks like with a Kafka consumer:

```ts
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    try {
      await callDownstream(message);
    } catch (e) {
      if (e instanceof TooManyRequestsError) {
        consumer.pause([{ topic, partitions: [partition] }]);
        setTimeout(
          () => consumer.resume([{ topic, partitions: [partition] }]),
          e.retryAfterMs
        );
      }
      throw e; // offset is not committed; the message is re-fetched after resume
    }
  },
});
```

The same idea exists on every broker: stop calling `ReceiveMessage` on SQS, stop the Service Bus processor, or shrink concurrency. What matters is that the consumer reacts to the dependency's signal instead of hammering it. Remember that every redelivery means the handler may run again, so [idempotency](/blogs/idempotency-distributed-systems/) is what makes pause-and-retry safe.

---

## Scale-down and rebalance hazards

Autoscaling has two failure modes that only appear when replicas change.

**Scale-down kills in-flight work.** When a pod is terminated, the message it was handling is either redelivered (SQS after the visibility timeout, Service Bus after lock expiry) or reprocessed after a rebalance (Kafka). Shut down deliberately: on `SIGTERM`, stop pulling new messages, finish what is in flight, then exit, and set `terminationGracePeriodSeconds` higher than your longest handler.

```ts
process.on("SIGTERM", async () => {
  stopPolling();              // no new messages
  await drainInFlight();      // finish or abandon cleanly within the grace period
  await consumer.disconnect();
  process.exit(0);
});
```

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 120   # longer than the slowest handler
```

**Timeouts must track latency under load, not latency at rest.** SQS visibility timeout, Service Bus lock duration, and Kafka's `max.poll.interval.ms` are all deadlines on how long a handler may hold a message. When a downstream slows down under the extra load that scaling created, handler time grows, and a timeout tuned for the quiet case expires mid-processing. The broker then redelivers the message to another replica while the first is still working on it, which doubles the load on the already-struggling dependency. Set these values from the p99 handler duration measured at your peak replica count, with headroom, and revisit them when you raise the ceiling.

**Every replica change on a Kafka consumer group triggers a rebalance.** During an eager rebalance, consumption pauses group-wide. An autoscaler that flaps, adding and removing pods every minute, produces a rebalance storm in which the group spends more time rebalancing than consuming. Three defenses work together: the HPA behavior block above (slow, stepwise changes and a long scale-down window), the cooperative-sticky assignor, which moves only the partitions that need to move, and static membership (`group.instance.id`) for workloads where restarts should not trigger reassignment.

---

## Test it before a real backlog does

The numbers in a `ScaledObject` are hypotheses until you test them. In a staging environment, publish a synthetic burst of a few thousand messages, then measure three things: how long the replicas take to appear, how long the backlog takes to drain, and whether the downstream system stays inside its limits while it happens. Compare the drain time with what the formula predicted. If it is far off, your per-replica throughput estimate was wrong, and the threshold needs to move.

Then test the unhappy paths on purpose: scale down while messages are in flight and confirm nothing is lost or processed twice without the handler noticing, and make the downstream return throttling errors to confirm the consumers pause instead of retrying in a tight loop. Those two experiments find most of the problems that otherwise surface during an incident.

---

## Reading the signals

Once autoscaling is in place, the useful alerts are about the relationship between lag and capacity, not about either alone:

| What you see | Likely meaning |
| --- | --- |
| Lag rising, replicas below the maximum | The scaler is not working: credentials, wrong metric, or a threshold set too high |
| Lag rising, replicas at the maximum | Capacity limit: raise `maxReplicaCount` only if the downstream can take it; otherwise fix handler latency |
| Lag high and flat, consumption near zero | Stuck consumers, a poison message, or paused partitions |
| Replicas oscillating | Threshold too close to normal load, or scale-down too aggressive |
| Lag fine, dead-letter count rising | Throughput is not the problem; failures are |

Alert on the age of the oldest message against your SLO, and track handler duration (p95), replica count, and the dead-letter queue depth next to it. Autoscaling hides symptoms, so a dashboard that shows only depth will look healthy right up until the replicas hit their ceiling.

---

> 📌 **Key Takeaway:** Scale consumers on the work waiting for them, not on CPU. Derive the per-replica target from measured throughput and the wait you can tolerate, set the replica ceiling from what downstream systems can absorb, throttle scaling so rebalances and in-flight work are not casualties, and alert on the age of the oldest message, which is what your users actually feel.
