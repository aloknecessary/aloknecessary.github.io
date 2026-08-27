---
layout: blog
title: "AWS MGN Architecture: How Continuous Replication Actually Works"
date: 2026-08-27
last_modified_at: 2026-08-27T12:02:04+05:30
author: Alok Ranjan Daftuar
description: "A deep dive into how AWS Application Migration Service works under the hood — the replication agent, staging area, continuous block-level sync, cutover mechanics, and where migrations actually fail."
excerpt: "Before I trusted AWS MGN with production cutovers, I needed to understand exactly what the replication agent does, second by second, from install to launch. This is that breakdown."
keywords: "aws mgn, application migration service, continuous replication, block-level replication, replication agent, cutover, staging area, azure to aws migration, ebs replication, cloudendure"
twitter_card: "summary_large_image"
categories:
  - cloud
  - migration
tags: [mgn, application-migration-service, replication, cutover, azure-to-aws, migration, terraform, ebs, ec2, cloud-migration]
series: "AWS Migration Playbook"
series_order: 1
---

The first time I ran an AWS Application Migration Service (MGN) migration, I made the mistake most people make: I trusted the console's green "Healthy" status without understanding what it actually meant. It took a stalled replication and a confusing lag metric mid-migration for me to go back and actually learn the mechanics underneath the dashboard. This post is the breakdown I wish I'd had before that first wave — what the replication agent does, what "continuous" actually means in practice, and where the real failure points are.

This is the opening piece of the AWS Migration Playbook series, written from the Azure-to-AWS migration work I'm currently running. The series covers the full arc of a real migration: the replication mechanics here, the OS-level conversion failures that surface at cutover, network and CIDR planning for the target VPC, and the operational patterns that keep a wave on track. The mechanics in this post underpin everything that follows, so it's worth reading first even if you're already comfortable with MGN at a surface level.

## What MGN actually is

AWS Application Migration Service is AWS's rebrand and successor to CloudEndure Migration, and it does one job: continuous, block-level replication of a source server's disks to a staging area in your target AWS account, so that when you're ready to cut over, you launch a fully synced, bootable EC2 instance instead of doing a one-time data copy and hoping nothing changed since.

The distinction that matters architecturally is **block-level, not file-level**. MGN doesn't care about your filesystem, your application state, or which files changed — it replicates raw disk blocks continuously, which is what allows it to keep a target instance in near-real-time sync with a live, running source server without needing any application-level awareness of what's being migrated.

## The four components, in order of what happens when you start a migration

### 1. The replication agent

Installed directly on the source server — whether that's an on-prem VM, an Azure VM, or another cloud's instance — the agent is a lightweight service that hooks into the OS's disk I/O path. On Linux, this means a kernel-level component reading block device writes; on Windows, a filter driver doing the equivalent. This is the exact layer where kernel driver issues originate — the agent's low-level disk hook interacts directly with the running kernel, so a kernel version mismatch on the source server isn't a minor compatibility footnote, it's a direct threat to replication itself.

Installing the agent is a single command with an IAM-scoped access key:

```bash
sudo python3 ./aws-replication-installer-init.py \
  --region ap-south-1 \
  --aws-access-key-id <access-key-id> \
  --aws-secret-access-key <secret-access-key> \
  --no-prompt
```

The `--no-prompt` flag matters for any installation you're scripting across a migration wave rather than running interactively — without it, the installer pauses for confirmation on disk selection, which silently stalls automation.

### 2. The staging area subnet

Before any replication traffic flows, MGN needs a staging area in the target AWS account — low-cost, minimal-spec EC2 instances (staging area servers, not the eventual launch instances) that receive the replicated data and write it to EBS volumes that mirror the source disks. This staging area lives in a subnet you designate during MGN setup, and it needs outbound connectivity to receive agent traffic and enough IOPS headroom on the EBS volumes to keep up with the source's write rate.

This is the first place CIDR planning intersects with MGN specifically — the staging subnet needs to be sized and positioned correctly relative to the rest of your target VPC, which is exactly what the CIDR planning article later in this series covers in detail. For now, the operationally important point: undersizing the staging subnet or placing it somewhere with restrictive route tables is a common cause of replication that starts but never reaches a healthy, low-lag state.

### 3. The replication server and EBS volumes

For each source server being migrated, MGN provisions a **replication server** in the staging subnet — a temporary EC2 instance whose only job is to receive the block-level stream from the agent and write it to a set of EBS volumes that exactly mirror the source's disk layout. These EBS volumes are the actual replica — they're what gets snapshotted and used to launch the target instance at cutover time.

This is worth being explicit about because it explains the cost model people often get wrong: you're paying for these replication server instances and their EBS volumes for the *entire duration* of the migration project, not just at cutover. A migration wave that sits in "replicating, not yet cut over" for six weeks is accumulating staging infrastructure cost for all six weeks, not a one-time transfer fee. For large waves, this is a real line item worth flagging to whoever owns the migration budget before the wave kicks off, not after.

### 4. Continuous sync and the lag metric

Once initial replication completes — the first full copy of every block on the source disks — MGN switches to continuous, incremental sync: every subsequent write on the source server is captured by the agent and streamed to the replication server as it happens. This is what "continuous" means in the product name — it's not periodic snapshotting, it's an ongoing stream.

The metric to actually watch here is **replication lag**, visible per source server in the MGN console. Lag measures how far behind the target's EBS volumes are from the live state of the source disks. A healthy migration sits at low, stable lag — seconds, not minutes. Lag that's climbing, rather than flat or oscillating within a small range, means the replication server can't keep up with the source's write rate, and it's a leading indicator of a cutover that will either take much longer than expected (because it has to catch up first) or that will launch a target instance further behind the source than acceptable for your rollback tolerance.

```bash
aws mgn describe-source-servers \
  --region ap-south-1 \
  --query 'items[*].{Server:sourceServerID, LagDuration:dataReplicationInfo.lagDuration, State:dataReplicationInfo.dataReplicationState}' \
  --output table
```

Running this as part of a pre-cutover checklist, not just glancing at the console, gives you a scriptable gate — don't proceed to cutover for any server where lag exceeds a threshold you've defined, rather than eyeballing a color indicator.

## What "cutover" actually triggers

Cutover isn't a data operation — by the time you initiate it, the data is already synced and has been for the duration of replication. What cutover actually does is:

1. Take a final snapshot of the target EBS volumes at the moment of cutover, capturing the last few seconds of lag.
2. Launch a new EC2 instance from that snapshot, using the launch template you've configured (instance type, subnet, security groups, IAM role — all specified in MGN's launch settings per source server, independent of the replication configuration).
3. Run the MGN post-launch conversion process inside the new instance — driver injection, network configuration adjustment, and OS-level changes needed to make a disk image that was running on a different hypervisor (Azure's, in this case) boot correctly under AWS's Nitro hypervisor.

Step 3 is where kernel driver failures happen. The conversion process needs to be able to inject or activate the correct network driver (`ena` for AWS's enhanced networking) for the instance to have connectivity after launch — and if the source server's kernel doesn't have the module available or the boot configuration doesn't reference it correctly, the resulting instance can come up without network connectivity or, in the case I ran into, fail to boot at all.

## Launch settings: the configuration surface most people under-invest in

Every source server in MGN has its own launch template, and it's easy to leave these at defaults during initial setup and only revisit them right before cutover — which is later than you want to catch a misconfiguration. Worth setting deliberately per server, not left as MGN's defaults:

- **Target instance type** — MGN can right-size automatically based on the source server's observed CPU/memory, but for anything performance-sensitive, set this explicitly rather than trusting the recommendation blindly.
- **Subnet and security groups** — these should already be decided by your target VPC's CIDR plan, not chosen ad hoc per server at cutover time.
- **IAM instance profile** — if the target instance needs to assume a role for other AWS service access post-migration, this has to be set in the launch template; it doesn't carry over from the source server in any way.
- **Test vs. cutover instance types** — MGN supports launching a *test* instance from current replication state without ending replication, which is the mechanism for validating a migration before committing to it. Always run at least one test launch before the real cutover; skipping this step to save time is the single most common way I've seen teams discover a launch-time problem during the actual cutover window instead of during a safe rehearsal.

## Replication settings that affect how MGN behaves under load

A few settings on the source server's replication configuration are worth understanding rather than leaving on defaults, especially for source servers with high write throughput:

- **Data routing and throttling** — by default, MGN doesn't cap the bandwidth it uses for replication, which is fine for a quiet source server but can compete with production traffic on a busy one. MGN supports configuring a maximum bandwidth throughput per source server specifically to avoid this, and it's worth setting deliberately for any source server that's actively serving production load during the replication window — the whole point of MGN's live-cutover model is that the source keeps running normally throughout, and uncapped replication bandwidth undermines that if it starts competing with the application's own network needs.
- **Volume type for staging** — MGN lets you choose the EBS volume type used for the replicated volumes in staging (gp3 versus io-series, for instance). For source servers with high write IOPS, the default staging volume type can itself become the bottleneck that shows up as climbing lag, even when network bandwidth between source and target is fine. This is a second, distinct cause of lag from the network-bandwidth cause above, and worth ruling in or out separately when diagnosing a server that won't stabilize.
- **Point-in-time (PIT) snapshots** — MGN can retain a rolling window of snapshots of the staging volumes, independent of the live replication state, which gives you a recovery point earlier than "right now" if you need to launch from a slightly older, known-good state rather than the current lag-zero point. This isn't a substitute for a test launch, but it's a useful safety net for a cutover where you want the option of stepping back a few hours if something in the most recent replicated state turns out to be the problem. PIT snapshots are configured per source server under **Replication settings → Point-in-time snapshots** in the MGN console — set the retention window before replication starts, not after, since snapshots only accumulate from the point the setting is enabled.

## Why continuous replication beats a snapshot-and-copy approach

It's worth being explicit about why MGN's model — continuous block replication with a live source server the whole time — is preferable to the simpler alternative of taking a disk snapshot, copying it to AWS, and cutting over from that single point-in-time copy. The snapshot approach has an unavoidable trade-off: the longer the gap between the snapshot and the actual cutover, the more source-side changes are missing from the target, and closing that gap means either accepting data loss or taking the source server offline for the copy window.

MGN's continuous model removes that trade-off entirely. Because the agent streams every write as it happens, the target stays within seconds of the source right up until the moment of cutover, and the source server never has to go offline for the migration itself — only for the brief cutover window when traffic is actually redirected. For anything with a real availability requirement, this is the entire reason to use MGN over a manual export/import process, and it's worth stating plainly when justifying the tooling choice to anyone outside the migration team who's only familiar with simpler, one-shot migration approaches.

## What I'd tell someone starting their first MGN migration

Watch replication lag from day one of the wave, not just before cutover — a server that never stabilizes to low lag is telling you something about network bandwidth between source and target or about staging area sizing, and it's much cheaper to fix that early than to discover it during a cutover maintenance window. Always run a test launch, not because MGN's documentation says to, but because it's the only step in the whole process that actually exercises the OS-level conversion logic before you're committed. And budget the staging infrastructure cost for the full duration you expect replication to run, not just the cutover event — it's a running cost, not a transfer fee, for as long as the wave is in flight.

> 📌 **Key Takeaway**: MGN's replication is continuous and block-level, which means the real risk in a migration isn't the data — it's the OS-level conversion at launch time, where a kernel or driver mismatch between source and target hypervisor can silently break networking or boot entirely. Test launches exist specifically to catch this before it happens at cutover, and skipping them is the most common way teams turn a routine migration into an incident.

That failure mode — the specific kernel driver issue that surfaces when migrating an Azure-sourced Ubuntu 24.04 image to AWS, why it manifests the way it does, and the fix — is covered in detail later in this series.
