---
layout: blog
title: "VPC Peering vs Transit Gateway: Choosing the Right AWS Inter-VPC Connectivity Model"
date: 2026-08-18
last_modified_at: 2026-08-21T12:12:58+05:30
author: Alok Ranjan Daftuar
description: "A practical guide to choosing between VPC Peering and Transit Gateway — covering topology shape, the N(N-1)/2 scaling problem, route table segmentation, multi-account patterns, DNS, and a migration path from peering to TGW."
excerpt: "VPC peering and Transit Gateway solve the same problem — connecting VPCs — but scale, cost, and operational complexity in opposite directions. Here's how to choose correctly the first time."
keywords: "vpc peering, transit gateway, aws networking, inter-vpc connectivity, multi-account aws, route table segmentation, aws ram, transit gateway peering, terraform, dns resolution, security groups, cloud networking"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [vpc-peering, transit-gateway, networking, multi-account, routing, aws, terraform, dns, security-groups, aws-ram]
series: "AWS Network Architecture"
series_order: 2
---

The default assumption most teams start with is that VPC peering is the "simple" option and Transit Gateway is the "enterprise" option you graduate into once you're big enough to need it. That framing is wrong often enough to cause real architectural pain. The actual decision isn't about company size — it's about topology shape, and getting it backwards means either overpaying for capability you don't need or hitting a hard wall of unsupported routing a year into production.

This article assumes the VPC fundamentals covered in [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/) — CIDR allocation, route tables, and how a route table target decides traffic flow. Peering and Transit Gateway are both, at their core, just additional route table targets. The complexity is in what each target is actually capable of routing.

## The topology test that actually matters

Before comparing features, answer one question: does your connectivity requirement look like a **mesh** or a **hub-and-spoke**?

- Two or three VPCs that need to talk directly to each other, with no plans to add more → mesh, and peering is often the right call.
- Any number of VPCs beyond four or five, especially across multiple accounts, especially with a shared services VPC everything needs to reach → hub-and-spoke, and Transit Gateway is very likely correct from day one.

This test alone resolves most of the debate. The rest of this article explains why.

## VPC Peering: what it actually does

A peering connection is a direct, non-transitive network link between exactly two VPCs. "Non-transitive" is the single most important word in that sentence, and it's the source of nearly every peering-related production surprise.

```text
VPC-A <---peering---> VPC-B <---peering---> VPC-C
```

In this diagram, A cannot reach C through B, even though both connections exist. Each peering connection is its own isolated path. If A needs to reach C, you need a *third*, direct peering connection between A and C — there is no routing-through.

### The math that kills peering at scale

For N VPCs in a full mesh, the number of peering connections required is:

```text
connections = N * (N - 1) / 2
```

| VPCs | Peering connections required |
| --- | --- |
| 3 | 3 |
| 5 | 10 |
| 10 | 45 |
| 20 | 190 |

At 10 VPCs you're already managing 45 separate connections, each with its own route table entries on both sides, its own security group considerations, and its own entry in every account's route table if you're spanning multiple AWS accounts. This is the practical ceiling — not a hard AWS limit, but an operational one. Teams that push past this size on pure peering end up with route tables nobody fully understands and no single source of truth for "can VPC-X reach VPC-Y."

### Setting up a peering connection

```hcl
resource "aws_vpc_peering_connection" "app_to_shared" {
  vpc_id      = aws_vpc.app.id
  peer_vpc_id = aws_vpc.shared_services.id
  auto_accept = true

  tags = {
    Name = "pcx-app-to-shared-services"
  }
}

resource "aws_route" "app_to_shared" {
  route_table_id            = aws_route_table.app_private.id
  destination_cidr_block    = aws_vpc.shared_services.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.app_to_shared.id
}

resource "aws_route" "shared_to_app" {
  route_table_id            = aws_route_table.shared_private.id
  destination_cidr_block    = aws_vpc.app.cidr_block
  vpc_peering_connection_id = aws_vpc_peering_connection.app_to_shared.id
}
```

Notice both directions need an explicit route — peering doesn't propagate routes automatically the way Transit Gateway route tables can. Every new VPC added to a peered mesh means touching route tables on every existing member that needs to reach it.

### Where peering is genuinely the right answer

Peering has no hourly charge and no per-GB data processing fee — you pay standard cross-AZ or cross-region data transfer rates, nothing more. For a stable two- or three-VPC relationship — a production VPC and a shared services VPC, for example, or a one-time connection to a partner's VPC for a specific integration — peering is simpler to reason about and cheaper to run than Transit Gateway. Don't over-engineer a two-VPC problem with a hub-and-spoke solution.

## Transit Gateway: what it actually does

Transit Gateway is a managed, regional routing hub. Every VPC (and VPN, and Direct Connect connection) attaches to it once, and the Transit Gateway's own route tables decide what can reach what. Critically, **Transit Gateway routing is transitive** — the exact property peering lacks.

```text
              Transit Gateway
             /      |        \
       VPC-A      VPC-B      VPC-C
```

A can reach C through the Transit Gateway without any direct connection to C, as long as the Transit Gateway's route tables permit it. Adding a fourth VPC means one new attachment, not three new peering connections.

### Attachment count instead of connection count

For N VPCs connected via Transit Gateway, you need exactly N attachments, not N(N-1)/2 connections:

| VPCs | TGW attachments required |
| --- | --- |
| 3 | 3 |
| 5 | 5 |
| 10 | 10 |
| 20 | 20 |

This is the whole argument for Transit Gateway at scale, expressed as one comparison against the peering table above.

### Setting up a Transit Gateway with segmented routing

```hcl
resource "aws_ec2_transit_gateway" "main" {
  description                    = "tgw-central-networking"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"

  tags = {
    Name = "tgw-central-networking"
  }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "app" {
  subnet_ids         = [aws_subnet.app_private_a.id, aws_subnet.app_private_b.id]
  transit_gateway_id = aws_ec2_transit_gateway.main.id
  vpc_id              = aws_vpc.app.id

  tags = {
    Name = "tgw-attach-app"
  }
}

resource "aws_ec2_transit_gateway_route_table" "app_rt" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name = "tgw-rt-app-segment"
  }
}

resource "aws_ec2_transit_gateway_route_table_association" "app" {
  transit_gateway_attachment_id = aws_ec2_transit_gateway_vpc_attachment.app.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.app_rt.id
}
```

The `default_route_table_association = "disable"` and `default_route_table_propagation = "disable"` pair is deliberate, not boilerplate — it's what enables **route table segmentation**, covered next, instead of every attachment automatically seeing every other attachment.

### Route table segmentation: the feature peering can't replicate

A single Transit Gateway can have multiple route tables, and each attachment associates with one. This lets you build actual network segmentation — a production segment that can reach shared services but not a sandbox segment, for instance — entirely through Transit Gateway route table membership, without touching security groups or NACLs.

```text
TGW Route Table: "production"
├── app-vpc attachment    (associated)
├── shared-vpc attachment (associated, propagated)
└── sandbox-vpc attachment (NOT associated — isolated by design)

TGW Route Table: "sandbox"
├── sandbox-vpc attachment (associated)
└── shared-vpc attachment  (associated, propagated — sandbox can still reach shared)
```

This is the pattern most multi-account AWS Organizations setups converge on: one Transit Gateway per region, a small number of route tables representing trust boundaries (production, non-production, shared services, on-prem), and VPCs associated into the appropriate table rather than managed through dozens of individual peering decisions.

### What Transit Gateway costs that peering doesn't

Transit Gateway bills per attachment-hour and per GB processed through it, in addition to standard data transfer. For a handful of VPCs this is a modest, predictable cost. It's worth pricing out explicitly before committing, especially for the many-attachments, high-throughput case — the operational simplicity is real, but it isn't free the way peering's routing is.

## Multi-account and multi-region considerations

### Cross-account peering

Peering works across accounts — the `peer_owner_id` argument targets a VPC in another account — but the N(N-1)/2 problem gets worse in a multi-account AWS Organization, because now you're also managing acceptance workflows and cross-account IAM permissions for every connection, not just route entries.

### Cross-account Transit Gateway via RAM

Transit Gateway solves the multi-account case more cleanly through AWS Resource Access Manager: one account owns the Transit Gateway, shares it via RAM to other accounts in the Organization, and those accounts create their own attachments against the shared resource. This is the standard pattern for a centralized network account model — the network team owns the Transit Gateway and its route tables; application teams in spoke accounts just attach their VPCs.

```hcl
resource "aws_ram_resource_share" "tgw_share" {
  name                      = "tgw-network-share"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "tgw" {
  resource_arn       = aws_ec2_transit_gateway.main.arn
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}

resource "aws_ram_principal_association" "spoke_account" {
  principal          = "222233334444"  # spoke account ID
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}
```

### Cross-region

VPC peering supports inter-region connections directly. Transit Gateway requires **Transit Gateway peering** between two regional Transit Gateways to achieve the same thing — an extra layer, but one that preserves the route table segmentation model across regions rather than flattening it.

## DNS resolution across the connection

Connectivity at the routing layer doesn't automatically mean private DNS names resolve across it — this is a separate setting people forget on both peering and Transit Gateway, and the failure mode looks identical to a routing problem even though it isn't one.

For peering, DNS resolution support has to be enabled explicitly on both sides of the connection:

```hcl
resource "aws_vpc_peering_connection_options" "app_to_shared" {
  vpc_peering_connection_id = aws_vpc_peering_connection.app_to_shared.id

  accepter {
    allow_remote_vpc_dns_resolution = true
  }

  requester {
    allow_remote_vpc_dns_resolution = true
  }
}
```

Without this, an instance in VPC-A resolving VPC-B's private hosted zone record gets back the public IP (if one exists) instead of the private one, or fails to resolve entirely for records with no public counterpart — the peering connection itself is working correctly, so this is easy to misdiagnose as a routing fault when it's actually a DNS setting.

Transit Gateway doesn't have an equivalent single toggle — DNS resolution across attached VPCs depends on how private hosted zones are associated. The standard pattern for a hub-and-spoke setup is a **Route 53 Resolver** deployed in a shared services VPC, with inbound and outbound resolver endpoints, and each spoke VPC's DHCP option set or resolver rules pointing at it. This is deliberately out of scope for this article — it's substantial enough to warrant its own piece later in this series — but it's worth flagging now: if you're designing Transit Gateway connectivity for a multi-account setup, plan the DNS resolution strategy at the same time as the routing strategy, not after. Retrofitting DNS resolution onto an already-built hub-and-spoke network is a second migration project layered on top of the first.

## Security group referencing across the connection

A detail that catches people who are used to referencing security groups by ID within a single VPC: **you cannot reference a security group ID across a peering connection** in the same way. If an instance in VPC-A needs to allow inbound traffic only from instances in a specific security group in VPC-B, that cross-VPC SG reference is only supported for VPCs in the same account and same region under specific conditions — most cross-account or cross-region peered setups fall back to allowing by CIDR block instead, which is coarser than SG-to-SG referencing and worth being explicit about in your security review.

Transit Gateway doesn't change this constraint — security groups remain instance/ENI-scoped and don't become "aware" of the Transit Gateway topology. Whatever hub-and-spoke shape your routing takes, security group rules still need to be designed per VPC, typically by CIDR range per segment (production CIDR range, shared-services CIDR range) rather than by cross-VPC SG reference, unless you're within the same-account/same-region case where SG referencing is supported.

## Troubleshooting: where connectivity actually breaks

When "VPC-A can't reach VPC-B" comes in as a ticket, the check order that resolves it fastest, in priority order:

1. **Route table on both sides** — peering and Transit Gateway both require the route to exist in *both* directions. A route added only on VPC-A's side explains asymmetric connectivity (A can initiate, B can't) far more often than people expect.
2. **Peering connection or TGW attachment state** — `pending-acceptance` on peering, or an attachment stuck in a non-`available` state, blocks everything downstream regardless of how correct the route tables are.
3. **Security group and NACL on both ends** — same as any other AWS networking failure, evaluated independently of whether the path is direct (peering) or hub-routed (Transit Gateway).
4. **DNS resolution settings**, if the failure is name resolution rather than connectivity — covered above, and easy to mistake for a routing failure.
5. **TGW route table association**, specifically for Transit Gateway — an attachment that exists but isn't associated with the route table you expect will silently fail to route, with no error at the attachment level.

Checking in this order — route tables, then attachment/connection state, then security layers, then DNS — resolves the large majority of "these are definitely connected but nothing works" tickets without needing to reason about the full topology from scratch each time.

## A side-by-side summary

| | VPC Peering | Transit Gateway |
| --- | --- | --- |
| Routing | Non-transitive, point-to-point | Transitive, hub-and-spoke |
| Connections for N VPCs | N(N-1)/2 | N |
| Route propagation | Manual, per connection | Automatic via TGW route tables |
| Segmentation | None built-in — separate connections only | Native, via route table association |
| Cost | Data transfer only | Attachment-hour + data processing + transfer |
| Cross-account | Supported, manual acceptance | Supported, cleaner via RAM sharing |
| Cross-region | Native | Requires TGW peering |
| Best fit | 2-3 stable VPC relationships | 4+ VPCs, multi-account, evolving topology |

## Migration path: peering to Transit Gateway

If you started with peering and outgrew it, the migration doesn't require ripping out connectivity all at once. Attach the existing VPCs to a new Transit Gateway, update route tables to point at the Transit Gateway attachment for the CIDRs that should now traverse it, and decommission the old peering connections once the new routes are validated and traffic has shifted. Running both in parallel briefly, with the more specific route (typically the still-present peering route) taking precedence until you're ready to cut over, is the safer sequencing — remember from the fundamentals article that AWS route tables always resolve to the most specific matching route, which makes a controlled, non-disruptive cutover possible rather than an all-or-nothing switch.

## The decision, restated simply

Count the VPCs you need connected today, and count them again for eighteen months from now. If that number stays at two or three with no multi-account sprawl on the horizon, peering is simpler, cheaper, and entirely sufficient — resist the urge to add Transit Gateway complexity preemptively. If the number is already past four, spans multiple accounts, or the topology is going to keep growing as new teams and environments come online, build on Transit Gateway from the start. Retrofitting segmentation and transitive routing onto an existing peering mesh is a much larger project than provisioning it correctly the first time.
