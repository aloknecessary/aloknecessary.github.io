---
title: "CIDR Planning for Azure-to-AWS Migrations: Reconciling Two Address Spaces That Were Never Designed Together"
published: false
description: CIDR planning for an Azure-to-AWS migration is a reconciliation problem — the Azure address space is a fixed constraint that must be fully audited before the AWS target range is chosen.
tags: aws, azure, networking, migration
canonical_url: https://aloknecessary.in/blogs/aws-migration-cidr-planning/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-migration-cidr-planning
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of two cloud network address spaces being reconciled — overlapping CIDR blocks represented as glowing geometric grids on opposite sides, with a central arbitration layer resolving conflicts into clean, non-overlapping routing paths. Subtle Azure blue on one side, AWS orange on the other, merging into a unified network topology. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, amber, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

CIDR planning for a migration is not the same exercise as CIDR planning for a greenfield VPC. In a greenfield environment you pick a clean `/16`, carve it into tiers, and you're done. In a migration, the target VPC has to coexist with — and eventually replace — a source Azure VNet that was sized and addressed by someone solving a completely different problem, possibly years earlier. The Azure side's CIDR is a fixed constraint, not a design choice. Everything downstream depends on knowing it accurately before a single AWS resource is provisioned.

This post is part of the AWS Migration Playbook series. It picks up a thread left open in the MGN architecture article — the staging subnet's positioning relative to the rest of the target VPC — and connects it to the broader CIDR reconciliation problem that trips up nearly every real migration at some point.

---

## Audit the Azure Side First

The most common cause of migration CIDR problems is starting the AWS-side design before fully knowing the Azure-side address space. Run this across every VNet in scope — not just the one hosting the current wave's servers:

```bash
az network vnet list --query '[].{Name:name, CIDR:addressSpace.addressPrefixes}' -o table
az network vnet subnet list --vnet-name <vnet-name> --resource-group <rg-name> \
  --query '[].{Name:name, CIDR:addressPrefix}' -o table
```

If the organization has grown through acquisition or multiple teams provisioning Azure independently, don't assume VNet CIDRs were coordinated centrally. A VNet audited late — after the target VPC's early tiers are already locked in — might turn out to need a range that only fits in whatever's left over.

## Why Overlap Matters Even Without Hybrid Connectivity

The "we're leaving Azure behind anyway" assumption holds right up until one of these scenarios appears — and they appear in nearly every real migration:

- **Rollback plans** that require the Azure source and AWS target to be reachable from each other during a validation window, via VPN or equivalent — unusable if CIDRs overlap, full stop.
- **Phased migrations** where some services remain on Azure while others move to AWS, and the two environments need to communicate during the transition.
- **Future merges** with another AWS Organization or cloud footprint that happens to use the same range — unlikely to be on anyone's mind during the current migration, but a recurring cause of expensive re-IP projects years later.

Treat overlap avoidance as a hard requirement for every migration, not just ones with a known hybrid connectivity need at planning time.

## Building the Reconciliation Table

Once every Azure VNet's CIDR is documented, build an explicit table of every range in use across both clouds:

| Environment | CIDR | Status |
| --- | --- | --- |
| Azure VNet: prod-eastus | 10.20.0.0/16 | Source, in use |
| Azure VNet: dev-eastus | 10.21.0.0/16 | Source, in use |
| Azure VNet: shared-services | 10.30.0.0/16 | Source, staying on Azure |
| AWS VPC: migration-target (proposed) | 10.0.0.0/16 | Proposed — needs validation |

The proposed AWS range only gets marked valid once it's confirmed non-overlapping against every row — including VNets that aren't being migrated but will remain on Azure indefinitely. A range colliding with a permanently-staying VNet is just as blocking as one colliding with a VNet you're actively migrating away from.

## The MGN Staging Subnet Deserves Its Own Allocation

The staging subnet MGN uses to receive replicated data should be a deliberate, separate row in the tier table — not squeezed into whatever subnet has spare capacity:

```text
10.0.0.0/16   vpc-migration-target
├── 10.0.0.0/24      public
├── 10.0.16.0/20     private/app
├── 10.0.64.0/24     data
├── 10.0.100.0/24    mgn-staging          ← new, migration-specific
```

Two reasons this matters: staging infrastructure is **temporary** — present only for active migration waves and safe to fully decommission after cutover. Mixing it into a permanent tier makes cleanup harder to reason about. And a dedicated subnet makes it trivial to apply a tightly scoped security group and NACL specific to replication traffic, rather than inheriting the public tier's broader ruleset.

A `/24` (251 usable addresses) comfortably supports a wave of dozens of concurrent source servers. For unusually large waves, size explicitly against planned concurrent server count rather than assuming `/24` is always sufficient.

## Reserve Headroom for Later Waves

For multi-wave migrations, the target VPC needs headroom for VNets that haven't been audited yet at the time the first wave's CIDR plan is locked in:

```text
10.0.0.0/16   vpc-migration-target
├── 10.0.0.0/24      public                    (wave 1)
├── 10.0.16.0/20     private/app — wave 1
├── 10.0.64.0/24     data — wave 1
├── 10.0.100.0/24    mgn-staging
├── 10.0.128.0/18    RESERVED — wave 2 (finance VNet, not yet audited)
├── 10.0.192.0/18    RESERVED — future waves
```

Reserve entire unused CIDR ranges, not just gaps between adjacent subnets. "Whatever's left over" is a much worse position to negotiate from than reserving room deliberately from the start.

## DNS Coexistence During the Transition Window

CIDR reconciliation solves whether IP ranges can coexist — it doesn't solve whether names resolve correctly across both environments. For phased migrations where wave-one AWS services need to be reachable by private DNS name from wave-two Azure services, you need deliberate DNS forwarding:

- Azure Private DNS zones need conditional forwarding rules pointing at a resolver reachable in the AWS VPC (Route 53 Resolver inbound endpoint or the VPC's `.2` resolver address)
- The reverse direction needs equivalent configuration on the AWS side

Skipping this doesn't fail loudly — it fails as intermittent-looking connectivity issues that look like application bugs rather than a missing DNS forwarding rule.

## Validate Before the First Server Replicates

Before starting MGN replication for a wave's first server, validate empirically:

```bash
# From an Azure VM — confirm no undocumented overlap or peering
ip route show | grep -E "10\.(0|20|21|30)\."

# From AWS — confirm staging subnet CIDR matches the plan
aws ec2 describe-subnets --filters "Name=tag:Name,Values=mgn-staging" \
  --query 'Subnets[*].{Subnet:SubnetId, CIDR:CidrBlock}' --output table
```

This catches two recurring classes of mistake cheaply: a route on the Azure side hinting at a connection the audit missed, and a staging subnet provisioned with a different CIDR than the plan called for — easy to happen when a subnet is created manually or from a stale template.

---

## Read the Full Article

The full post covers additional depth on:

- The complete pre-wave CIDR checklist — five explicit gates to confirm before locking in a target VPC CIDR for any new wave
- Tier-to-tier mapping between Azure VNet subnets and AWS VPC tiers, including the `AzureBastionSubnet` decision
- How this connects to the kernel fix and serial console recovery incidents from earlier in the series — the same "should have caught this before the maintenance window" cost pattern
- Why the overlap problem compounds specifically in phased migrations vs. lift-and-shift

**👉 [CIDR Planning for Azure-to-AWS Migrations — Full Article](https://aloknecessary.in/blogs/aws-migration-cidr-planning/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-migration-cidr-planning)**
