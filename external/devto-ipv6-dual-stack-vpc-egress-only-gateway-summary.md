---
title: "IPv6 in AWS: Dual-Stack VPCs, Egress-Only Gateways, and What Doesn't Carry Over from IPv4"
published: false
description: IPv6 in a VPC isn't IPv4 with longer addresses — no NAT, no private range by default, and exposure is purely routes and filters.
tags: aws, ipv6, networking, terraform
canonical_url: https://aloknecessary.in/blogs/ipv6-dual-stack-vpc-egress-only-gateway/
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a dual-stack network — two parallel streams of glowing packets flow through a VPC diagram, one labeled with short dotted-quad addresses and one with long hexadecimal IPv6 strings, converging at a gateway node. An egress-only arrow points outward while an inbound arrow is blocked. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Most teams meet IPv6 as a checkbox: enable it on the VPC and expect everything else to behave as before. It doesn't. Almost every concept from the AWS Network Architecture series has an IPv6 counterpart that works differently — or doesn't exist at all.

This post closes the series. It revisits addressing, internet access, filtering, cross-VPC routing, DNS, and load balancers through the IPv6 lens, and gives the practical reasons to bother — one of which is a line item on the bill.

---

## Why Bother

Two reasons carry most of the weight.

**Cost.** AWS charges an hourly fee for every public IPv4 address, whether attached or idle. IPv6 addresses carry no such charge. For internet-facing fleets and the NAT gateways private workloads use for outbound traffic, an IPv6 path can remove meaningful spend.

**Scale and simplicity.** Amazon-provided IPv6 addresses are globally unique, so CIDR overlap between VPCs isn't a problem and address exhaustion in a subnet stops being a planning concern — a `/64` is vastly larger than any subnet needs.

## How Addressing Works

A VPC gets a `/56` IPv6 CIDR block; each subnet takes a `/64`. The sizes are fixed, which removes host-count arithmetic from subnet planning entirely.

Amazon-provided addresses are globally routable public addresses. There is no built-in "private IPv6" the way `10.0.0.0/8` is private IPv4. An instance with an IPv6 address has an address the internet can route to — nothing about the address itself keeps it private.

```hcl
resource "aws_vpc" "main" {
  cidr_block                       = "10.0.0.0/16"
  assign_generated_ipv6_cidr_block = true
}

resource "aws_subnet" "private_a" {
  vpc_id                          = aws_vpc.main.id
  cidr_block                      = "10.0.16.0/20"
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 16)
  assign_ipv6_address_on_creation = true
}
```

## The Egress-Only Internet Gateway

This is the biggest conceptual change from IPv4. A private subnet reaches the internet through a NAT gateway in IPv4. IPv6 has no NAT in that role — the whole point is end-to-end addressing. What private workloads need instead is outbound-only access: they can initiate connections but the internet can't initiate them inward. That's the **egress-only internet gateway (EIGW)**:

```hcl
resource "aws_egress_only_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route" "private_v6" {
  route_table_id              = aws_route_table.private.id
  destination_ipv6_cidr_block = "::/0"
  egress_only_gateway_id      = aws_egress_only_internet_gateway.main.id
}
```

The EIGW is stateful — replies to outbound connections come back, but unsolicited inbound connections are dropped. Unlike a NAT gateway, it has no per-hour or per-GB processing fee of its own, and it's not tied to an Availability Zone.

The crucial discipline: a private subnet routed to the **IGW** instead of the **EIGW** isn't private. The route table decides, not the subnet's name.

## Filtering: Separate Rules for Separate Families

A security group rule for `0.0.0.0/0` does not cover `::/0`. Teams enabling IPv6 on a VPC with existing security groups commonly hit one of two surprises: IPv6 traffic unexpectedly blocked because only IPv4 rules exist, or a rule that was meant to be restrictive but wasn't mirrored.

```hcl
resource "aws_vpc_security_group_ingress_rule" "alb_https_v4" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_v6" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
```

Referencing security groups instead of CIDRs sidesteps the problem for intra-VPC traffic — a group reference covers whichever address family the members use.

## Dual-Stack vs IPv6-Only

A **dual-stack** subnet gives instances both addresses — the sensible default for migration. An **IPv6-only** subnet has no IPv4 CIDR at all. For IPv4-only destinations, AWS answers with **DNS64 and NAT64**: the resolver synthesises an IPv6 address inside `64:ff9b::/96`, and a NAT gateway translates that traffic to IPv4 on the way out.

IPv6-only is attractive for large container fleets, but dual-stack first — IPv6-only once you've inventoried what still needs IPv4.

## A Rollout Order That Limits Risk

1. Add an IPv6 CIDR to the VPC and `/64`s to subnets — no behaviour changes yet
2. Review security groups and NACLs for IPv6 implications before any routes go in
3. Add `::/0` routes: IGW for public subnets, EIGW for private ones
4. Enable dual-stack on the load balancer and add AAAA records
5. Verify from inside and outside the VPC, watch flow logs for unexpected IPv6 traffic
6. Only then consider IPv6-only subnets with DNS64/NAT64

## What Doesn't Carry Over

IPv6 rollouts commonly stall in the application layer: IPv4-only address parsing, allowlists keyed on IPv4, servers bound to `0.0.0.0` instead of `::`, hardcoded IPv4 literals, and third-party services that don't offer IPv6 endpoints yet. The network can be ready while the application isn't.

---

## Read the Full Article

The full post covers:

- Complete Terraform for dual-stack and IPv6-only subnets including DNS64/NAT64 wiring
- Transit Gateway IPv6 attachment configuration
- NACL rules for both address families including ephemeral port return traffic
- Dual-stack ALB with Route 53 AAAA alias records
- Series recap: key takeaways from all nine AWS Network Architecture posts
- The security implications of every address being publicly routable by default

**👉 [IPv6 in AWS: Dual-Stack VPCs, Egress-Only Gateways, and What Doesn't Carry Over from IPv4 — Full Article](https://aloknecessary.in/blogs/ipv6-dual-stack-vpc-egress-only-gateway/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=ipv6-dual-stack-vpc-egress-only-gateway)**
