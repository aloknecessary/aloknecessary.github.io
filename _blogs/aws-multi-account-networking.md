---
title: "Multi-Account AWS Networking: Shared VPC, RAM, and the Hub-and-Spoke Model"
date: 2026-09-02
last_modified_at: 2026-09-08T14:45:13+05:30
author: Alok Ranjan Daftuar
description: "Two models for multi-account AWS networking — Shared VPC and centralized Transit Gateway — answer the ownership question differently. This post maps the trade-offs, the failure modes, and when each model earns its complexity."
excerpt: "Once an AWS Organization crosses a handful of accounts, the question stops being how to connect VPCs and becomes who owns the network at all. Shared VPC and centralized Transit Gateway answer that differently, and the choice compounds."
keywords: "aws multi-account networking, shared vpc, resource access manager, transit gateway, hub-and-spoke, aws organizations, ram sharing, vpc segmentation"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [multi-account, shared-vpc, aws-organizations, resource-access-manager, transit-gateway, hub-and-spoke, vpc, cidr, dns, aws-ram]
series: "AWS Network Architecture"
series_order: 4
---

> The [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/) article in this series covered how Transit Gateway shares across accounts through AWS Resource Access Manager, and treated that as a routing detail — one line, one RAM share, done. It undersold the decision. Once an AWS Organization has more than a handful of accounts, multi-account networking stops being a routing question and becomes an ownership question: who controls the VPC, who controls the route tables, and who's accountable when something in the shared network breaks. Two genuinely different models answer that question differently, and picking the wrong one early is expensive to unwind later.

## Why multi-account exists before we get to networking

AWS Organizations best practice is one account per environment, per team, or per workload boundary — not because it's fashionable, but because account boundaries are the strongest isolation AWS offers: separate IAM root, separate service limits, separate blast radius for a compromised credential or a misconfigured policy. A migration wave, in particular, often lands in its own account specifically so a mistake during cutover can't touch anything else in the Organization.

The cost of that isolation is that networking, which used to be "one VPC, one team, done," now has to span account boundaries deliberately. Two models exist for this, and they trade ownership for flexibility in opposite directions.

## Model 1: Shared VPC

Shared VPC uses AWS Resource Access Manager to let one account (typically a central network account) own a VPC and its subnets, and share specific subnets with other accounts in the Organization. Those other accounts can then launch resources — EC2 instances, RDS databases, Lambda functions in VPC mode — directly into the shared subnets, as if the subnet were their own, without ever creating a VPC of their own.

```hcl
# In the network account
resource "aws_vpc" "shared" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "vpc-shared-central" }
}

resource "aws_subnet" "shared_app_a" {
  vpc_id            = aws_vpc.shared.id
  cidr_block        = "10.0.16.0/20"
  availability_zone = "ap-south-1a"
  tags              = { Name = "subnet-shared-app-az-a" }
}

resource "aws_ram_resource_share" "vpc_share" {
  name                      = "ram-shared-vpc-subnets"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "app_subnet" {
  resource_arn       = aws_subnet.shared_app_a.arn
  resource_share_arn = aws_ram_resource_share.vpc_share.arn
}

resource "aws_ram_principal_association" "app_account" {
  principal          = "222233334444"  # spoke account ID
  resource_share_arn = aws_ram_resource_share.vpc_share.arn
}
```

Once shared, an engineer in account `222233334444` sees `subnet-shared-app-az-a` as a launch target in their own console, in their own account, and can run `terraform apply` against it using their own account's credentials — no cross-account role assumption needed just to launch an instance into the subnet.

### What stays centralized, and what doesn't

The network account retains ownership of the VPC itself, its route tables, its NACLs, its Internet Gateway, its NAT gateways, and its VPC endpoints — spoke accounts cannot modify any of these, only launch resources into the subnets they've been given. Security groups are the one significant exception: **each account creates and manages its own security groups** for the resources it launches, even though those resources live in a shared subnet owned by a different account. This split — centralized routing and NACLs, decentralized security groups — is the detail that defines how Shared VPC actually feels operationally: the network team owns "can traffic reach this subnet at all," and application teams own "can this specific instance be reached," without either team needing write access to the other's layer.

### Where this model earns its complexity

Shared VPC is the right choice when accounts genuinely need to behave as if they're in the same network — low-latency communication between services in different accounts, shared load balancers, a common data tier that multiple application accounts need direct, low-friction access to. It avoids Transit Gateway's per-attachment cost and the additional routing hop entirely, since everything sharing the VPC is, from a networking perspective, already in the same VPC. For a platform team supporting many small application teams that all need to sit close to shared infrastructure, this is often the lower-friction and lower-cost option.

### Where it breaks down

Shared VPC has a hard ceiling that Transit Gateway doesn't: everything sharing the VPC shares the same CIDR space, the same route tables, and the same blast radius for anything that touches the VPC's core networking. A misconfigured NACL in the network account affects every spoke account simultaneously. There's no natural segmentation boundary between spoke accounts the way Transit Gateway's route table association provides — two spoke accounts sharing the same VPC can, by default, reach each other's resources over the VPC's local route, unless security groups are deliberately scoped to prevent it. For an Organization where spoke accounts represent genuinely separate trust boundaries — different customers in a multi-tenant setup, or environments that should never talk to each other by default — Shared VPC requires compensating security group discipline that Transit Gateway's route table segmentation gives you more naturally.

## Model 2: Centralized Transit Gateway (hub-and-spoke)

The alternative — the one referenced briefly in the peering/TGW article — is each account owning its own full VPC, with a central network account owning a Transit Gateway that every other account's VPC attaches to via RAM sharing.

```hcl
# In the network account
resource "aws_ec2_transit_gateway" "central" {
  description = "tgw-org-central"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
}

resource "aws_ram_resource_share" "tgw_share" {
  name                      = "ram-tgw-central"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "tgw" {
  resource_arn       = aws_ec2_transit_gateway.central.arn
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}

resource "aws_ram_principal_association" "org_share" {
  principal          = data.aws_organizations_organization.this.arn
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}
```

Sharing to the whole Organization ARN (`data.aws_organizations_organization.this.arn`) rather than individual account IDs is worth calling out specifically — it means any new account added to the Organization automatically has the option to attach to the Transit Gateway without a manual RAM association step per new account, which matters a lot for an Organization that's still adding accounts regularly rather than one with a fixed, known set.

In each spoke account, independently:

```hcl
resource "aws_ec2_transit_gateway_vpc_attachment" "spoke" {
  subnet_ids         = [aws_subnet.app_private_a.id, aws_subnet.app_private_b.id]
  transit_gateway_id = "tgw-0abc123central"  # shared TGW ID
  vpc_id              = aws_vpc.spoke.id
}
```

Each spoke account owns its entire VPC — its own CIDR, its own route tables, its own security groups, its own NACLs — and only cedes control of the single attachment connecting it to the shared Transit Gateway. This is a meaningfully different ownership split from Shared VPC: here, the network team's authority is limited to the Transit Gateway's own route tables (deciding which attachments can reach which), while everything inside each spoke VPC remains fully owned by that account's team.

### Segmentation as the actual selling point

The Transit Gateway route table association model, covered in the peering/TGW article, is what makes this genuinely stronger for multi-tenant or multi-trust-boundary Organizations. A production route table, a non-production route table, and a shared-services route table can each control a completely different set of reachable attachments, and a spoke account has no ability to affect that segmentation from its side — it can only attach, not choose what it's allowed to reach. This is the property Shared VPC can't cleanly replicate without compensating security group work, and it's the main reason a security-conscious multi-account Organization tends to converge on this model over Shared VPC as account count grows.

### The cost this model carries

Every spoke VPC is a full VPC — its own CIDR allocation (which needs the non-overlapping planning discussed in the fundamentals article, now multiplied across every account), its own NAT gateway if it needs internet egress, its own set of VPC endpoints if it wants to avoid NAT for AWS service traffic. This is real, multiplied infrastructure cost and real, multiplied operational surface compared to Shared VPC's single centrally-managed VPC. For an Organization with many small, low-traffic accounts, this can mean provisioning NAT gateways and endpoint fleets far larger in aggregate than a single shared VPC's equivalent infrastructure would have cost.

## A hybrid pattern worth knowing: shared services via Transit Gateway, not Shared VPC subnets

A pattern that gets the best of both without fully committing to either: keep each application account on its own full VPC connected via Transit Gateway (avoiding Shared VPC's blast-radius problem), but put genuinely shared infrastructure — a central logging aggregator, a shared Active Directory-equivalent, an internal artifact registry — in its own dedicated VPC that's also attached to the same Transit Gateway, reachable by every spoke account through the hub. This avoids putting shared infrastructure inside any single application account's VPC (which would create an ownership ambiguity — whose account is that in, and who's accountable for it) while still giving every spoke low-friction access to it through normal Transit Gateway routing, gated by the same route table segmentation used for everything else.

## Choosing between the two, restated as one comparison

| | Shared VPC | Centralized Transit Gateway |
| --- | --- | --- |
| VPC ownership | One VPC, centrally owned | Each account owns its own VPC |
| Route table control | Centralized only | Centralized (TGW) + per-account (spoke VPC) |
| Segmentation between accounts | Requires security group discipline | Native, via TGW route table association |
| CIDR planning | One VPC's CIDR to manage | Every spoke VPC needs non-overlapping CIDR |
| Cost | Lower — one NAT/endpoint fleet | Higher — NAT/endpoints multiplied per spoke |
| Best fit | Many small teams needing close, low-friction shared infrastructure access | Organizations needing strong trust-boundary segmentation between accounts |

## DNS across account boundaries

Both models inherit the same DNS caveat covered in the peering/TGW article: routing connectivity doesn't automatically mean private DNS resolution works across accounts, and it's worth planning explicitly rather than discovering the gap mid-migration.

For Shared VPC, this is largely a non-issue — since spoke accounts are launching into subnets of the *same* VPC, standard VPC DNS resolution (the `.2` resolver address, or Route 53 Resolver if customized) already covers everything in the shared VPC uniformly, regardless of which account launched a given resource.

For centralized Transit Gateway, each spoke account has its own VPC and, by default, its own DNS resolution scope. Cross-account private hosted zone resolution needs to be built deliberately — either through Route 53 Private Hosted Zone **association** across accounts (each spoke account's VPC explicitly associated with the shared services account's private hosted zone, which requires an authorization step from the zone-owning account) or through a centralized Route 53 Resolver with inbound/outbound endpoints in the shared services VPC, referenced by resolver rules in every spoke account. This is genuinely one of the more fiddly parts of the hub-and-spoke model to get right, and it's substantial enough that it's worth treating as its own planning task during initial Organization network design, not an afterthought added once the first cross-account DNS resolution failure shows up in production.

## Troubleshooting: where multi-account networking actually breaks

A short list of failure modes specific to the multi-account layer, on top of the standard route-table/security-group/NACL checklist from the peering/TGW article:

- **RAM share exists but the principal association is missing or not yet accepted.** A resource share can be created and the resource associated with it, but if the target account (or the Organization) isn't correctly associated as a principal, or hasn't accepted the share where acceptance is required, the resource simply doesn't appear as available in the spoke account — with no error, just an absence.
- **Service Control Policies blocking cross-account resource use**, independent of RAM sharing being correctly configured. An SCP restricting which resource ARNs an account can act on can block a spoke account from launching into a shared subnet or attaching to a shared Transit Gateway even though RAM has granted the share — this produces an IAM-flavored access denied error rather than a networking error, and it's easy to spend time debugging the network layer when the actual block is a policy layer above it.
- **CIDR overlap discovered only at Transit Gateway attachment time**, in the centralized TGW model specifically — two spoke accounts provisioned independently, without a shared CIDR allocation registry, can end up with overlapping ranges that only become a visible problem when both try to attach to the same Transit Gateway and their routes conflict. This is the strongest practical argument for a centrally-tracked CIDR allocation plan across the whole Organization from the start, rather than letting each account team pick their own range independently.

## What this means for a migration-in-progress Organization

For the Azure-to-AWS migration work this series' companion Migration Playbook series is documenting, the account structure decided before the first MGN wave lands has direct consequences here: migrating into a single shared account versus migrating each application into its own dedicated account determines which of these two models is even on the table later. A single migration-destination account with everything landing in one VPC defers this decision, but it's worth deciding deliberately during migration planning rather than accumulating workloads in one account and facing a much larger re-architecture later to split them apart across the account and networking boundary this article describes.

> 📌 **Key Takeaway**: Shared VPC centralizes ownership of the network itself and lets spoke accounts launch directly into shared subnets — lower cost, lower friction, weaker isolation between spoke accounts. Centralized Transit Gateway gives every account its own full VPC and connects them through a shared hub with genuine route-table-level segmentation — higher cost, more operational surface, but the model that scales cleanly as trust boundaries between accounts get stricter. Neither is strictly better; the choice should follow from how much isolation the accounts in your Organization actually need from each other, not from which one is simpler to set up first.
