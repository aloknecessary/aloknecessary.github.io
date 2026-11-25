---
title: "IPv6 in AWS: Dual-Stack VPCs, Egress-Only Gateways, and What Doesn't Carry Over from IPv4"
date: 2026-11-26
last_modified_at: 2026-11-24T11:17:10+05:30
author: Alok Ranjan Daftuar
description: "IPv6 in a VPC isn't IPv4 with longer addresses â€” there's no NAT, no private range by default, and exposure is purely a question of routes and filters. This post covers dual-stack addressing, egress-only gateways, filtering for both address families, and a rollout order that limits risk."
excerpt: "IPv6 in a VPC isn't IPv4 with longer addresses. There's no NAT, no private range by default, and no public-IP switch to flip. Exposure becomes purely a question of routes and filters, which is a better model, and an unforgiving one if you carry IPv4 habits across."
keywords: "ipv6 aws, dual-stack vpc, egress-only internet gateway, nat64, dns64, ipv6 security groups, ipv4 costs aws, vpc ipv6 terraform"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [ipv6, dual-stack, egress-only-internet-gateway, nat64, vpc, ipv4-costs]
series: "AWS Network Architecture"
series_order: 9
---

Most teams meet IPv6 as a checkbox: "enable IPv6" on the VPC, and expect everything else to behave as before. It doesn't, and the differences are exactly the ones this series has been building toward. Almost every concept covered in earlier articles has an IPv6 counterpart that works differently, or doesn't exist.

This article closes the AWS Network Architecture series. It revisits the main pieces from [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/) through the IPv6 lens: addressing, internet access, filtering, routing across VPCs, DNS, and load balancers. It also gives the practical reasons to bother, one of which is a line item on the bill.

## Why bother

Two reasons carry most of the weight in practice.

**Cost.** AWS charges an hourly fee for every public IPv4 address, whether it's attached to an instance or sitting idle. That makes public IPv4 a recurring cost that scales with the number of internet-facing resources. IPv6 addresses carry no such charge. For internet-facing fleets, and for the NAT gateways that private workloads use for outbound traffic (which the [VPC endpoints](/blogs/aws-vpc-endpoints-gateway-vs-interface/) article flagged as a cost trap), an IPv6 path can remove a meaningful amount of spend.

**Scale and simplicity.** IPv4 private space is finite and overlapping ranges cause real pain, as the peering and Transit Gateway article described. Amazon-provided IPv6 addresses are globally unique, so overlap between VPCs isn't a problem and address exhaustion in a subnet stops being a planning concern, which matters for IP-hungry workloads like EKS pods.

## How addressing works

A VPC can be assigned an Amazon-provided IPv6 CIDR block of size `/56`, and each subnet takes a `/64` from it. The sizes are fixed, which removes the host-count arithmetic from the fundamentals article: a `/64` is vastly larger than any subnet needs, so IPv6 subnet planning is about hierarchy and labelling, not capacity.

Amazon-provided addresses are globally routable public addresses. There's no built-in "private IPv6" the way `10.0.0.0/8` is private IPv4. Newer IPAM features can allocate private IPv6 ranges, but the default posture matters: an instance with an IPv6 address has an address the internet can route to, and nothing about the address itself keeps it private.

```hcl
resource "aws_vpc" "main" {
  cidr_block                       = "10.0.0.0/16"
  assign_generated_ipv6_cidr_block = true
  enable_dns_support               = true
  enable_dns_hostnames             = true
}

resource "aws_subnet" "private_a" {
  vpc_id                          = aws_vpc.main.id
  availability_zone               = "ap-south-1a"
  cidr_block                      = "10.0.16.0/20"
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 16)
  assign_ipv6_address_on_creation = true
}
```

`cidrsubnet(<VPC /56>, 8, 16)` carves the sixteenth `/64` out of the VPC's `/56`. Giving subnet numbers meaning, as the allocation table in the fundamentals article did for IPv4, works the same way here.

Check what a subnet actually received:

```bash
aws ec2 describe-subnets \
  --query 'Subnets[].{Id:SubnetId,V4:CidrBlock,V6:Ipv6CidrBlockAssociationSet[].Ipv6CidrBlock}' \
  --output json
```

## Dual-stack and IPv6-only

A **dual-stack** subnet gives instances both an IPv4 and an IPv6 address, which is the sensible default for a migration: nothing that depends on IPv4 breaks, and IPv6-capable clients can use the new path.

An **IPv6-only** subnet has no IPv4 CIDR at all. It requires Nitro-based instances, and it raises an obvious question: what about destinations that only speak IPv4? AWS answers with **DNS64 and NAT64**. With DNS64 enabled on the subnet, the resolver synthesises an IPv6 address for an IPv4-only destination inside the well-known prefix `64:ff9b::/96`, and a NAT gateway translates that traffic to IPv4 on the way out.

```hcl
resource "aws_subnet" "v6only_a" {
  vpc_id                                         = aws_vpc.main.id
  availability_zone                              = "ap-south-1a"
  ipv6_native                                    = true
  ipv6_cidr_block                                = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 32)
  assign_ipv6_address_on_creation                = true
  enable_dns64                                   = true
  enable_resource_name_dns_aaaa_record_on_launch = true
}

resource "aws_route" "v6only_nat64" {
  route_table_id              = aws_route_table.v6only.id
  destination_ipv6_cidr_block = "64:ff9b::/96"
  nat_gateway_id              = aws_nat_gateway.a.id
}
```

IPv6-only is attractive for large container fleets, but it's a later step. Dual-stack first, IPv6-only once you've inventoried what still needs IPv4.

## Internet access: no NAT, and no public-IP switch

This is the biggest conceptual change from the fundamentals article, which gave three conditions that must all hold for an instance to be reachable from the internet. The first was that the instance has a public or Elastic IP. **For IPv6, that condition disappears.** Every IPv6 address is already public, so reachability depends on only the other two: a route to an internet gateway and permissive security group and NACL rules.

For a public subnet, that's a `::/0` route to the same Internet Gateway used for IPv4 (the IGW handles both address families; there's no translation for IPv6):

```hcl
resource "aws_route" "public_v6" {
  route_table_id              = aws_route_table.public.id
  destination_ipv6_cidr_block = "::/0"
  gateway_id                  = aws_internet_gateway.main.id
}
```

### The egress-only internet gateway

A private subnet in IPv4 reaches the internet through a NAT gateway. IPv6 has no NAT in that role, and wouldn't want one: the whole point is end-to-end addressing. What private workloads need instead is **outbound-only** access, where they can initiate connections but the internet can't initiate them inward. That's the **egress-only internet gateway (EIGW)**:

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

The EIGW is stateful: replies to outbound connections come back, but unsolicited inbound connections are dropped. Unlike a NAT gateway, it has no per-hour or per-GB processing fee of its own (standard data transfer still applies, so confirm against the current pricing page). It's also not tied to an Availability Zone the way a NAT gateway is, which removes the one-per-AZ high-availability decision from the NAT gateway article.

The crucial discipline is the difference between the two `::/0` targets. A private subnet routed to the **IGW** instead of the **EIGW** isn't private: its instances become reachable from the internet if filters allow it. The route table, not the subnet's name, decides, which is the same lesson as the fundamentals article, with higher stakes.

## Filtering: separate rules for separate families

Security groups and NACLs treat IPv4 and IPv6 as distinct. A rule for `0.0.0.0/0` does not cover `::/0`, and the reverse. Teams enabling IPv6 on a VPC with existing security groups commonly hit one of two surprises: IPv6 traffic that's unexpectedly blocked because only IPv4 rules exist, or, worse, a rule that was meant to be restrictive but wasn't mirrored.

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

The patterns from the [security group and NACL article](/blogs/aws-security-group-nacl-design-patterns-at-scale/) carry over, and one of them matters more here: referencing security groups instead of CIDRs sidesteps the problem for intra-VPC traffic, since a group reference covers whichever address family the members use.

For NACLs, a custom ACL denies everything until allowed, and that includes IPv6. Rules for the two families are written separately:

```hcl
resource "aws_network_acl_rule" "app_in_v6" {
  network_acl_id  = aws_network_acl.app.id
  rule_number     = 110
  egress          = false
  protocol        = "tcp"
  rule_action     = "allow"
  ipv6_cidr_block = "::/0"
  from_port       = 443
  to_port         = 443
}
```

Remember the stateless return-traffic rules for ephemeral ports in the IPv6 direction too. And because every instance's address is public, reviewing filters before enabling IPv6 on existing subnets is a security task, not a formality.

## Routing across VPCs and to on-premises

IPv6 support spreads across the connectivity pieces from earlier in the series, but it's not automatic in any of them.

- **VPC peering and Transit Gateway:** both can route IPv6, but the routes have to be added for the IPv6 CIDRs explicitly. On a Transit Gateway, the VPC attachment needs IPv6 support enabled:

```hcl
resource "aws_ec2_transit_gateway_vpc_attachment" "spoke" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id
  vpc_id             = aws_vpc.spoke.id
  subnet_ids         = [aws_subnet.spoke_a.id, aws_subnet.spoke_b.id]
  ipv6_support       = "enable"
}
```

- **Site-to-Site VPN and Direct Connect:** IPv6 traffic can be carried over the hybrid links covered in the [VPN and Direct Connect article](/blogs/site-to-site-vpn-vs-direct-connect-hybrid-connectivity/), with BGP exchanging IPv6 prefixes. Support depends on the termination point and configuration, so check requirements for your setup before assuming it.
- **Multi-account:** the central-network-account model from the [multi-account article](/blogs/aws-multi-account-networking/) is unchanged. The `allowed_prefixes` and route-table associations just need IPv6 entries alongside the IPv4 ones.

A useful side effect for hybrid and migration planning: because Amazon-provided IPv6 ranges are globally unique, the CIDR-overlap check that dominates migration network design simply doesn't apply to the IPv6 side.

## DNS and load balancers

IPv6 reaches clients through **AAAA records**. Route 53 handles them like any other record, and the resolver behaviour from the [DNS article](/blogs/aws-route53-dns-resolution/) applies. A load balancer fronting an IPv6-capable service is a dual-stack load balancer, with an alias AAAA record next to the existing A record:

```hcl
resource "aws_lb" "app" {
  name               = "alb-app"
  load_balancer_type = "application"
  ip_address_type    = "dualstack"
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_route53_record" "app_aaaa" {
  zone_id = aws_route53_zone.public.zone_id
  name    = "app.example.com"
  type    = "AAAA"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
```

The load balancer article's layer distinction still holds: an ALB terminates the connection and can talk to targets over a different address family than the one the client used, so you can accept IPv6 at the edge and keep IPv4 targets behind it. That makes the load balancer the natural place to start, enabling IPv6 for clients without touching the application tier. Check current support for IPv6 targets and for load balancer address-type variants that drop public IPv4 entirely, since those options have been evolving.

## What doesn't carry over: application and tooling checks

IPv6 rollouts commonly stall in the application layer rather than the network:

- Code that parses addresses with IPv4-only assumptions, such as regular expressions, fixed-width fields, or database columns sized for dotted-quad strings.
- Allowlists and rate limiters keyed on IPv4 addresses, which silently fail to match IPv6 clients.
- Servers bound only to `0.0.0.0`. Binding to `::` generally accepts both families on Linux.
- Hardcoded IPv4 literals, including the instance metadata address. EC2 offers an IPv6 metadata endpoint that has to be enabled on the instance.
- Third-party services and AWS services that don't offer IPv6 endpoints yet. Support varies by service, including for VPC endpoints, so verify per service before depending on it.

## A rollout order that limits risk

1. Add an IPv6 CIDR to the VPC and `/64`s to the subnets. No behaviour changes yet.
2. Review security groups and NACLs for the IPv6 implications, since addresses will be public.
3. Add `::/0` routes: to the IGW for public subnets, to an EIGW for private ones.
4. Enable dual-stack on the load balancer and add AAAA records.
5. Verify from inside and outside the VPC, then watch flow logs for unexpected IPv6 traffic.
6. Only then consider IPv6-only subnets with DNS64 and NAT64 for workloads that no longer need IPv4.

```bash
# From a dual-stack instance
ip -6 addr show scope global
ip -6 route show default
curl -6 -sS https://ipv6.icanhazip.com
```

## Where the series ends up

Across nine articles, a few ideas recur. Routing and filtering are separate layers, and each one needs deliberate design. Connectivity and name resolution are separate problems. Centralizing ownership scales better than letting each team build its own. IPv6 sharpens all of these: with no NAT and no private-by-default range, there's nowhere to hide a sloppy route table or a permissive security group, which is why it's worth treating as a design exercise rather than a toggle.

> 📌 **Key Takeaways**
>
> 1. **VPC fundamentals:** a subnet is public or private because of its route table, not its name, and every connectivity or security question starts from that. See [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/).
> 2. **Inter-VPC connectivity:** peering is non-transitive and suits two or three VPCs; Transit Gateway scales to hub-and-spoke with route-table segmentation. See [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/).
> 3. **Endpoints:** Gateway endpoints for S3 and DynamoDB are free and nearly always worth enabling; Interface endpoints deserve usage-based evaluation. See [VPC Endpoints](/blogs/aws-vpc-endpoints-gateway-vs-interface/).
> 4. **Multi-account:** Shared VPC and a centralized Transit Gateway trade cost and friction against isolation; choose by how strict your trust boundaries are. See [Multi-Account Networking](/blogs/aws-multi-account-networking/).
> 5. **DNS:** name resolution scope is its own design decision; routing never provides it. See [DNS in AWS](/blogs/aws-route53-dns-resolution/).
> 6. **Load balancers:** pick by the layer your traffic needs inspected, not by feature list. See [Load Balancer Internals](/blogs/aws-load-balancer-internals-alb-nlb-gwlb/).
> 7. **Hybrid connectivity:** VPN and Direct Connect differ in kind, and Direct Connect with a tested VPN backup is the common production shape. See [Site-to-Site VPN vs Direct Connect](/blogs/site-to-site-vpn-vs-direct-connect-hybrid-connectivity/).
> 8. **Filtering:** let security groups carry the policy, expressed as group references, and use NACLs sparingly for explicit denies. See [Security Groups and NACLs at Scale](/blogs/aws-security-group-nacl-design-patterns-at-scale/).
> 9. **IPv6:** every address is public, so exposure is purely routes plus filters; use an egress-only gateway for private outbound access, write rules for both address families, and roll out dual-stack before considering IPv6-only.
