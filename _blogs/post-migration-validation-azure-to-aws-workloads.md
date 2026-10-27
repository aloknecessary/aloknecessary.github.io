---
title: "Post-Migration Validation: Proving a Migrated Server Is Actually Equivalent"
date: 2026-10-19
last_modified_at: 2026-10-27T14:18:03+05:30
author: Alok Ranjan Daftuar
description: "A running instance that answers a health check has proven almost nothing. This post covers a bottom-up validation framework for Azure-to-AWS migrations — OS and boot, storage, network, application, data, performance, and security — with scripts you can run inside the rollback window."
excerpt: "A running instance that answers a health check has proven almost nothing. Validation means showing the migrated server behaves like the source did, against criteria you wrote down before cutover — and recording a pass or fail while the rollback window is still open."
keywords: "post-migration validation, Azure to AWS, MGN, EBS, cloud migration testing, migration runbook, IMDSv2, CloudWatch agent, migration cutover"
twitter_card: "summary_large_image"
categories:
  - cloud
  - migration
tags: [aws-mgn, validation, post-migration, azure-to-aws, ebs, observability, aws, migration, cloud-native]
series: "AWS Migration Playbook"
series_order: 6
---

## Table of Contents

- [Capture the baseline before cutover, or you have nothing to compare to](#capture-the-baseline-before-cutover-or-you-have-nothing-to-compare-to)
- [Validate in layers, bottom up](#validate-in-layers-bottom-up)
- [Layer 1 and 2: OS, boot, and storage](#layer-1-and-2-os-boot-and-storage)
- [Layer 3: network and DNS](#layer-3-network-and-dns)
- [Layer 4 and 5: application and data](#layer-4-and-5-application-and-data)
- [Layer 6: performance against the baseline](#layer-6-performance-against-the-baseline)
- [Layer 7: security and operations](#layer-7-security-and-operations)
- [Triaging a failed check](#triaging-a-failed-check)
- [Recording the result](#recording-the-result)
- [Close out the cost side](#close-out-the-cost-side)

The most common way a migration gets declared done too early is the sentence "it's up and the app responds." That tells you the instance booted and one endpoint returned a 200. It doesn't tell you that the disk layout survived, that the clock is correct, that the memory metrics you alert on exist, or that the volume under your database can sustain the IOPS the old disk could. Those failures show up days later, usually under load, usually after the Azure source has been deleted.

This article is about closing that gap. It follows [MGN Cutover Strategies](/blogs/mgn-cutover-strategies-rollback-planning/), which ended with the rule that you don't finalize a cutover until your rollback window closes. Validation is what happens inside that window. Its job is to turn "it seems fine" into a recorded pass or fail, early enough that a fail still has a way back. It also leans on the earlier pieces in this series: the [kernel fix](/blogs/aws-migration-ubuntu-kernel-fix/) and the [CIDR planning](/blogs/aws-migration-cidr-planning/) work each produce things worth verifying here.

## Capture the baseline before cutover, or you have nothing to compare to

Validation is a comparison, and a comparison needs two sides. The step that gets skipped most often is recording what "normal" looked like on the source *before* it was frozen. Once the Azure VM is powered off, reconstructing its typical CPU, memory, and disk behaviour means digging through monitoring history that may have a short retention period or different granularity.

A lightweight baseline captured on the source during the week before cutover is enough:

```bash
#!/bin/bash
# capture-baseline.sh — run on the source server during normal business load
OUT="baseline-$(hostname)-$(date +%F).txt"
{
  echo "== uptime/load ==";        uptime
  echo "== memory ==";             free -m
  echo "== disk usage ==";         df -hT
  echo "== block devices ==";      lsblk -f
  echo "== disk io (5s x3) ==";    iostat -x 5 3
  echo "== listening ports ==";    ss -tlnp
  echo "== kernel ==";             uname -r
  echo "== mounts (fstab) ==";     cat /etc/fstab
  echo "== time sync ==";          timedatectl
} > "$OUT" 2>&1
echo "Baseline written to $OUT"
```

Two parts of this output matter later. The listening ports give you the list of services that must exist on the target, and the `fstab` and `lsblk` output tell you what storage layout the application expects. Keep these files with the migration runbook, not on the source VM that's about to be retired.

## Validate in layers, bottom up

Failures in a migrated server stack on top of each other, and a failure low in the stack makes everything above it confusing. A bottom-up order avoids chasing an application symptom that is really a storage or network problem.

| Layer | What you're proving | Typical failure |
| --- | --- | --- |
| OS and boot | Right kernel, clean boot, no leftover cloud agents | Azure agent still running, wrong kernel |
| Storage | Disks and mounts match what the app expects | Stale `fstab` entries, device naming changes |
| Network and DNS | Reachability and name resolution both ways | Missing DNS forwarding, wrong security group |
| Application | Service up, dependencies reachable | Hardcoded Azure IPs, missing env config |
| Data | Contents match the source at the freeze point | Writes after the freeze, partial application state |
| Performance | Equal or better than baseline | Under-provisioned EBS, wrong instance size |
| Security and operations | Hardened and observable | Public IMDS v1, no memory metrics, no backups |

## Layer 1 and 2: OS, boot, and storage

This is where the Azure-to-AWS differences concentrate. The kernel work from earlier articles should already be done, but validation confirms it, and the instance also has storage and agent leftovers from its Azure life.

```bash
#!/bin/bash
# validate-os.sh — run on the migrated instance
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }

check "running an AWS or generic kernel (not -azure)" '! uname -r | grep -q azure'
check "ena module loaded"                              'lsmod | grep -q "^ena"'
check "walinuxagent not active"                        '! systemctl is-active --quiet walinuxagent'
check "no unmounted fstab entries failing"             'findmnt --verify --verbose >/dev/null 2>&1'
check "no /dev/sdX device names in fstab"              '! grep -E "^/dev/sd" /etc/fstab'
check "cloud-init not pinned to Azure datasource"      '! grep -rqs "datasource_list.*Azure" /etc/cloud/'
check "SSM agent running"                              'systemctl is-active --quiet amazon-ssm-agent || snap list amazon-ssm-agent >/dev/null 2>&1'

exit $fail
```

A few of these deserve explanation, because they are cases where the failure is quiet:

- **Device names change.** Azure and AWS expose disks differently, and on Nitro instances EBS volumes appear as NVMe devices. An `fstab` entry that references `/dev/sdc1` can point at nothing or at the wrong disk. Entries should reference filesystem UUIDs, and `findmnt --verify` catches inconsistencies without a reboot.
- **Azure's temporary disk.** Servers that came from Azure often have an `fstab` line for the Azure resource disk, typically mounted at `/mnt`. That disk doesn't exist on AWS. The line usually carries `nofail`, so it doesn't block boot, but it's stale configuration that should be removed rather than left to confuse the next person.
- **Time synchronisation.** Check that the clock is correct and syncing from a source that's reachable on AWS. The Amazon Time Sync Service is available at `169.254.169.123`, and a clock drifting after migration causes certificate, Kerberos, and log-correlation problems that look unrelated.

```bash
timedatectl timesync-status 2>/dev/null || chronyc tracking
```

## Layer 3: network and DNS

Network validation should test both directions and test it from the instance itself, not from your laptop. The CIDR planning article flagged DNS forwarding between environments as a thing that fails quietly, so this is where you confirm it.

```bash
# Names the app depends on, resolved from the migrated instance
for name in db.internal.example.com api.partner.example.com; do
  if getent hosts "$name" >/dev/null; then echo "PASS: resolves $name"
  else echo "FAIL: cannot resolve $name"; fi
done

# Reachability of each dependency on its real port
check_port() { timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null \
  && echo "PASS: $1:$2 reachable" || echo "FAIL: $1:$2 unreachable"; }
check_port 10.0.64.12 5432     # data tier
check_port 10.30.0.10 443      # service still on Azure
```

The list of dependencies comes straight from the baseline. The listening ports you captured on the source tell you what *inbound* must work. The application's configuration tells you what *outbound* must work. For anything still running on Azure during a phased migration, the second `check_port` above exercises the cross-cloud path end to end, including routing and security groups on both sides.

## Layer 4 and 5: application and data

Application validation is workload-specific, so I won't pretend a generic script covers it. What generalises is the structure: a smoke test that exercises the *real* request path rather than a bare health endpoint, and an explicit data comparison against the retained source.

```bash
#!/bin/bash
# smoke-test.sh — exercise a real transaction path, not just /health
BASE="https://app.internal.example.com"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
[[ "$code" == "200" ]] && echo "PASS: health" || echo "FAIL: health ($code)"

# A read that touches the database
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/orders?limit=1")
[[ "$code" == "200" ]] && echo "PASS: db-backed read" || echo "FAIL: db-backed read ($code)"
```

A health endpoint that returns 200 without touching the database will happily pass while the database connection is broken, which is why the second request matters.

For data integrity, the useful trick is that MGN replicates blocks, so at the freeze point the disk contents match by construction. The real risks are writes that happened after the freeze and application state that lives outside the replicated disks. Compare the things that would reveal either:

```sql
-- Run on source (retained, read-only) and on target; compare outputs
SELECT 'orders' AS tbl, COUNT(*) AS n, MAX(updated_at) AS last_write FROM orders
UNION ALL
SELECT 'customers', COUNT(*), MAX(updated_at) FROM customers;
```

Row counts and the latest write timestamp per table are cheap and catch the common problems: a write that landed on the wrong side of the freeze, or a table that didn't come across as expected. For file-based workloads, a file count and a `find ... | sort | sha256sum` over a directory listing does the same job.

## Layer 6: performance against the baseline

This is the layer teams skip and regret. Block-level replication copies the data, but it doesn't guarantee the target storage performs like the source. Volume type, provisioned IOPS and throughput, and instance size all affect the result, and the defaults chosen at launch may not match what the source disk delivered.

```bash
# Inspect the volumes under the migrated instance
aws ec2 describe-volumes \
  --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" \
  --query 'Volumes[].{Id:VolumeId, Type:VolumeType, SizeGiB:Size, Iops:Iops, Throughput:Throughput, Encrypted:Encrypted}' \
  --output table
```

Compare the volume type and IOPS against what the baseline `iostat` showed the source actually using. A database that peaked at several thousand IOPS on Azure and now sits on a small general-purpose volume will look fine at idle and degrade under real load. If the volume needs changing, EBS lets you modify type, size, and performance on a live volume, so this is usually a correction rather than a rebuild.

Memory and disk-space metrics are also a common gap: EC2 doesn't publish them by default. If your alerting on the source relied on them, the CloudWatch agent has to be installed and configured on the target, or those alerts silently stop firing.

## Layer 7: security and operations

A migrated server inherits the Azure server's configuration, not AWS best practice, so a short security and operations pass is worth doing while you're already validating.

```bash
# IMDSv2 required? (v1 allows simple SSRF-style credential theft)
aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[].Instances[].MetadataOptions.HttpTokens' --output text

# If it returns "optional", require tokens:
aws ec2 modify-instance-metadata-options \
  --instance-id "$INSTANCE_ID" --http-tokens required --http-endpoint enabled
```

Before enforcing IMDSv2 on a workload, confirm that nothing on it still uses the older metadata calls, since enforcing it will break those. Beyond that, the checklist is short:

- Volumes are encrypted (the `Encrypted` column in the earlier output).
- Security groups follow the tier plan, with no stray `0.0.0.0/0` ingress carried over from a permissive Azure NSG.
- The instance has an IAM role with only what it needs, rather than long-lived keys copied over.
- Backups exist: the instance is covered by a backup plan, ideally through tags so new instances inherit it.
- Alarms and logging are in place, and the instance is tagged for cost allocation and ownership.

## Triaging a failed check

Not every failure means roll back. Deciding which kind you have, quickly, is part of the job, and it's much easier to decide against criteria agreed before the window than in the moment.

- **Fix in place.** Configuration problems on the target: a stale `fstab` line, a missing security group rule, a DNS forwarding gap, an under-provisioned volume. These are corrected on the instance, then the relevant check is re-run. Most findings fall here.
- **Accept with an owner.** Genuinely minor deviations, such as a missing tag or a metric that will be wired up next sprint. Write the exception down with a name and a date, so "accepted" doesn't quietly become "forgotten".
- **Roll back.** Data that doesn't match the source, a dependency that can't be reached in a way you can't fix inside the window, or performance that's materially worse than baseline with no quick correction. This is the case the retained Azure source and the unfinalized cutover exist for.

The discipline is to re-run the *whole* relevant layer after any fix, not just the single failing check. A change to storage or networking can disturb checks that previously passed, and a partial re-run is how a regression gets signed off.

## Recording the result

Validation that isn't recorded can't support a decision. The output of the scripts above, saved per server, is the evidence for the go or no-go on finalizing:

```bash
mkdir -p validation-evidence
{ ./validate-os.sh; ./smoke-test.sh; } 2>&1 | tee "validation-evidence/$(hostname)-$(date +%F).log"
```

The sign-off rule I use is simple. A server is eligible to finalize only when every layer has a recorded pass, any accepted exception is written down with an owner, and the rollback window has closed. A failure inside the window is cheap, because the source still exists. A failure discovered after finalize and after the Azure VM is deleted isn't.

## Close out the cost side

Validation ends with cleanup, because the staging infrastructure described in the MGN architecture article keeps billing until you act. Once a server passes and the rollback window closes:

1. Finalize the cutover, then archive the source server in MGN so replication resources are released.
2. Confirm the replication servers and staging volumes are actually gone, not just detached from the console view.
3. Delete the retained Azure VM and disks on the date you committed to when you set the retention period.
4. Restore any DNS TTLs you lowered for cutover.

> 📌 **Key Takeaway**: "It boots and responds" is not validation. Capture a baseline from the source before cutover, then validate the migrated server bottom-up (OS and boot, storage, network and DNS, application, data, performance, security) and record a pass or fail for each. Run it all inside the rollback window, where a failure still has a way back, and let that recorded evidence, not a feeling, decide when to finalize and delete the source.
