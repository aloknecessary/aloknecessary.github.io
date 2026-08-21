---
title: "AWS MGN Architecture: How Continuous Replication Actually Works"
published: false
description: A deep dive into what the AWS Application Migration Service replication agent actually does — from install to cutover — and where migrations silently fail.
tags: aws, migration, cloud, devops
canonical_url: https://aloknecessary.in/blogs/aws-mgn-architecture-continuous-replication/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-mgn-architecture-continuous-replication
cover_image:
---

The first time I ran an AWS MGN migration, I trusted the console's green "Healthy" status without understanding what it actually meant. It took a stalled replication and a confusing lag metric mid-cutover to make me go back and learn the mechanics underneath the dashboard. This post is the breakdown I wish I'd had before that first wave.

MGN does one job: continuous, block-level replication of a source server's disks to a staging area in your target AWS account, so that when you cut over, you launch a fully synced, bootable EC2 instance instead of doing a one-time data copy and hoping nothing changed since. The distinction that matters is **block-level, not file-level** — MGN doesn't care about your filesystem or application state, which is what allows it to keep a target in near-real-time sync with a live, running source server throughout the migration.

---

## The four components, in order

**1. The replication agent** — installed directly on the source server, hooks into the OS's disk I/O path at the kernel level. On Linux this means a kernel-level block device reader; on Windows, a filter driver. This low-level hook is why a kernel version mismatch on the source isn't a minor footnote — it's a direct threat to replication itself.

```bash
sudo python3 ./aws-replication-installer-init.py \
  --region ap-south-1 \
  --aws-access-key-id <access-key-id> \
  --aws-secret-access-key <secret-access-key> \
  --no-prompt
```

The `--no-prompt` flag matters for scripted wave installations — without it, the installer pauses for disk selection confirmation and silently stalls automation.

**2. The staging area subnet** — a designated subnet in the target AWS account where MGN provisions its replication infrastructure. Needs outbound connectivity and enough IOPS headroom on EBS to keep up with the source's write rate. Undersizing this subnet or placing it behind restrictive route tables is a common cause of replication that starts but never stabilizes.

**3. The replication server and EBS volumes** — for each source server, MGN provisions a temporary EC2 instance in the staging subnet whose only job is to receive the block-level stream and write it to EBS volumes that mirror the source's disk layout. These EBS volumes are the actual replica — they're what gets snapshotted at cutover.

The cost model people get wrong: you're paying for these replication servers and EBS volumes for the **entire duration** of the migration project, not just at cutover. A wave that sits in "replicating, not yet cut over" for six weeks accumulates staging infrastructure cost for all six weeks.

**4. Continuous sync and the lag metric** — once initial replication completes, MGN switches to continuous incremental sync: every write on the source is captured and streamed as it happens. The metric to watch is **replication lag** — how far behind the target EBS volumes are from the live source. Lag that climbs rather than staying flat is a leading indicator of a cutover that will either take much longer than expected or launch a target instance further behind the source than your rollback tolerance allows.

```bash
aws mgn describe-source-servers \
  --region ap-south-1 \
  --query 'items[*].{Server:sourceServerID, LagDuration:dataReplicationInfo.lagDuration, State:dataReplicationInfo.dataReplicationState}' \
  --output table
```

Use this as a scriptable pre-cutover gate rather than eyeballing a color indicator in the console.

---

## What cutover actually triggers

Cutover is not a data operation — the data is already synced. What it actually does:

1. Takes a final snapshot of the target EBS volumes at the moment of cutover
2. Launches a new EC2 instance from that snapshot using the launch template you've configured
3. Runs the MGN post-launch conversion process — driver injection, network configuration, and OS-level changes needed to make a disk image that ran on a different hypervisor boot correctly under AWS's Nitro hypervisor

Step 3 is where kernel driver failures happen. The conversion process needs to inject or activate the correct network driver (`ena`) for the instance to have connectivity after launch. If the source server's kernel doesn't have the module available or the boot configuration doesn't reference it correctly, the instance can come up without network connectivity — or fail to boot entirely.

---

## Launch settings most people under-invest in

Every source server has its own launch template in MGN. Worth setting deliberately before cutover, not left at defaults:

- **Target instance type** — set explicitly for anything performance-sensitive rather than trusting MGN's right-size recommendation
- **Subnet and security groups** — should be decided by your VPC CIDR plan, not chosen ad hoc at cutover time
- **IAM instance profile** — doesn't carry over from the source server; must be set in the launch template explicitly
- **Test launch** — MGN supports launching a test instance from current replication state without ending replication. Always run at least one test launch before the real cutover. Skipping this is the single most common way teams discover a launch-time problem during the actual cutover window instead of during a safe rehearsal

---

## Replication settings that matter under load

Three settings worth understanding rather than leaving on defaults for source servers with high write throughput:

- **Bandwidth throttling** — MGN doesn't cap replication bandwidth by default, which can compete with production traffic on a busy source server. Set a maximum throughput per source server for anything actively serving production load during the replication window
- **Staging volume type** — the default EBS volume type for staging can itself become the bottleneck for high-IOPS sources, showing up as climbing lag even when network bandwidth is fine. Rule this in or out separately from the network-bandwidth cause when diagnosing a server that won't stabilize
- **Point-in-time (PIT) snapshots** — MGN can retain a rolling window of snapshots of the staging volumes, giving you a recovery point earlier than "right now" if you need to launch from a known-good state. Configure this under **Replication settings → Point-in-time snapshots** in the MGN console before replication starts — snapshots only accumulate from the point the setting is enabled

---

## Why continuous replication beats snapshot-and-copy

The snapshot approach has an unavoidable trade-off: the longer the gap between snapshot and cutover, the more source-side changes are missing from the target. Closing that gap means either accepting data loss or taking the source offline for the copy window.

MGN's continuous model removes that trade-off entirely. The target stays within seconds of the source right up until cutover, and the source never has to go offline for the migration itself — only for the brief cutover window when traffic is actually redirected. For anything with a real availability requirement, this is the entire reason to use MGN over a manual export/import process.

---

## Read the Full Article

The summary covers the core mechanics. The full article goes deeper on:

- The troubleshooting priority order for "these are definitely connected but nothing works" tickets — route tables, attachment state, security layers, DNS — and why checking in that sequence resolves the large majority of cases without reasoning about the full topology from scratch
- The specific kernel driver failure mode that surfaces when migrating Azure-sourced Ubuntu images to AWS, why it manifests the way it does, and the fix
- The full cost model for staging infrastructure across a multi-week wave, with the specific line items to flag before the wave kicks off
- CIDR planning considerations for the staging subnet relative to the rest of the target VPC

**👉 [AWS MGN Architecture: How Continuous Replication Actually Works — Full Article](https://aloknecessary.in/blogs/aws-mgn-architecture-continuous-replication/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-mgn-architecture-continuous-replication)**
