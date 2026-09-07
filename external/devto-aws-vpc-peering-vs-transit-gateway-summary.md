---
title: "VPC Peering vs Transit Gateway: Choosing the Right AWS Inter-VPC Connectivity Model"
published: false
description: A practical guide to choosing between VPC Peering and Transit Gateway based on topology shape, scale, and operational complexity — not company size.
tags: aws, networking, terraform, cloud
canonical_url: https://aloknecessary.in/blogs/aws-vpc-peering-vs-transit-gateway/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-peering-vs-transit-gateway
cover_image:
---

The default assumption most teams start with is that VPC peering is the "simple" option and Transit Gateway is the "enterprise" option you graduate into once you're big enough. That framing is wrong often enough to cause real architectural pain. The actual decision isn't about company size — it's about topology shape.

Before comparing features, answer one question: does your connectivity requirement look like a **mesh** or a **hub-and-spoke**? That single test resolves most of the debate.

---

## The math that kills peering at scale

A peering connection is non-transitive — A cannot reach C through B even if both connections exist. For N VPCs in a full mesh, the connections required are `N * (N - 1) / 2`:

| VPCs | Peering connections | TGW attachments |
|---|---|---|
| 3 | 3 | 3 |
| 5 | 10 | 5 |
| 10 | 45 | 10 |
| 20 | 190 | 20 |

At 10 VPCs you're managing 45 separate connections, each with its own route table entries on both sides. Transit Gateway needs exactly N attachments regardless of how many VPCs you have.

---

## Setting up VPC Peering in Terraform

```hcl
resource "aws_vpc_peering_connection" "app_to_shared" {
  vpc_id      = aws_vpc.app.id
  peer_vpc_id = aws_vpc.shared_services.id
  auto_accept = true
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

Both directions need an explicit route — peering doesn't propagate routes automatically. Every new VPC added to a peered mesh means touching route tables on every existing member.

---

## Setting up Transit Gateway with segmented routing

```hcl
resource "aws_ec2_transit_gateway" "main" {
  description                     = "tgw-central-networking"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
}

resource "aws_ec2_transit_gateway_vpc_attachment" "app" {
  subnet_ids         = [aws_subnet.app_private_a.id, aws_subnet.app_private_b.id]
  transit_gateway_id = aws_ec2_transit_gateway.main.id
  vpc_id             = aws_vpc.app.id
}
```

The `disable` pair on both defaults is deliberate — it enables route table segmentation instead of every attachment automatically seeing every other attachment.

---

## Route table segmentation: the feature peering can't replicate

A single Transit Gateway can have multiple route tables. Each attachment associates with one, giving you actual network segmentation without touching security groups or NACLs:

```
TGW Route Table: "production"
├── app-vpc attachment    (associated)
├── shared-vpc attachment (associated, propagated)
└── sandbox-vpc attachment (NOT associated — isolated by design)

TGW Route Table: "sandbox"
├── sandbox-vpc attachment (associated)
└── shared-vpc attachment  (associated, propagated)
```

This is the pattern most multi-account AWS Organizations setups converge on: one Transit Gateway per region, a small number of route tables representing trust boundaries, and VPCs associated into the appropriate table.

---

## Cross-account via AWS RAM

Transit Gateway solves the multi-account case cleanly through Resource Access Manager — one account owns the TGW, shares it via RAM, and spoke accounts create their own attachments:

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
  principal          = "222233334444"
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}
```

Peering works cross-account too, but the N(N-1)/2 problem gets worse because you're also managing acceptance workflows and cross-account IAM permissions for every connection.

---

## DNS and security group gotchas

Routing connectivity doesn't automatically mean DNS works across it. For peering, DNS resolution support must be enabled explicitly on both sides — without it, private hosted zone records resolve to public IPs or fail entirely, which looks identical to a routing problem.

Security group referencing across peering connections is also limited — most cross-account or cross-region setups fall back to CIDR-based rules rather than SG-to-SG references. Transit Gateway doesn't change this constraint.

---

## Troubleshooting in priority order

When "VPC-A can't reach VPC-B" comes in:

1. **Route table on both sides** — both directions need explicit routes
2. **Connection/attachment state** — `pending-acceptance` on peering, non-`available` TGW attachment
3. **Security group and NACL on both ends**
4. **DNS resolution settings** — easy to mistake for a routing failure
5. **TGW route table association** — an attachment not associated with the expected route table silently fails

---

## Read the Full Article

The full post covers everything above in depth, plus:

- The DNS resolution strategy for hub-and-spoke setups using Route 53 Resolver endpoints — why it needs to be planned alongside routing, not retrofitted
- The full side-by-side comparison table across all dimensions (routing model, cost, cross-region, segmentation, best fit)
- The migration path from peering to Transit Gateway — running both in parallel, using most-specific-match routing for a controlled cutover without an all-or-nothing switch
- When peering is genuinely the right answer and why you shouldn't add TGW complexity to a two-VPC problem

**👉 [VPC Peering vs Transit Gateway — Full Article](https://aloknecessary.in/blogs/aws-vpc-peering-vs-transit-gateway/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-peering-vs-transit-gateway)**
