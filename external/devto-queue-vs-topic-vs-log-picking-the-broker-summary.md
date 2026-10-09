---
title: "Queue vs Topic vs Log: Picking the Broker"
published: false
description: Queue, topic, and log are three different contracts about who owns a message after delivery — not three throughput tiers. Getting the contract wrong means no amount of tuning fixes it.
tags: aws, azure, kafka, distributed-systems
canonical_url: https://aloknecessary.in/blogs/queue-vs-topic-vs-log-picking-the-broker/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=queue-vs-topic-vs-log-picking-the-broker
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of three distinct message flow patterns — a queue with competing consumers, a topic fanning out to multiple subscribers, and a retained log with independent consumer offsets at different positions. Each pattern glows with a different neon accent, suggesting three fundamentally different contracts. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Most broker decisions are made in a ten-minute conversation that ends with "we'll just use Kafka," or from the other side, "SQS is fine, it's cheap." Both sentences treat the broker as a throughput-and-price decision. It isn't. What you are actually choosing is a **contract**: who owns a message after it is delivered, who tracks how far each consumer has read, and whether yesterday's events still exist tomorrow.

Get the contract wrong and no tuning fixes it. A team that picks a queue and later needs a new service to bootstrap from the last 30 days of order events has nothing to replay. A team that picks Kafka for background jobs ends up owning partition planning, rebalances, and head-of-line blocking to get what a queue provides out of the box.

---

## Three primitives, three contracts

```text
QUEUE (competing consumers)         TOPIC (fan-out)                    LOG (retained stream)

 producer ──▶ [ m3 m2 m1 ] ──┬▶ A    producer ──▶ topic ──┬▶ [sub-A] ▶ A   producer ──▶ [m1 m2 m3 m4 m5 …]
                             └▶ B                         ├▶ [sub-B] ▶ B                  ▲        ▲
   each message goes to ONE            each subscription gets                       consumer X      consumer Y
   consumer, then is deleted           its OWN copy                                 (offset 2)      (offset 5)
```

| | Queue | Topic (pub/sub) | Log |
| --- | --- | --- | --- |
| Delivery model | Competing consumers: one handler per message | Fan-out: every subscription gets a copy | Every consumer group reads the whole stream independently |
| After consumption | Deleted on ack | Deleted per subscription on ack | Retained until retention expires, regardless of reads |
| Read position owned by | Broker (visibility timeout / lock) | Broker, per subscription | Consumer (offset) |
| Replay | No | No | Yes, by rewinding offsets |
| Failure handling | Per-message retry and DLQ | Per-subscription retry and DLQ | None built in: a failing message blocks its partition |

The last row is where teams get surprised. In a queue, message 7 failing does not stop message 8. In a log, the consumer's offset means "everything before this is done" — a message that keeps failing stalls its partition unless you build retry topics yourself.

---

## Mapping to AWS and Azure

| Primitive | AWS | Azure |
| --- | --- | --- |
| Queue | SQS Standard / FIFO | Service Bus queues |
| Topic | SNS, SNS FIFO | Service Bus topics + subscriptions |
| Event router | EventBridge | Event Grid |
| Log | MSK, Kinesis Data Streams | Event Hubs (Kafka endpoint) |

Three mapping details decide real designs:

**SNS and Service Bus topics are not equivalent.** On Azure, a topic subscription is a queue with its own lock, delivery count, and dead-letter sub-queue. On AWS, SNS pushes to a subscriber — the standard answer is SNS → SQS per consumer, which recreates what Service Bus gives natively.

**EventBridge and Event Grid are routers, not backbones.** Right for cloud/SaaS event reactions. Wrong for a high-volume internal event backbone where you need ordering and replay at a known cost.

**Partition count is a design decision, not a tuning knob.** Kafka partitions can be increased but not reduced. Event Hubs Basic/Standard partition count is fixed at creation. Size it for how far back a recovering consumer might need to go.

---

## The pattern that covers most systems: topic fan-out into per-consumer queues

When several services need the same event, publish once to a topic and give every consumer its own queue. Each consumer gets isolation, its own DLQ, and independent scaling.

### AWS: SNS → SQS with filtering

```hcl
resource "aws_sqs_queue" "billing" {
  name                       = "billing-order-events"
  visibility_timeout_seconds = 120 # must exceed worst-case handler time
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.billing_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sns_topic_subscription" "billing" {
  topic_arn            = aws_sns_topic.orders.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.billing.arn
  raw_message_delivery = true # otherwise the body is an SNS JSON envelope
  filter_policy_scope  = "MessageBody"
  filter_policy = jsonencode({
    eventType = ["OrderPlaced", "OrderCancelled"]
  })
}
```

The non-obvious decisions: `raw_message_delivery` so consumers read your payload and not an SNS envelope, `filter_policy_scope = "MessageBody"` so routing works on the payload, and a visibility timeout longer than your slowest handler.

### Azure: Service Bus topic with a filtered subscription

```bicep
resource billing 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2021-11-01' = {
  parent: topic
  name: 'billing'
  properties: {
    lockDuration: 'PT2M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
  }
}

resource billingFilter 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2021-11-01' = {
  parent: billing
  name: 'order-lifecycle'
  properties: {
    filterType: 'SqlFilter'
    sqlFilter: { sqlExpression: 'eventType IN (\'OrderPlaced\', \'OrderCancelled\')' }
  }
}
```

Service Bus SQL filters evaluate message **properties**, not the body — the publisher must set `eventType` as an application property. A subscription without an explicit rule gets a catch-all `$Default` rule; confirm it's not still attached after deployment or the subscription receives everything.

---

## When you need a log

Reach for a log when retention is the requirement: new consumers must read history, projections must be rebuildable, or stream processing needs ordered per-key state.

```bash
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create \
  --topic order-events \
  --partitions 12 \
  --replication-factor 3 \
  --config min.insync.replicas=2 \
  --config retention.ms=604800000   # 7 days
```

`--partitions 12` is your parallelism ceiling per consumer group: a thirteenth consumer sits idle. `replication-factor 3` with `min.insync.replicas=2` and `acks=all` tolerates one broker loss without losing acknowledged writes.

---

## Four questions, in order

| # | Question | If yes |
| --- | --- | --- |
| 1 | Must a new or recovering consumer read events from before it existed? | **Log** |
| 2 | Do several independent services need the same event, each at their own pace? | **Topic fanning into per-consumer queues** |
| 3 | Is this work distribution: one handler per message, per-message retry, a DLQ? | **Queue** |
| 4 | Is it a discrete state change from a cloud or SaaS source triggering reactions? | **EventBridge / Event Grid** |

Answers can combine. A common production shape is a log as the system-of-record backbone with queues downstream for consumers that need per-message retry and a DLQ — so one poison message cannot stall a partition.

---

## Read the Full Article

This summary covers the three primitives, the AWS/Azure service mapping, and the decision framework. The full article includes:

- Complete Terraform for the SNS → SQS fan-out pattern including the IAM queue policy scoped to the topic ARN
- Full Bicep for the Service Bus topic with duplicate detection and filtered subscription
- The "exactly-once" section — what SQS FIFO deduplication, Service Bus duplicate detection, and Kafka transactions actually cover (and don't cover)
- The archival consumer pattern: how to attach cheap replay insurance from day one when you choose a queue or topic
- What the wrong choice looks like in production — queue chosen when a log was needed, log chosen when a queue was needed, topic without a durable buffer

**👉 [Queue vs Topic vs Log: Picking the Broker — Full Article](https://aloknecessary.in/blogs/queue-vs-topic-vs-log-picking-the-broker/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=queue-vs-topic-vs-log-picking-the-broker)**
