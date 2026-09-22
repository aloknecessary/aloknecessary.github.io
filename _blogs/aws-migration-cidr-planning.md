---
title: "CIDR Planning for Azure-to-AWS Migrations: Reconciling Two Address Spaces That Were Never Designed Together"
date: 2026-09-22
last_modified_at: 2026-09-22T10:51:06+05:30
author: Alok Ranjan Daftuar
description: "CIDR planning for an Azure-to-AWS migration is a reconciliation problem, not a fresh design exercise — the Azure address space is a fixed constraint that must be fully audited before the AWS target range is chosen."
excerpt: "The VPC you provision for a migration target isn't a fresh design exercise — it's a negotiation with whatever CIDR decisions were made on the Azure side, years ago, by people not thinking about AWS at all."
keywords: "cidr planning, azure to aws migration, vpc cidr, vnet overlap, mgn staging subnet, aws migration playbook, network planning"
twitter_card: "summary_large_image"
categories:
  - cloud
  - migration
tags: [cidr, vnet, vpc, mgn, azure-to-aws, network-planning]
series: "AWS Migration Playbook"
series_order: 4
---

The assumption that trips up CIDR planning for a migration specifically — as opposed to CIDR planning for a brand-new AWS environment — is treating it as the same exercise described in the AWS Network Architecture series' [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/) article: pick a clean `/16`, carve it into tiers, done. That approach works perfectly for a greenfield VPC with no constraints. It falls apart the moment the target VPC has to coexist with, route to, or eventually replace a source Azure VNet that was sized and addressed by someone solving a completely different problem, possibly years earlier. Migration CIDR planning isn't a design exercise — it's a reconciliation exercise, and treating it as the former is how teams end up with an unusable overlap discovered mid-migration wave rather than during planning.

This article assumes the MGN mechanics from [MGN Architecture and Continuous Replication](/blogs/aws-mgn-architecture-continuous-replication/) and picks up a thread deliberately left open in that article: the staging subnet's positioning relative to the rest of the target VPC. It also connects back to the two-part kernel incident covered in [the kernel fix](/blogs/aws-migration-ubuntu-kernel-fix/) and [serial console recovery](/blogs/azure-serial-console-boot-loop-recovery/) articles — a wrong CIDR decision doesn't cause a boot loop, but it does compound the same kind of "should have caught this before the maintenance window" cost that incident represents.

## Step one: audit the Azure side before touching AWS at all

The single most common cause of migration CIDR problems is starting the AWS-side design before fully knowing the Azure-side address space. It's tempting to skip this because the AWS VPC feels like "the new thing" and therefore the thing that deserves the planning attention — but the Azure VNet's existing CIDR is a fixed constraint, not a design choice, and everything downstream depends on knowing it accurately first.

```bash
az network vnet list --query '[].{Name:name, CIDR:addressSpace.addressPrefixes}' -o table
az network vnet subnet list --vnet-name <vnet-name> --resource-group <rg-name> \
  --query '[].{Name:name, CIDR:addressPrefix}' -o table
```

Run this across every VNet in scope for the migration, not just the one hosting the servers in the current wave — a later wave migrating a VNet you didn't audit yet can surface an overlap after the first wave's target VPC CIDR is already locked in, and by then it's a much more expensive problem to fix. If the Organization has grown through acquisition or multiple teams provisioning Azure independently over time, don't assume VNet CIDRs were coordinated centrally — verify, rather than trust that "someone probably planned this."

## The overlap problem, and why it matters even when you're not peering yet

Here's the assumption worth challenging directly: "we're doing a lift-and-shift, not a hybrid setup, so Azure and AWS CIDRs overlapping doesn't matter — we're leaving Azure behind anyway." This holds right up until one of several common scenarios that show up in nearly every real migration, not edge cases:

- **A rollback plan that requires the Azure source and AWS target to be reachable from each other** during a validation window, even briefly, via VPN or ExpressRoute/Direct Connect-equivalent connectivity — which is unusable if the CIDRs overlap, full stop, regardless of how good the routing configuration otherwise is.
- **A phased migration** where some services remain on Azure temporarily while others move to AWS, and the two environments need to communicate during the transition period — the overlap blocks this outright, the same non-negotiable way it blocks VPC peering between two `10.0.0.0/16` VPCs, as covered in the [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/) article.
- **A future acquisition or merge** of the AWS environment with another AWS Organization or another cloud footprint that happens to already use the same range — unlikely to be on anyone's mind during the current migration, but a real, recurring cause of expensive re-IP projects a few years after a migration that didn't account for it.

The practical rule: treat CIDR overlap avoidance as a requirement for every migration, not just ones with a known hybrid connectivity need at planning time. The cost of avoiding overlap up front is choosing a slightly less "clean" CIDR block. The cost of discovering an overlap later is a full re-IP of one entire environment.

## Building the reconciliation table

Once every Azure VNet's CIDR is documented, the next step is building an explicit table — not holding this in your head or scattered across tickets — of every range already in use anywhere in the Organization, across both clouds:

| Environment | CIDR | Status |
| --- | --- | --- |
| Azure VNet: prod-eastus | 10.20.0.0/16 | Source, in use |
| Azure VNet: dev-eastus | 10.21.0.0/16 | Source, in use |
| Azure VNet: shared-services | 10.30.0.0/16 | Source, in use, staying on Azure |
| AWS VPC: migration-target (proposed) | 10.0.0.0/16 | **Proposed — needs validation** |

The proposed AWS range only gets marked valid once it's confirmed non-overlapping against every row already in the table — including, critically, VNets that aren't part of the current migration wave but will remain on Azure indefinitely, like the `shared-services` row above. It's a common mistake to only check against VNets actually being migrated and ignore the ones staying put, but a range colliding with a VNet that's permanently staying on Azure is just as blocking for any future hybrid connectivity need as one colliding with a VNet you're actively migrating away from.

## Mapping tiers, not just totals

Once a non-overlapping AWS range is confirmed, the next reconciliation isn't about totals — it's about whether the Azure VNet's internal subnet structure maps cleanly onto the AWS VPC's tier structure, or whether the migration is an opportunity (or a forced requirement) to restructure it.

A typical Azure VNet subnet layout:

```text
10.20.0.0/16   vnet-prod-eastus
├── 10.20.0.0/24    AzureBastionSubnet
├── 10.20.1.0/24    web-tier
├── 10.20.2.0/24    app-tier
├── 10.20.3.0/24    data-tier
```

Compare this against the AWS target tier structure from the fundamentals article:

```text
10.0.0.0/16   vpc-migration-target
├── 10.0.0.0/24     public (ALB, NAT, bastion equivalent)
├── 10.0.16.0/20     private/app
├── 10.0.64.0/24     data
```

These don't need to map 1:1 in size or numbering — the whole point of choosing a fresh, non-overlapping AWS range is that it doesn't have to inherit Azure's specific numbering scheme. What does need to carry over deliberately is the **tier-to-tier correspondence**: whatever was in Azure's `web-tier` subnet needs a clearly identified destination tier in the AWS VPC, and `AzureBastionSubnet` needs an explicit decision — does it map to the AWS public subnet hosting a bastion host or Session Manager-based access, or is it being retired entirely in favor of AWS-native access patterns? Leaving this mapping implicit is how servers end up migrated into a tier that doesn't match their actual security posture, purely because nobody explicitly decided where they should land.

## Where the MGN staging subnet fits into this plan

This is the thread left open in the MGN architecture article. The staging subnet MGN uses to receive replicated data needs its own CIDR allocation within the target VPC, and it's worth planning as a deliberate, separate row in the tier table rather than an afterthought squeezed into whatever subnet happens to have spare capacity:

```text
10.0.0.0/16   vpc-migration-target
├── 10.0.0.0/24      public
├── 10.0.16.0/20      private/app
├── 10.0.64.0/24      data
├── 10.0.100.0/24     mgn-staging          ← new, migration-specific
```

Two things make this worth its own allocation rather than reusing the public tier: the staging subnet's replication servers and EBS volumes are **temporary infrastructure**, present only for the duration of active migration waves and safe to fully decommission once cutover is complete — mixing them into a permanent tier makes cleanup harder to reason about later, since you'd need to distinguish "permanent public tier resource" from "leftover staging infrastructure from a migration two waves ago" by inspection rather than by which subnet it's in. Second, giving staging its own subnet makes it trivial to apply a tightly scoped security group and NACL specific to replication traffic, rather than inheriting whatever the public tier's broader ruleset allows.

## Sizing the staging subnet correctly

Staging subnet sizing is a different calculation from the app-tier sizing covered in the fundamentals article, because it's driven by **concurrent migration wave size**, not steady-state application load. Each source server being actively replicated needs one staging area server plus its EBS volumes in this subnet; a `/24` (251 usable addresses) comfortably supports a wave of dozens of concurrent source servers, which covers the vast majority of realistic wave sizes — but for an unusually large single wave, size explicitly against planned concurrent server count using the same reverse-engineering formula from the fundamentals article, rather than assuming `/24` is always sufficient.

## Reserving room for phased waves

If the migration is happening in multiple waves rather than one cutover event — the realistic case for anything beyond a handful of servers — the target VPC's tier structure needs headroom for VNets or subnets that haven't been reconciled yet at the time the first wave's CIDR plan is locked in. This is the same "leave gaps between tiers" principle from the fundamentals article, applied specifically to migration planning: reserve entire unused CIDR ranges, not just gaps between adjacent subnets, for VNets belonging to later waves that haven't been fully audited yet.

```text
10.0.0.0/16   vpc-migration-target
├── 10.0.0.0/24      public                    (wave 1)
├── 10.0.16.0/20      private/app — wave 1
├── 10.0.64.0/24      data — wave 1
├── 10.0.100.0/24      mgn-staging
├── 10.0.128.0/18      RESERVED — wave 2 (finance VNet, not yet audited)
├── 10.0.192.0/18      RESERVED — future waves
```

This matters more in migration planning than in greenfield VPC design specifically because later waves carry a real risk the fundamentals article's general advice doesn't fully capture: a VNet audited late, after the target VPC's early tiers are already locked in and servers already migrated into them, might turn out to need a CIDR range that only fits in whatever's left over — and "whatever's left over" is a much worse position to negotiate from than reserving room deliberately from the start.

## DNS coexistence during the transition window

CIDR reconciliation solves whether IP ranges can coexist, but it doesn't solve whether names resolve correctly across both environments during a phased migration — and this is worth planning at the same time, not as a separate later exercise, since the two are tightly coupled in practice. If a service migrated to AWS in wave one needs to be reachable by a private DNS name from services still running on Azure in wave two, that requires deliberate DNS forwarding between the environments — Azure Private DNS zones need conditional forwarding rules pointing at a resolver reachable in the AWS VPC (typically the VPC's `.2` resolver address or a Route 53 Resolver inbound endpoint, the same mechanism referenced in the AWS Network Architecture series' treatment of cross-account DNS), and the reverse direction needs equivalent configuration on the AWS side if AWS-hosted services need to resolve Azure-hosted names.

Skipping this planning step doesn't fail loudly — it fails as intermittent-looking connectivity issues during the transition period that look like application bugs rather than what they actually are, a missing DNS forwarding rule between two environments that were never designed to resolve each other's names. Worth confirming explicitly, wave by wave, which services on each side need to resolve names on the other side, rather than assuming it'll be sorted out organically once both environments exist side by side.

## Validating the plan before the first server replicates

Before starting MGN replication for a wave's first server, validate the CIDR plan empirically rather than just on paper. A quick, cheap check worth running as a gate:

```bash
# From an Azure VM in the source VNet, confirm no accidental route
# already exists suggesting an undocumented overlap or peering
ip route show | grep -E "10\.(0|20|21|30)\."

# From the AWS side, once the staging subnet exists, confirm its
# actual CIDR matches what was planned — catches manual provisioning
# drift from whatever Terraform or CloudFormation intended
aws ec2 describe-subnets --filters "Name=tag:Name,Values=mgn-staging" \
  --query 'Subnets[*].{Subnet:SubnetId, CIDR:CidrBlock}' --output table
```

This isn't a rigorous validation, but it catches two real, recurring classes of mistake cheaply: a route on the Azure side hinting at a connection or overlap the audit missed, and a staging subnet that was actually provisioned with a different CIDR than the plan called for — easy to happen when a subnet is created manually or from a slightly stale template, and much cheaper to catch here than after replication has already started against the wrong address range.

## A pre-wave CIDR checklist

Before locking in the target VPC CIDR for a new migration wave, confirm each of these explicitly rather than assuming a prior wave's validation still covers a new one:

1. Every Azure VNet CIDR in scope for *this specific wave* is documented, including ones staying permanently on Azure that the target might need to reach.
2. The proposed AWS range doesn't overlap any row in the full reconciliation table — not just the VNets in this wave.
3. Each Azure subnet tier in this wave has an explicit, named destination tier in the AWS VPC — no server migrated into an undecided or default tier.
4. The MGN staging subnet has its own dedicated CIDR, sized against this wave's concurrent server count specifically.
5. Headroom is reserved for waves that haven't been audited yet, sized generously rather than tightly, since expanding a reservation later is free and shrinking an already-allocated tier isn't.

> 📌 **Key Takeaway**: CIDR planning for a migration is a reconciliation problem, not a fresh design problem — the Azure side's existing address space is a fixed constraint that has to be fully audited, across every VNet in the Organization, before the AWS target range is chosen. Overlap avoidance is worth treating as a hard requirement even for a migration with no current hybrid connectivity plan, because the cost of discovering an overlap after servers have already moved is a full re-IP, not a planning adjustment.
