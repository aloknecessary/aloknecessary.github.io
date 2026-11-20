---
title: "Post-Migration Validation: Proving a Migrated Server Is Actually Equivalent"
published: false
description: "It boots and responds" is not validation. Here's a bottom-up framework for proving a migrated Azure-to-AWS server is actually equivalent — with scripts you can run inside the rollback window.
tags: aws, migration, devops, cloud
canonical_url: https://aloknecessary.in/blogs/post-migration-validation-azure-to-aws-workloads/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=post-migration-validation-azure-to-aws-workloads
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a server migration validation process. Two server racks face each other — one faintly labelled with Azure blue tones, the other with AWS amber — connected by a glowing diagnostic pipeline. Layered checkmarks cascade down the pipeline, each representing a validation layer: OS, storage, network, application, data, performance, security. The visual suggests systematic equivalence testing rather than a simple copy. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

The most common way a migration gets declared done too early is the sentence "it's up and the app responds." That tells you the instance booted and one endpoint returned a 200. It doesn't tell you that the disk layout survived, that the clock is correct, that the memory metrics you alert on exist, or that the volume under your database can sustain the IOPS the old disk could. Those failures show up days later, usually under load, usually after the Azure source has been deleted.

This post is about closing that gap. Validation's job is to turn "it seems fine" into a recorded pass or fail, early enough that a fail still has a way back.

---

## Capture the baseline before cutover

Validation is a comparison, and a comparison needs two sides. The step that gets skipped most often is recording what "normal" looked like on the source *before* it was frozen.

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
```

The listening ports give you the list of services that must exist on the target. The `fstab` and `lsblk` output tell you what storage layout the application expects. Keep these files with the migration runbook — not on the source VM that's about to be retired.

---

## Validate in layers, bottom up

Failures in a migrated server stack on top of each other. A bottom-up order avoids chasing an application symptom that is really a storage or network problem.

| Layer | What you're proving | Typical failure |
| --- | --- | --- |
| OS and boot | Right kernel, clean boot, no leftover cloud agents | Azure agent still running, wrong kernel |
| Storage | Disks and mounts match what the app expects | Stale `fstab` entries, device naming changes |
| Network and DNS | Reachability and name resolution both ways | Missing DNS forwarding, wrong security group |
| Application | Service up, dependencies reachable | Hardcoded Azure IPs, missing env config |
| Data | Contents match the source at the freeze point | Writes after the freeze, partial application state |
| Performance | Equal or better than baseline | Under-provisioned EBS, wrong instance size |
| Security and operations | Hardened and observable | Public IMDSv1, no memory metrics, no backups |

---

## Layer 1 and 2: OS, boot, and storage

This is where Azure-to-AWS differences concentrate. The kernel work should already be done, but validation confirms it — and the instance also has storage and agent leftovers from its Azure life.

```bash
#!/bin/bash
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }

check "running an AWS or generic kernel (not -azure)" '! uname -r | grep -q azure'
check "ena module loaded"                              'lsmod | grep -q "^ena"'
check "walinuxagent not active"                        '! systemctl is-active --quiet walinuxagent'
check "no unmounted fstab entries failing"             'findmnt --verify --verbose >/dev/null 2>&1'
check "no /dev/sdX device names in fstab"              '! grep -E "^/dev/sd" /etc/fstab'
check "SSM agent running"                              'systemctl is-active --quiet amazon-ssm-agent'

exit $fail
```

Two quiet failure modes worth calling out: on Nitro instances EBS volumes appear as NVMe devices, so an `fstab` entry referencing `/dev/sdc1` can point at nothing or the wrong disk — entries should reference filesystem UUIDs. Azure's temporary disk often has an `fstab` line for `/mnt` that doesn't exist on AWS; it usually carries `nofail` so it doesn't block boot, but it's stale configuration that should be removed.

---

## Layer 3: network and DNS

Test both directions, from the instance itself. The CIDR planning work flagged DNS forwarding between environments as something that fails quietly — this is where you confirm it.

```bash
for name in db.internal.example.com api.partner.example.com; do
  if getent hosts "$name" >/dev/null; then echo "PASS: resolves $name"
  else echo "FAIL: cannot resolve $name"; fi
done

check_port() { timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null \
  && echo "PASS: $1:$2 reachable" || echo "FAIL: $1:$2 unreachable"; }
check_port 10.0.64.12 5432     # data tier
check_port 10.30.0.10 443      # service still on Azure
```

The list of dependencies comes from the baseline. Listening ports tell you what inbound must work; the application's configuration tells you what outbound must work.

---

## Layer 4 and 5: application and data

A health endpoint that returns 200 without touching the database will happily pass while the database connection is broken. The smoke test should exercise a real request path:

```bash
BASE="https://app.internal.example.com"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
[[ "$code" == "200" ]] && echo "PASS: health" || echo "FAIL: health ($code)"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/orders?limit=1")
[[ "$code" == "200" ]] && echo "PASS: db-backed read" || echo "FAIL: db-backed read ($code)"
```

For data integrity, MGN replicates blocks so at the freeze point disk contents match by construction. The real risks are writes that happened after the freeze and application state outside the replicated disks. Row counts and the latest write timestamp per table are cheap and catch the common problems:

```sql
SELECT 'orders' AS tbl, COUNT(*) AS n, MAX(updated_at) AS last_write FROM orders
UNION ALL
SELECT 'customers', COUNT(*), MAX(updated_at) FROM customers;
```

---

## Layer 6: performance against the baseline

Block-level replication copies the data but doesn't guarantee the target storage performs like the source. Volume type, provisioned IOPS, and instance size all affect the result, and the defaults chosen at launch may not match what the source disk delivered.

```bash
aws ec2 describe-volumes \
  --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" \
  --query 'Volumes[].{Id:VolumeId, Type:VolumeType, SizeGiB:Size, Iops:Iops, Throughput:Throughput, Encrypted:Encrypted}' \
  --output table
```

Compare the volume type and IOPS against what the baseline `iostat` showed the source actually using. A database that peaked at several thousand IOPS on Azure and now sits on a small general-purpose volume will look fine at idle and degrade under real load. EBS lets you modify type, size, and performance on a live volume, so this is usually a correction rather than a rebuild.

Memory and disk-space metrics are also a common gap: EC2 doesn't publish them by default. If your alerting on the source relied on them, the CloudWatch agent has to be installed and configured, or those alerts silently stop firing.

---

## Triaging a failed check

Not every failure means roll back. Three categories:

- **Fix in place** — configuration problems on the target: stale `fstab`, missing security group rule, DNS forwarding gap, under-provisioned volume. Correct it, then re-run the relevant layer.
- **Accept with an owner** — minor deviations like a missing tag or a metric wired up next sprint. Write the exception down with a name and a date.
- **Roll back** — data that doesn't match the source, an unreachable dependency you can't fix inside the window, or performance materially worse than baseline with no quick correction.

The discipline is to re-run the *whole* relevant layer after any fix, not just the single failing check. A change to storage or networking can disturb checks that previously passed.

---

## Read the Full Article

The full post covers:

- The complete seven-layer validation framework with all scripts in runnable form
- The Layer 7 security pass: IMDSv2 enforcement, volume encryption check, IAM role hygiene, and backup coverage
- How to record validation evidence per server and the sign-off rule for finalizing a cutover
- The cost cleanup sequence after a server passes: archiving MGN replication resources, deleting the retained Azure VM, restoring DNS TTLs
- The exact failure modes for each layer and how to distinguish a fix-in-place from a roll-back decision

**👉 [Post-Migration Validation: Proving a Migrated Server Is Actually Equivalent — Full Article](https://aloknecessary.in/blogs/post-migration-validation-azure-to-aws-workloads/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=post-migration-validation-azure-to-aws-workloads)**
