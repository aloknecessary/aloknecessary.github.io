---
title: "Queue vs Topic vs Log: Picking the Broker"
date: 2026-10-08
last_modified_at: 2026-10-08T12:58:54+05:30
author: Alok Ranjan Daftuar
description: "Queue, topic, and log are three different contracts about who owns a message after delivery. How to choose between SQS, SNS, EventBridge, MSK, Service Bus, Event Grid, and Event Hubs, with the Terraform, Bicep, and Kafka config that encode the decision."
excerpt: "Most broker decisions are made in a ten-minute conversation that ends with 'we'll just use Kafka.' Both sentences treat the broker as a throughput-and-price decision. It isn't. What you're choosing is a contract: who owns a message after delivery, and whether yesterday's events still exist tomorrow."
keywords: "messaging, event-driven architecture, sqs, sns, eventbridge, kafka, msk, kinesis, service bus, event hubs, event grid, queue, topic, log, aws, azure, terraform, bicep"
twitter_card: "summary_large_image"
categories:
  - distributed-systems
tags: [event-driven-architecture, messaging, sqs, sns, eventbridge, kafka, service-bus, event-hubs, aws, azure]
series: "Event-Driven Systems"
series_order: 1
---

Most broker decisions are made in a ten-minute conversation that ends with "we'll just use Kafka," or from the other side, "SQS is fine, it's cheap." Both sentences treat the broker as a throughput-and-price decision. It isn't. What you are actually choosing is a **contract**: who owns a message after it is delivered, who tracks how far each consumer has read, and whether yesterday's events still exist tomorrow.

Get the contract wrong and no tuning fixes it. A team that picks a queue and later needs a new service to bootstrap from the last 30 days of order events has nothing to replay. A team that picks Kafka for background jobs ends up owning partition planning, rebalances and head-of-line blocking to get what a queue provides out of the box.

This article separates the three primitives, maps them onto AWS and Azure services, and gives a decision framework you can apply before anyone says the word "Kafka."

---

## Three primitives, three contracts

```text
QUEUE (competing consumers)         TOPIC (fan-out)                    LOG (retained stream)

 producer ──▶ [ m3 m2 m1 ] ──┬▶ A    producer ──▶ topic ──┬▶ [sub-A] ▶ A   producer ──▶ [m1 m2 m3 m4 m5 …]
                             └▶ B                         ├▶ [sub-B] ▶ B                  ▲        ▲
   each message goes to ONE            each subscription gets                       consumer X      consumer Y
   consumer, then is deleted           its OWN copy                                 (offset 2)      (offset 5)
                                                                                    messages stay; readers keep position
```

| | Queue | Topic (pub/sub) | Log |
| --- | --- | --- | --- |
| Delivery model | Competing consumers: one handler per message | Fan-out: every subscription gets a copy | Every consumer group reads the whole stream independently |
| After consumption | Deleted on ack | Deleted per subscription on ack | Retained until retention expires, regardless of reads |
| Read position owned by | Broker (visibility timeout / lock) | Broker, per subscription | Consumer (offset) |
| Replay | No | No (EventBridge archive is a partial exception) | Yes, by rewinding offsets |
| Failure handling | Per-message retry and DLQ | Per-subscription retry and DLQ | None built in: a failing message blocks its partition |
| Ordering | Optional and scoped (FIFO group, session) | Usually per subscription, if at all | Per partition |

The last two rows are where teams get surprised. In a queue, message 7 failing does not stop message 8: the broker tracks each message individually and redelivers 7 after the visibility timeout. In a log, the consumer's offset means "everything before this is done," so a message that keeps failing stalls its partition unless you build retry topics yourself.

You can see the difference in the acknowledgment code:

```ts
// Queue (SQS): ack is per message. Failure = no delete = redelivery after the visibility timeout.
const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
  QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
}));
for (const m of Messages) {
  await handle(JSON.parse(m.Body!));
  await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
}

// Log (Kafka via kafkajs): ack is a position. Committing offset N+1 says "all ≤ N are done".
await consumer.run({
  autoCommit: false,
  eachMessage: async ({ topic, partition, message }) => {
    await handle(JSON.parse(message.value!.toString()));
    await consumer.commitOffsets([{
      topic, partition, offset: (BigInt(message.offset) + 1n).toString(),
    }]);
  },
});
```

Committing per message is shown for clarity. In production you batch commits, which widens the redelivery window after a crash. Either way, both models are at-least-once, so the consumer must be idempotent, a problem covered in [the idempotency article](/blogs/idempotency-distributed-systems/).

---

## Mapping the primitives to AWS and Azure

| Primitive | AWS | Azure | What to know |
| --- | --- | --- | --- |
| Queue | SQS Standard / FIFO | Service Bus queues | Broker-tracked state, DLQ, visibility timeout (SQS) or peek-lock (Service Bus) |
| Topic | SNS, SNS FIFO | Service Bus topics + subscriptions | A Service Bus subscription *is* a durable queue. SNS is push-only, so you add SQS as the durable buffer |
| Event router | EventBridge | Event Grid | Content-based routing of discrete events from cloud and SaaS sources. A router, not a streaming backbone |
| Log | MSK, Kinesis Data Streams | Event Hubs (Kafka endpoint) | Partitioned, retained, consumer-owned offsets |

Three mapping details decide real designs:

**SNS and Service Bus topics are not equivalent.** On Azure, a topic subscription is a queue with its own lock, delivery count and dead-letter sub-queue. On AWS, SNS pushes to a subscriber, and if that subscriber is slow or down, you depend on SNS retry policies. The standard AWS answer is SNS → SQS per consumer, which recreates what Service Bus gives natively.

**EventBridge and Event Grid are routers, not backbones.** They are the right tool when an AWS or Azure resource event, or a SaaS event, should trigger a reaction, or when you route by event content to many targets. They are the wrong tool for a high-volume internal event backbone where you need ordering and replay at a known cost.

**Log services differ in what they let you change later.** Kafka partitions can be increased but not reduced, and increasing them changes the key-to-partition mapping. On Event Hubs Basic and Standard the partition count is fixed at creation. Kinesis uses shards that you can split and merge. Partition count is a design decision, not a tuning knob.

---

## The pattern that covers most systems: topic fan-out into per-consumer queues

When several services need the same event and each has its own pace and failure handling, publish once to a topic and give every consumer its own queue. Each consumer gets isolation, its own DLQ, and independent scaling.

### AWS: SNS → SQS with filtering and a DLQ

```hcl
resource "aws_sns_topic" "orders" {
  name = "order-events"
}

resource "aws_sqs_queue" "billing_dlq" {
  name                      = "billing-order-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

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

data "aws_iam_policy_document" "allow_sns" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.billing.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.orders.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "billing" {
  queue_url = aws_sqs_queue.billing.id
  policy    = data.aws_iam_policy_document.allow_sns.json
}
```

The non-obvious decisions are all here: `raw_message_delivery` so consumers read your payload and not an SNS envelope, `filter_policy_scope = "MessageBody"` so routing works on the payload and not only on message attributes, a visibility timeout longer than your slowest handler (otherwise the message is redelivered while still being processed), and the queue policy scoped to this topic's ARN.

### Azure: Service Bus topic with a filtered subscription

```bicep
resource ns 'Microsoft.ServiceBus/namespaces@2021-11-01' = {
  name: 'sb-orders-prod'
  location: resourceGroup().location
  sku: { name: 'Standard', tier: 'Standard' }
}

resource topic 'Microsoft.ServiceBus/namespaces/topics@2021-11-01' = {
  parent: ns
  name: 'order-events'
  properties: {
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    defaultMessageTimeToLive: 'P7D'
  }
}

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

Two differences from the AWS version matter in practice. Service Bus SQL filters evaluate message **properties**, not the body, so the publisher must set `eventType` as an application property. And a subscription created without an explicit rule gets a catch-all `$Default` rule; rules on a subscription are OR'd, so after deployment confirm with `az servicebus topic subscription rule list` that the default rule is not still attached next to your filter, or the subscription receives everything.

Service Bus also gives you what SQS needs configuration for: the dead-letter sub-queue exists by default, and duplicate detection on the topic collapses producer retries that reuse a `MessageId` within the window. That helps the publish side of [the dual write problem](/blogs/dual-write-problem-in-event-driven-architecture/) but does not remove the need for idempotent consumers.

---

## When you need a log

Reach for a log when retention is the requirement: new consumers must read history, projections must be rebuildable, or stream processing needs ordered per-key state. The configuration decisions are in the topic definition:

```bash
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create \
  --topic order-events \
  --partitions 12 \
  --replication-factor 3 \
  --config min.insync.replicas=2 \
  --config retention.ms=604800000   # 7 days
```

`--partitions 12` is your parallelism ceiling per consumer group: a thirteenth consumer in the group sits idle. `replication-factor 3` with `min.insync.replicas=2` and producers using `acks=all` tolerates one broker loss without losing acknowledged writes. Retention is the replay window: size it for how far back a recovering or new consumer might need to go, not for average lag.

On Azure, Event Hubs gives you the same partitioned, retained model without running brokers, and its Kafka endpoint means existing Kafka clients can connect. The trade is that you work inside the service's limits, such as retention caps and a partition count fixed at creation on Basic and Standard tiers. MSK keeps full Kafka semantics but leaves broker sizing, upgrades and rebalancing behavior as your problem even though the control plane is managed. Check the current service quotas for either before committing, since these limits change.

---

## What "exactly-once" actually covers

Every service above delivers at-least-once in normal operation. The "exactly-once" features are narrower than the name suggests:

- **SQS FIFO** deduplicates on a deduplication ID within a five-minute window. A producer retry after that window creates a second message.
- **Service Bus duplicate detection** works on `MessageId` within the window you configure on the topic or queue. It protects the broker from producer retries, not your database from a redelivered message.
- **Kafka transactions** give atomic read-process-write *between Kafka topics*. The moment your handler writes to a database or calls an HTTP API, that side effect is outside the transaction.

So the broker choice does not remove the need for idempotent consumers. It only changes where duplicates come from: producer retries, visibility-timeout expiry, lock loss, or consumer-group rebalances.

## What you own after the choice

The same event flow has very different ownership costs depending on the primitive:

- **SQS, SNS, EventBridge, Service Bus, Event Grid** are pay-per-use and have no capacity to plan. What you tune is visibility timeouts or lock durations, retry limits, and DLQ handling. The failure you meet most is a consumer slower than its timeout, which causes duplicate processing.
- **Event Hubs and Kinesis** make you pick throughput units or shard capacity up front, and partition or shard count is a structural decision. The failure you meet most is a hot key that overloads one partition while the others sit idle.
- **MSK and self-managed Kafka** add broker sizing, storage, upgrades and rebalance behavior on top. That cost is justified by features the managed alternatives lack, such as Kafka Streams, Connect and log compaction, but it should be a conscious purchase rather than a default.

One piece of cheap insurance applies when you choose a queue or topic but suspect replay might matter later: attach an archival consumer from day one. On AWS, SNS can deliver to Amazon Data Firehose, which writes to S3. On Azure, Event Hubs Capture does this natively for a log, while Service Bus needs a dedicated subscription with a consumer that writes to Blob Storage. Archiving costs little now and is the difference between "we can rebuild that projection" and "that history is gone."

---

## Four questions, in order

| # | Question | If yes |
| --- | --- | --- |
| 1 | Must a new or recovering consumer read events from before it existed (replay, backfill, rebuilding a projection)? | **Log.** Retention is the requirement, not throughput |
| 2 | Do several independent services need the same event, each at its own pace and with its own failure handling? | **Topic fanning into per-consumer queues** (SNS → SQS, Service Bus topics) |
| 3 | Is this work distribution: one handler per message, per-message retry, delays, a DLQ? | **Queue** |
| 4 | Is it a discrete state change from a cloud or SaaS source that should trigger reactions? | **EventBridge / Event Grid** |

Answers can combine. A common production shape is a log as the system-of-record backbone with queues downstream for the consumers that need per-message retry and a DLQ, so one poison message cannot stall a partition.

Ordering does not pick the primitive on its own, because it is scoped everywhere: an SQS FIFO message group, a Service Bus session, a Kafka or Event Hubs partition. "Global ordering" means a single group, session or partition, which is the throughput of one consumer. If someone asks for it, ask what they actually need ordered, and per which key.

### What the wrong choice looks like in production

- **Queue chosen, log needed:** no replay. Teams bolt on an archive to S3 or Blob Storage and then build their own replay tooling, which is a log built badly.
- **Log chosen, queue needed:** one malformed message blocks a partition, parallelism is capped by partition count, and the team hand-rolls retry topics and a dead-letter topic.
- **Topic without a durable buffer:** push delivery to a slow or down subscriber depends on retry policy, and once retries are exhausted the event is gone for that subscriber unless you configured a dead-letter destination.

---

> 📌 **Key Takeaway:** Choosing a broker is choosing a contract, not a throughput tier. A queue gives you per-message ownership and failure handling, a topic gives you fan-out with an independent buffer per consumer, and a log gives you retention with consumer-owned position. Decide on replay and fan-out first; throughput and price decide between products only after that.
