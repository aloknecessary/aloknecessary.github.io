---
title: "AWS VPC Networking Fundamentals: VPCs, Subnets, CIDR, Route Tables, IGW, and NAT Gateways"
published: false
description: A ground-up mental model for AWS VPC networking — how CIDR math, subnet allocation, route tables, internet gateways, and NAT gateways connect into a single coherent system.
tags: aws, networking, vpc, terraform
canonical_url: https://aloknecessary.in/blogs/aws-vpc-networking-fundamentals/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-networking-fundamentals
cover_image:
---

If you've provisioned a VPC from a Terraform module without fully internalising what each piece is doing, that's fine — right up until something breaks. An instance that should be reachable isn't. A private instance can't pull a package update. And you're left checking five different resources with no clear mental model of how they connect.

This post builds that mental model from the ground up. Not just definitions — the *why* behind each piece, so troubleshooting becomes deduction instead of guesswork.

---

## CIDR math you actually need

A CIDR block is `IP address / prefix length`. The prefix length fixes the network portion; the remaining bits are your host space.

Formula: `2^(32 - prefix) = total addresses`. AWS reserves 5 per subnet (network address, VPC router, DNS, reserved, broadcast).

| CIDR | Total addresses | Usable |
| --- | --- | --- |
| /16 | 65,536 | 65,531 |
| /20 | 4,096 | 4,091 |
| /24 | 256 | 251 |
| /28 | 16 | 11 |

To reverse-engineer a prefix from a required host count: round up to the next power of two, subtract the exponent from 32. Need 300 hosts? Next power of two is 512 (2⁹), so prefix = 32 - 9 = `/23`. Run this before sizing any subnet that will host an autoscaling group or EKS node group.

Start with `/16` for the VPC itself. VPC CIDR is difficult to resize after the fact — once you have subnets, peering connections, or Transit Gateway attachments built against it, renumbering becomes a migration project. `/16` costs nothing up front and avoids that corner.

---

## Subnet allocation: carving up the VPC

A practical three-AZ production layout from `10.0.0.0/16`:

| Tier | AZ-a | AZ-b | AZ-c | Size | Typical use |
| --- | --- | --- | --- | --- | --- |
| Public | 10.0.0.0/24 | 10.0.1.0/24 | 10.0.2.0/24 | /24 | ALB, NAT gateway, bastion |
| Private/app | 10.0.16.0/20 | 10.0.32.0/20 | 10.0.48.0/20 | /20 | EKS nodes, ECS, EC2 |
| Data | 10.0.64.0/24 | 10.0.65.0/24 | 10.0.66.0/24 | /24 | RDS, ElastiCache |
| Reserved | 10.0.128.0/17 | | | /17 | Future tiers, Transit Gateway, VPN |

The jump from `/24` in the public tier to `/20` in the app tier is intentional. ALBs and NAT gateways consume very few IPs; the app tier is where consumption scales with autoscaling groups, rolling deployments, and pod density.

For EKS specifically: with the VPC CNI, every pod can consume an ENI-backed IP. IP exhaustion is one of the most common EKS production incidents. `/20` per AZ for worker subnets is the standard starting point.

The deliberate gaps between tiers (0–2, then 16–48, then 64–66) leave room to insert new tiers later without renumbering anything already deployed.

---

## Route tables: the actual decision maker

A subnet is "public" or "private" because of its route table — not any inherent property of the subnet itself. The table is a list of `destination → target` rules evaluated by **most specific match**.

Every route table gets an implicit `local` route for the full VPC CIDR — this can't be removed, and it's what lets every subnet reach every other subnet inside the VPC by default.

A public subnet route table in Terraform:

```hcl
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "rtb-public", Tier = "public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_az_a.id
  route_table_id = aws_route_table.public.id
}
```

Creating the route table does nothing on its own — the association step is what binds it to a subnet and makes routing take effect.

---

## Internet Gateway and the three conditions for inbound access

An IGW is horizontally scaled, redundant, and AZ-agnostic — one per VPC, no capacity to configure. It does two things: 1:1 NAT between public and private IPs (the public IP mapping lives at the IGW, not on the instance — which is why `ip addr` on an EC2 instance never shows its public IP), and serves as a route table target.

All three of these must be true simultaneously for inbound internet access to work:

1. The instance has a public or Elastic IP on its ENI.
2. The subnet's route table has `0.0.0.0/0 → IGW`.
3. Both the security group and the NACL allow the inbound traffic on that port.

Any one missing produces the same symptom: a silent timeout with no obvious pointer to the actual cause. This is where most "why can't I reach my instance" tickets originate.

---

## NAT Gateway: outbound only

A NAT gateway lives in a specific subnet in a specific AZ, performs source NAT for private instances, and has real hourly and per-GB cost. The packet walk for a private instance at `10.0.2.15` requesting a public registry:

1. Private subnet route table: `0.0.0.0/0 → nat-0abc...`
2. NAT gateway rewrites source to its own Elastic IP + ephemeral port
3. NAT gateway's public subnet route table: `0.0.0.0/0 → IGW`
4. IGW performs its own separate 1:1 NAT translation

Two distinct NAT translations — easy to collapse into one mental step, but they're separate resources doing separate jobs.

**Why it lives in the public subnet:** the NAT gateway needs its own route to the IGW, so it must sit in a subnet whose route table already points to the IGW. The private subnet's route table then points `0.0.0.0/0` at the NAT gateway. Two different route tables, two different subnets, one resource bridging them.

**HA pattern:** one NAT gateway per AZ, each AZ's private subnet routing to the NAT gateway in its own AZ. One NAT gateway for the whole VPC is cheaper but creates a single point of failure — if that AZ has an outage, every private subnet in every other AZ loses outbound internet access.

**Cost trap worth auditing:** traffic to S3 and DynamoDB from private subnets doesn't need to go through NAT at all if you use VPC Gateway Endpoints. Routing S3 traffic through NAT is billed per GB with no benefit over a free Gateway Endpoint.

---

## Read the Full Article

The summary covers the core mental model. The full article goes deeper on:

- The reverse-engineering formula for subnet sizing applied to autoscaling groups and EKS node groups, with the specific IP exhaustion failure mode explained
- The full route table example with VPC peering and S3 Gateway Endpoint entries, and why most-specific-match matters for overlapping routes
- IGW statelessness and why NACLs require explicit ephemeral port rules (`1024–65535`) that security groups handle automatically
- NAT Gateway connection tracking limits: 55,000 concurrent connections per unique destination, `PortAllocationErrors` in CloudWatch as the signal, and when to reconsider architecture vs. adding more NAT gateways
- The full security group vs. NACL comparison — stateful vs. stateless evaluation, allow-only vs. allow-and-deny, and why the default NACL and default security group behave differently out of the box

**👉 [AWS VPC Networking Fundamentals — Full Article](https://aloknecessary.in/blogs/aws-vpc-networking-fundamentals/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-networking-fundamentals)**
