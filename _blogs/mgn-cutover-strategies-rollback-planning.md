---
title: "MGN Cutover Strategies: Gating, Sequencing, and Keeping a Way Back"
date: 2026-10-15
last_modified_at: 2026-10-13T14:29:40+05:30
author: Alok Ranjan Daftuar
description: "MGN cutover isn't a data operation — the data is already replicated. It's a commitment to a new source of truth, and the strategy is about how reversible you keep that commitment through gating, sequencing, DNS mechanics, and a defined rollback window."
excerpt: "A cutover isn't the moment data moves. By the time you launch, the data is already there. It's the moment you commit to a new source of truth, and the strategy is about how reversible you keep that commitment."
keywords: "aws mgn, cutover, rollback, migration waves, dns ttl, azure to aws, application migration service, cutover sequencing, migration runbook"
twitter_card: "summary_large_image"
categories:
  - migration
tags: [aws-mgn, cutover, rollback, migration, dns, azure, aws]
series: "AWS Migration Playbook"
series_order: 5
---

The mental model that causes the most trouble going into a first cutover is that it's the "big copy." It isn't. As covered in [MGN Architecture and Continuous Replication](/blogs/aws-mgn-architecture-continuous-replication/), the data has been streaming to AWS for days or weeks by the time you launch a cutover instance. What the cutover actually does is take a final snapshot, launch an instance from it, and run the OS conversion. The hard part is everything around that: deciding when the source stops being authoritative, redirecting traffic, and keeping the option to go back.

This article covers how I approach cutover for Azure-sourced servers in a wave: the gate that has to pass before anything launches, the sequencing options, the DNS mechanics, and what rollback realistically looks like. It builds on the earlier pieces in this series: the [kernel fix](/blogs/aws-migration-ubuntu-kernel-fix/), the [serial console recovery](/blogs/azure-serial-console-boot-loop-recovery/), and the [CIDR planning](/blogs/aws-migration-cidr-planning/) work. Each of those is a way a cutover can fail that is much cheaper to catch beforehand.

## Know the lifecycle states before you automate anything

Every source server in MGN moves through a lifecycle, and cutover tooling that doesn't respect it will either error out or, worse, skip a step you assumed had happened. The state is visible per server:

```bash
aws mgn describe-source-servers \
  --region ap-south-1 \
  --query 'items[*].{Server:sourceServerID, Name:sourceProperties.identificationHints.hostname, State:lifeCycle.state, Lag:dataReplicationInfo.lagDuration}' \
  --output table
```

The states that matter for planning are `READY_FOR_TEST`, `TESTING`, `READY_FOR_CUTOVER`, `CUTTING_OVER`, and `CUTOVER`. The important rule is that a server shouldn't reach `CUTTING_OVER` without having been through `TESTING` first. MGN won't enforce this for you. It's a discipline you have to build into the process, which is why the gate below exists.

## The pre-cutover gate

Before any server in a wave is allowed to start cutover, I want a scripted check that passes or fails. Eyeballing a dashboard is how a server with climbing lag or an untested launch template gets through. The gate has five conditions:

1. **Replication is healthy and lag is low and stable**, not just momentarily low.
2. **A test launch has completed and been validated** over the real network path, not only the serial console.
3. **The kernel check has passed**, meaning no `-azure` kernel on the source, or the fix has been validated on the test instance (see the kernel fix article).
4. **The launch template is final**: instance type, subnet, security groups, and IAM profile all reviewed.
5. **The target subnet matches the CIDR plan**, so nothing is landing in an undecided tier.

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
  echo "FAIL: $SERVER_ID is $STATE, expected READY_FOR_CUTOVER (was a test completed and marked?)"
  exit 1
fi

if [[ "$REPL" != "CONTINUOUS" ]]; then
  echo "FAIL: replication state is $REPL, expected CONTINUOUS"
  exit 1
fi

# lagDuration is an ISO 8601 duration, e.g. PT12S. Parse seconds for the simple case.
LAG_SECONDS=$(echo "$LAG" | sed -E 's/PT([0-9]+)S/\1/')
if ! [[ "$LAG_SECONDS" =~ ^[0-9]+$ ]] || (( LAG_SECONDS > MAX_LAG )); then
  echo "FAIL: lag is $LAG, threshold is ${MAX_LAG}s"
  exit 1
fi

echo "PASS: $SERVER_ID ready for cutover (lag $LAG)"
```

Two notes on this script. The lag parsing only handles the seconds-only form of the duration. A server lagging by minutes returns a different format, and the script treats anything it can't parse as a failure, which is the safe default. And the first check is deliberately strict: `READY_FOR_CUTOVER` is only reached after a test has been run and the server explicitly marked ready, so this single check also enforces the "test first" rule.

## Sequencing: three shapes of cutover

Once servers pass the gate, the question is how to order them. These are the three shapes I actually weigh, and which one applies depends on dependencies between servers more than on anything else.

| Strategy | How it works | Best when | Main risk |
| --- | --- | --- | --- |
| **Big bang** | All servers in the wave cut over in one window | Tightly coupled tiers that can't run split across clouds | Largest blast radius; one failure stalls everyone |
| **Tier-by-tier** | Data tier first, then app, then web, with validation between | Clear dependency order; latency across clouds is tolerable | Cross-cloud latency during the window between tiers |
| **Server-by-server** | Independent servers cut over one at a time | Loosely coupled fleet with no shared state | Long total duration; drift between early and late servers |

Tier-by-tier has the real catch. For some period, the app tier is running in AWS while its database is still in Azure, or the other way around, and every call between them crosses a VPN or dedicated link. That only works if the connectivity exists, the CIDRs don't overlap (the whole point of the CIDR planning article), and the added latency is something the application tolerates. I've found the most defensible default is to group tightly coupled tiers into a single cutover unit and sequence the *units*, rather than splitting a chatty app from its database across clouds.

## Using MGN's application and wave constructs

MGN has first-class **applications** and **waves** that let you group source servers and act on them together, which is worth using rather than tracking groupings in a spreadsheet:

```bash
aws mgn create-application --name "billing-service" --region ap-south-1

aws mgn create-wave --name "wave-2-billing" --region ap-south-1

aws mgn associate-source-servers \
  --application-id app-0abc123 \
  --source-server-ids s-0111 s-0222 s-0333 \
  --region ap-south-1

aws mgn associate-applications \
  --wave-id wave-0def456 \
  --application-ids app-0abc123 \
  --region ap-south-1
```

Grouping this way means a cutover can be started for a whole application or wave in one call, and the console shows wave progress as a unit. It also forces you to decide the grouping explicitly, which is half of the sequencing decision.

## The cutover sequence itself

For a single server or cutover unit, this is the order I follow. The exact steps depend on the workload, but the shape is consistent.

**T minus 24 to 48 hours: lower DNS TTLs.** Anything clients use to find the server by name should have its TTL dropped well before the window. If a record has a 24-hour TTL and you only change it at cutover, clients keep resolving to the old Azure address for up to a day. Lowering the TTL to something like 60 seconds ahead of time, then restoring it afterward, is the cheapest risk reduction in the whole process.

**T minus 1 hour: re-run the gate.** Replication state and lag can change in the days since the test launch, so the gate runs again immediately before the window rather than being trusted from earlier.

**T zero: freeze writes on the source.** For anything stateful, stop the application, or put it into a read-only mode, so no new data lands on the source after the last replicated block. This is what makes the final snapshot consistent rather than just recent.

**Wait for lag to drain.** After writes stop, lag should fall to near zero as the last blocks replicate. Launching before this is how you lose the final few seconds of data.

```bash
# Confirm lag has drained before launching
aws mgn describe-source-servers --region ap-south-1 \
  --filters "sourceServerIDs=$SERVER_ID" \
  --query 'items[0].dataReplicationInfo.lagDuration'
```

**Launch the cutover instance:**

```bash
aws mgn start-cutover \
  --source-server-ids "$SERVER_ID" \
  --region ap-south-1

# Watch the job to completion
aws mgn describe-jobs --region ap-south-1 \
  --filters "jobIDs=$JOB_ID" \
  --query 'items[0].{Status:status, Type:type}'
```

**Validate before redirecting traffic.** The new instance is up but nothing points at it yet. This is the window to confirm it booted on the right kernel, has network reachability over the real path, and the application starts and passes its own health checks. If it's going to fail, you want it to fail here, while the source is still intact and no traffic has moved.

**Redirect traffic.** Update the DNS records (or load balancer targets) to point at the new instance. Because the TTL was lowered earlier, this takes effect in about a minute rather than a day.

**Then, and only then, finalize.** More on this next, because it's the step that determines whether you still have a way back.

## Rollback: what you actually have

The honest framing is that MGN cutover is a one-way door unless you deliberately keep it open. There is no automatic reverse replication from AWS back to an Azure source in this workflow. That has a few direct consequences.

While the Azure source VM still exists and is intact, the realistic rollback is: stop the AWS instance, repoint DNS back, and start the source again. That works cleanly *only* if no meaningful data was written on the AWS side in the meantime. Once users have been writing to the AWS instance, rolling back to the Azure source means losing that data unless you reconcile it by hand. So the rollback window is really "the period before the AWS side has accepted writes that matter," and it should be defined per workload before the cutover, not discovered during an incident.

Two practical rules follow from that:

- **Don't decommission the source on cutover day.** Power it off or deallocate it, but keep the VM and its disks. Deallocated Azure VMs still cost for their disks, and that cost is the price of keeping the door open. Set an explicit retention period and put the deletion date on the calendar.
- **Don't finalize or archive early.** Finalizing a cutover tells MGN the migration is complete for that server, and it's the point after which MGN stops treating the server as an active migration subject and cleans up the replication resources. Hold off until you've validated the workload in production for as long as your rollback window requires.

```bash
# Only after the rollback window has passed and the workload is validated:
aws mgn finalize-cutover --source-server-id "$SERVER_ID" --region ap-south-1

# Later, to clean up replication resources and stop the staging cost:
aws mgn mark-as-archived --source-server-id "$SERVER_ID" --region ap-south-1
```

Finalizing is also what stops the staging infrastructure cost described in the MGN architecture article, so there's pressure to do it early. That pressure is worth resisting for the length of your rollback window, then acting on promptly once it closes.

## Post-launch steps that belong in the cutover runbook

A few things have to happen on the new instance that aren't part of MGN's conversion. They go in the runbook explicitly so they don't depend on someone remembering:

- Move from `linux-generic` to the AWS-tuned `linux-aws` kernel once the instance is stable, as covered in the kernel fix article, so it gets platform-specific updates going forward.
- Remove or disable `walinuxagent` and any Azure-specific `cloud-init` datasource pinning.
- Attach the instance to the right target group or register it in DNS, depending on how traffic reaches it.
- Restore DNS TTLs to their normal values.

MGN's post-launch settings can run automated actions through Systems Manager on first boot, which is the natural place to put the repeatable parts of this list rather than doing them by hand per server.

## When the cutover instance fails validation

The validation step between launch and traffic redirect is where problems should surface, so it's worth deciding in advance what each failure means and what to do about it. The source is still intact and no traffic has moved, so you have more options here than at any later point.

- **Instance running, no network.** This is the `ena` driver pattern from the kernel fix article. Use the EC2 serial console to confirm the kernel and loaded modules. If it's the Azure kernel, the fix is the `linux-generic` swap on the cutover instance, then re-validate. Because traffic hasn't moved, there's no outage clock running, only the maintenance window.
- **Instance won't boot at all.** Treat it like the boot loop in the serial console article: get to the bootloader, check that the kernel and initramfs exist, and run `depmod` before regenerating the initramfs. If that isn't converging within the time you set aside, the clean fallback is to abort, leave the source as the authority, and reschedule, rather than improvising under a closing window.
- **Boots and networks, application misbehaves.** Usually a dependency on something that didn't move yet: a hardcoded Azure IP, a DNS name that doesn't resolve from AWS (see the DNS forwarding discussion in the CIDR planning article), or a security group that doesn't allow a dependency. These are fixable on the instance without touching the source.

The decision rule I use is a time-box agreed before the window opens: if validation isn't passing by a set point, abort and stay on the source. Aborting at that stage costs a rescheduled window. Pushing on, redirecting traffic to an unvalidated instance, and then discovering the problem is how a cutover becomes an incident.

## A cutover checklist

1. Gate script passes for every server in the unit: state, replication, lag.
2. Test launch validated over the real network path.
3. DNS TTLs lowered 24 to 48 hours ahead.
4. Rollback window and data-loss tolerance agreed *before* the window opens.
5. Source writes frozen; lag drained to near zero.
6. Cutover launched; instance validated before any traffic moves.
7. Traffic redirected; source powered off but retained.
8. Finalize only after the rollback window closes.

> 📌 **Key Takeaway**: Cutover isn't a data operation, since the data is already replicated. It's a commitment to a new source of truth, and the strategy is about how reversible you keep it. Gate every server on state, replication health, and a validated test launch; sequence by dependency rather than convenience; lower DNS TTLs early; and treat the Azure source as your rollback path by powering it off but keeping it until your rollback window closes. Finalizing too early trades your safety net for a slightly smaller bill.
