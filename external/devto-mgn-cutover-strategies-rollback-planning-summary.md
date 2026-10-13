---
title: "MGN Cutover Strategies: Gating, Sequencing, and Keeping a Way Back"
published: false
description: MGN cutover isn't a data operation — the data is already replicated. It's a commitment to a new source of truth, and the strategy is about how reversible you keep that commitment.
tags: aws, migration, devops, cloud
canonical_url: https://aloknecessary.in/blogs/mgn-cutover-strategies-rollback-planning/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=mgn-cutover-strategies-rollback-planning
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a migration cutover moment — two parallel server environments (one fading out, one lighting up) connected by a glowing data stream, with a DNS switch and a countdown timer as the central visual metaphor. The transition is mid-flight: one side still active, the other coming online. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

The mental model that causes the most trouble going into a first MGN cutover is that it's the "big copy." It isn't. By the time you launch a cutover instance, the data has been streaming to AWS for days or weeks. What the cutover actually does is take a final snapshot, launch an instance from it, and run the OS conversion. The hard part is everything around that: deciding when the source stops being authoritative, redirecting traffic, and keeping the option to go back.

This article covers the gate that has to pass before anything launches, the three sequencing shapes and when each applies, the DNS mechanics, and what rollback realistically looks like for Azure-sourced servers migrating to AWS with MGN.

---

## Know the lifecycle states before you automate anything

Every source server in MGN moves through a defined lifecycle. Cutover tooling that doesn't respect it will either error out or skip a step you assumed had happened.

```bash
aws mgn describe-source-servers \
  --region ap-south-1 \
  --query 'items[*].{Server:sourceServerID, Name:sourceProperties.identificationHints.hostname, State:lifeCycle.state, Lag:dataReplicationInfo.lagDuration}' \
  --output table
```

The states that matter: `READY_FOR_TEST`, `TESTING`, `READY_FOR_CUTOVER`, `CUTTING_OVER`, `CUTOVER`. A server shouldn't reach `CUTTING_OVER` without having been through `TESTING` first — MGN won't enforce this for you.

---

## The pre-cutover gate

Before any server in a wave is allowed to start cutover, run a scripted check that passes or fails. Eyeballing a dashboard is how a server with climbing lag or an untested launch template gets through.

Five conditions must pass:

1. Replication is healthy and lag is low and stable
2. A test launch has completed and been validated over the real network path
3. The kernel check has passed (no `-azure` kernel, or the fix has been validated)
4. The launch template is final: instance type, subnet, security groups, IAM profile
5. The target subnet matches the CIDR plan

```bash
#!/bin/bash
# cutover-gate.sh <source-server-id> <max-lag-seconds>
SERVER_ID="$1"
MAX_LAG="${2:-60}"
REGION="ap-south-1"

read -r STATE LAG REPL <<< "$(aws mgn describe-source-servers \
  --region "$REGION" \
  --filters "sourceServerIDs=$SERVER_ID" \
  --query 'items[0].[lifeCycle.state, dataReplicationInfo.lagDuration, dataReplicationInfo.dataReplicationState]' \
  --output text)"

if [[ "$STATE" != "READY_FOR_CUTOVER" ]]; then
  echo "FAIL: $SERVER_ID is $STATE, expected READY_FOR_CUTOVER"
  exit 1
fi

if [[ "$REPL" != "CONTINUOUS" ]]; then
  echo "FAIL: replication state is $REPL, expected CONTINUOUS"
  exit 1
fi

LAG_SECONDS=$(echo "$LAG" | sed -E 's/PT([0-9]+)S/\1/')
if ! [[ "$LAG_SECONDS" =~ ^[0-9]+$ ]] || (( LAG_SECONDS > MAX_LAG )); then
  echo "FAIL: lag is $LAG, threshold is ${MAX_LAG}s"
  exit 1
fi

echo "PASS: $SERVER_ID ready for cutover (lag $LAG)"
```

`READY_FOR_CUTOVER` is only reached after a test has been run and the server explicitly marked ready — so this single state check also enforces the "test first" rule.

---

## Sequencing: three shapes of cutover

| Strategy | How it works | Best when | Main risk |
| --- | --- | --- | --- |
| **Big bang** | All servers in the wave cut over in one window | Tightly coupled tiers that can't run split across clouds | Largest blast radius |
| **Tier-by-tier** | Data tier first, then app, then web, with validation between | Clear dependency order; latency across clouds is tolerable | Cross-cloud latency during the window |
| **Server-by-server** | Independent servers cut over one at a time | Loosely coupled fleet with no shared state | Long total duration; drift between early and late servers |

Tier-by-tier has the real catch: for some period, the app tier is running in AWS while its database is still in Azure, or vice versa. That only works if the connectivity exists, the CIDRs don't overlap, and the added latency is something the application tolerates. The most defensible default is to group tightly coupled tiers into a single cutover unit and sequence the *units*.

MGN's first-class application and wave constructs let you group servers and act on them together:

```bash
aws mgn create-application --name "billing-service" --region ap-south-1
aws mgn associate-source-servers \
  --application-id app-0abc123 \
  --source-server-ids s-0111 s-0222 s-0333 \
  --region ap-south-1
```

---

## The cutover sequence

**T minus 24–48 hours: lower DNS TTLs.** If a record has a 24-hour TTL and you only change it at cutover, clients keep resolving to the old Azure address for up to a day. Lower to ~60 seconds ahead of time, restore afterward.

**T minus 1 hour: re-run the gate.** Replication state and lag can change in the days since the test launch.

**T zero: freeze writes on the source.** Stop the application or put it into read-only mode so no new data lands on the source after the last replicated block.

**Wait for lag to drain**, then launch:

```bash
aws mgn start-cutover \
  --source-server-ids "$SERVER_ID" \
  --region ap-south-1
```

**Validate before redirecting traffic.** The new instance is up but nothing points at it yet. Confirm it booted on the right kernel, has network reachability, and the application passes health checks. If it's going to fail, you want it to fail here.

**Redirect traffic, then finalize only after the rollback window closes:**

```bash
# Only after the rollback window has passed:
aws mgn finalize-cutover --source-server-id "$SERVER_ID" --region ap-south-1
aws mgn mark-as-archived --source-server-id "$SERVER_ID" --region ap-south-1
```

---

## Rollback: what you actually have

MGN cutover is a one-way door unless you deliberately keep it open. There is no automatic reverse replication from AWS back to an Azure source. The realistic rollback is: stop the AWS instance, repoint DNS back, start the source again — but only if no meaningful data was written on the AWS side in the meantime.

Two practical rules:

- **Don't decommission the source on cutover day.** Power it off, keep the VM and disks. Set an explicit retention period and put the deletion date on the calendar.
- **Don't finalize early.** Finalizing tells MGN the migration is complete and cleans up replication resources. Hold off until you've validated the workload in production for as long as your rollback window requires.

Finalizing also stops the staging infrastructure cost, so there's pressure to do it early. That pressure is worth resisting for the length of your rollback window, then acting on promptly once it closes.

---

## When the cutover instance fails validation

The validation step between launch and traffic redirect is where problems should surface. The source is still intact and no traffic has moved — you have more options here than at any later point.

- **Instance running, no network** — the `ena` driver / Azure kernel pattern. Use EC2 serial console, confirm the kernel, apply the `linux-generic` swap fix, re-validate.
- **Instance won't boot** — get to the bootloader, check kernel and initramfs, run `depmod` before regenerating. If not converging within the time-box, abort and reschedule.
- **Boots and networks, application misbehaves** — usually a hardcoded Azure IP, a DNS name that doesn't resolve from AWS, or a missing security group rule. Fixable on the instance without touching the source.

The decision rule: if validation isn't passing by a pre-agreed time-box, abort and stay on the source. Pushing on and redirecting traffic to an unvalidated instance is how a cutover becomes an incident.

---

## Read the Full Article

The full post covers:

- The complete 8-step cutover checklist in runbook form
- Post-launch steps that belong in every runbook (kernel swap to `linux-aws`, removing `walinuxagent`, restoring DNS TTLs)
- How MGN's post-launch Systems Manager actions can automate the repeatable parts
- The exact `finalize-cutover` and `mark-as-archived` sequencing and why the staging cost pressure is worth resisting

**👉 [MGN Cutover Strategies: Gating, Sequencing, and Keeping a Way Back — Full Article](https://aloknecessary.in/blogs/mgn-cutover-strategies-rollback-planning/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=mgn-cutover-strategies-rollback-planning)**
