---
title: "AWS VPC Networking Fundamentals: VPCs, Subnets, CIDR, Route Tables, IGW, and NAT Gateways"
date: 2026-08-21
last_modified_at: 2026-08-21T11:50:00+05:30
author: Alok Ranjan Daftuar
description: "A ground-up mental model for AWS VPC networking — how CIDR math, subnet allocation, route tables, internet gateways, and NAT gateways connect into a single coherent system, with Terraform examples and production sizing guidance."
excerpt: "A clear mental model for how VPCs, subnets, CIDR blocks, route tables, internet gateways, and NAT gateways fit together — and why route tables, not subnet names, decide what's actually public or private."
keywords: "aws vpc, subnets, cidr, route tables, internet gateway, nat gateway, security groups, network acl, vpc networking, terraform, eks networking"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [vpc, subnets, cidr, route-tables, internet-gateway, nat-gateway, security-groups, aws, networking, terraform]
series: "AWS Network Architecture"
series_order: 1
---

If you've worked with AWS for any length of time, you've probably provisioned a VPC from a Terraform module or a CloudFormation template without fully internalizing what each piece is doing. That's fine right up until something breaks — an instance that should be reachable isn't, or a private instance can't pull a package update — and you're left checking five different resources with no clear mental model of how they connect.

This post builds that mental model from the ground up: VPCs, CIDR math, subnet allocation, route tables, internet gateways, NAT gateways, and the security layers that sit on top of all of it. The goal isn't just definitions — it's understanding *why* each piece is designed the way it is, so troubleshooting becomes deduction instead of guesswork.

## The building analogy

Before the technical detail, one mental model that holds up surprisingly well:

- **VPC** is the building itself — an isolated network space you own, defined by an IP range.
- **Subnets** are floors or wings of the building — subdivisions of that IP range, each tied to one Availability Zone.
- **Route table** is the building directory that tells traffic which door to exit through.
- **Internet Gateway (IGW)** is the building's main street entrance — bidirectional, for anyone with a public address.
- **NAT Gateway** is a one-way turnstile — lets people inside leave and come back, but nobody outside can walk in through it.
- **Security Group** is the guard standing at each individual apartment door — stateful, instance-level.
- **Network ACL** is the guard at the floor's stairwell — stateless, checks both directions independently, subnet-level.

Keep this in your head as we go through each piece in detail — it maps cleanly onto the real architecture.

## VPC: the address space

Everything starts with a CIDR block, most commonly something like `10.0.0.0/16`. This defines your entire private IP universe inside AWS. Nothing outside AWS can route to it unless you explicitly build a path — an internet gateway, a VPN, a peering connection, or a Transit Gateway attachment.

### Why /16 is the default recommendation

`10.0.0.0/16` gives you 65,536 addresses to carve up across subnets, tiers, and Availability Zones. It's not that any single workload needs that many addresses — it's that **VPC CIDR is difficult to resize after the fact**. Once you have subnets, peering connections, or Transit Gateway attachments built against a VPC's CIDR, shrinking or renumbering it becomes a real migration project. You can add secondary CIDR blocks later, but that adds complexity rather than removing it.

Starting with a `/16` from the RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) costs nothing up front and avoids painting yourself into a corner. The one exception: check this against any ranges you'll eventually need to connect to — if you're running a hybrid setup with an on-prem network or another cloud, overlapping CIDRs will block you from peering or routing between them without re-IP'ing one side.

## CIDR math you actually need

A CIDR block is written as `IP address / prefix length`. The prefix length tells you how many bits are fixed (the network portion) versus how many are free (the host portion — i.e., how many addresses you get).

The formula: `2^(32 - prefix) = total addresses`.

| CIDR | Host bits | Total addresses | Usable (AWS reserves 5) |
| --- | --- | --- | --- |
| /16 | 16 | 65,536 | 65,531 |
| /20 | 12 | 4,096 | 4,091 |
| /24 | 8 | 256 | 251 |
| /26 | 6 | 64 | 59 |
| /28 | 4 | 16 | 11 |

AWS reserves five IP addresses in every subnet, not just at the VPC level: the network address, the VPC router, DNS, a reserved address for future use, and the broadcast address. This is the detail that catches people sizing subnets for the first time — a `/24` looks like 256 addresses on paper but only delivers 251 usable ones.

### Reverse-engineering a prefix from a required host count

If you know you need to support a specific number of hosts, work backwards:

```text
required_hosts = 300
next_power_of_2 = 512   (2^9)
host_bits = 9
prefix = 32 - 9 = /23
```

Round up to the next power of two, then subtract the exponent from 32. This is the calculation to run before sizing any subnet that will host an autoscaling group or an EKS node group, where you can't afford to size for today's count and forget tomorrow's peak.

## Subnet allocation: carving up the VPC

Take `10.0.0.0/16`. The first two octets (`10.0`) are fixed by the VPC CIDR. The remaining 16 bits — the last two octets — are yours to allocate across subnets and Availability Zones.

A common pattern carves that space into `/24` blocks, each giving 251 usable addresses — enough for most workload tiers:

```text
10.0.0.0/16      VPC
├── 10.0.0.0/24    public-subnet-az-a
├── 10.0.1.0/24    public-subnet-az-b
├── 10.0.10.0/24   private-subnet-az-a
├── 10.0.11.0/24   private-subnet-az-b
├── 10.0.20.0/24   data-subnet-az-a     (RDS, ElastiCache)
├── 10.0.21.0/24   data-subnet-az-b
```

Notice the deliberate gaps — `0-1`, then `10-11`, then `20-21`, rather than sequential numbering. This isn't sloppiness; it does two useful things. It leaves room to insert a new tier later (for example, `10.0.2.0/24` and `10.0.3.0/24` for a third public-tier AZ) without renumbering anything already deployed. It also lets you tell, at a glance, that `10.0.10.0/24` and `10.0.11.0/24` are the same tier in different AZs, just from the last octet.

### Sizing for EKS and IP-hungry workloads

If subnets will host EKS worker nodes, don't default to `/24` without checking density first. With the VPC CNI, every pod can consume an ENI-backed IP address depending on instance type — IP exhaustion is one of the most common causes of EKS production incidents, and it's entirely avoidable with correct upfront sizing. A `/20` (4,091 usable addresses) per AZ is a common choice for EKS worker subnets specifically because of this.

### A practical allocation table for a three-AZ production VPC

| Tier | AZ-a | AZ-b | AZ-c | Size | Typical use |
| --- | --- | --- | --- | --- | --- |
| Public | 10.0.0.0/24 | 10.0.1.0/24 | 10.0.2.0/24 | /24 | ALB, NAT gateway, bastion |
| Private/app | 10.0.16.0/20 | 10.0.32.0/20 | 10.0.48.0/20 | /20 | EKS nodes, ECS, EC2 |
| Data | 10.0.64.0/24 | 10.0.65.0/24 | 10.0.66.0/24 | /24 | RDS, ElastiCache |
| Reserved | 10.0.128.0/17 | | | /17 | Future tiers, Transit Gateway, VPN |

The jump from `/24` in the public tier to `/20` in the app tier is intentional. ALBs and NAT gateways consume very few IPs; the app tier is where consumption actually scales with autoscaling groups, rolling deployments, and pod density.

### Mistakes worth flagging before you deploy

Sizing subnets too tightly for autoscaling is a common one — a `/28` for an autoscaling group that bursts to twenty instances leaves zero headroom, and a rolling deployment alone can temporarily double instance count. It's also easy to forget that Lambda functions running inside a VPC and Fargate tasks both consume subnet IPs too, even though there's no persistent EC2 instance to account for.

## Route tables: the actual decision maker

A subnet is associated with exactly one route table, and that table is what actually determines whether a subnet is "public" or "private" — not any inherent property of the subnet itself. The table is a list of `destination -> target` rules evaluated by **most specific match**, not first-match-in-list. If a table has both `10.0.0.0/16 -> local` and a more specific `10.0.0.0/24 -> pcx-xxxx` for a peering connection, the `/24` route wins for any traffic that matches it, even though `local` appears first.

Every route table gets an implicit `local` route for the full VPC CIDR the moment it's created — this can't be removed, and it's what lets every subnet reach every other subnet inside the VPC by default, independent of any other route table configuration.

### Example: a public subnet route table

For a subnet `10.0.0.0/24` associated with route table `rtb-0public123`:

| Destination | Target | Notes |
| --- | --- | --- |
| `10.0.0.0/16` | `local` | Implicit, always present, intra-VPC traffic |
| `0.0.0.0/0` | `igw-0abc123def456` | Internet-bound traffic exits via the IGW |
| `10.100.0.0/16` | `pcx-0xyz789` | Optional — VPC peering to a shared services VPC |
| S3 prefix list | `vpce-0s3endpoint` | Optional — Gateway Endpoint so S3 traffic skips the IGW |

As Terraform:

```hcl
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "rtb-public"
    Tier = "public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id              = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_az_a.id
  route_table_id = aws_route_table.public.id
}
```

One route table can be associated with multiple subnets — you don't need a separate table per subnet unless the routing genuinely needs to differ between them, which is uncommon for a public tier. Also worth noting: creating the route table does nothing on its own. It's the association step — `aws_route_table_association`, or the equivalent console action — that actually binds it to a subnet and makes the routing take effect.

## Internet Gateway: the front door

An Internet Gateway is a horizontally scaled, redundant, highly available VPC component, not a device with capacity you provision or an AZ you pick. You attach exactly one IGW per VPC, and it exists as a managed edge function with no bandwidth constraints to configure.

It does two things. First, it performs 1:1 NAT between public and private IP addresses. Instances only ever have a private IP on their ENI — when you attach a public or Elastic IP, AWS maintains a mapping at the IGW between that public IP and the instance's private IP, rather than putting the public address on the instance itself. This is why an instance's own operating system never shows its public IP in `ip addr` — only the private address is visible locally; the public mapping lives entirely at the IGW layer. Second, it serves as a route table target — the IGW does nothing by itself until a subnet's route table points `0.0.0.0/0` at it.

### The three conditions for inbound internet access

This is where most "why can't I reach my instance" tickets originate. All three of these must be true simultaneously:

1. The instance has a public or Elastic IP attached to its ENI.
2. The subnet's route table has a route to the IGW for `0.0.0.0/0` (or the relevant external range).
3. Both the security group and the network ACL allow the inbound traffic on that port.

Any one of these being correct while the others aren't produces the same symptom: a silent timeout, with no obvious error pointing at the actual cause.

### Statelessness at the gateway

The IGW itself doesn't track connection state — it's pure, symmetric address translation in both directions. Statefulness for "did I initiate this connection" comes from the security group, not the IGW. This matters for NACLs specifically: since NACLs are stateless and sit at the subnet boundary that IGW-routed traffic passes through, you need explicit rules permitting ephemeral port return traffic (typically `1024–65535` inbound), or return traffic gets silently dropped even when the security group would have allowed it.

If you're running dual-stack with IPv6, note that IPv6 doesn't have the same private/public distinction IPv4 has — all IPv6 addresses in a VPC are globally routable by default. For instances that should only initiate outbound IPv6 connections without accepting inbound ones, the equivalent resource is an **Egress-Only Internet Gateway**, not a regular IGW — a regular IGW with an IPv6 route makes an instance bidirectionally reachable, since there's no NAT layer providing cover.

## NAT Gateway: outbound only

A NAT gateway is a managed, AWS-operated resource that lives in a specific subnet in a specific Availability Zone and performs source NAT — rewriting the source IP of outbound packets from a private instance's private IP to the NAT gateway's own Elastic IP, then reversing that mapping for return traffic. Unlike the IGW, it's AZ-scoped, has real hourly and per-GB cost, and has real throughput characteristics.

### The packet walk

A private instance at `10.0.2.15` requesting a package from a public registry:

1. Instance sends a packet: source `10.0.2.15:54321`, destination `registry:443`.
2. The private subnet's route table matches `0.0.0.0/0 -> nat-0abc...` and forwards it.
3. The packet arrives at the NAT gateway, which sits in a public subnet.
4. The NAT gateway rewrites the source to its own Elastic IP and an ephemeral port.
5. The NAT gateway's own subnet route table sends the packet to the IGW.
6. The IGW performs its own separate 1:1 NAT translation and the packet exits.
7. The response traverses both translations in reverse.

Two distinct NAT translations happen here, not one — it's easy to collapse them into a single mental step, but they're separate resources doing separate jobs.

### Why it lives in the public subnet

This is a frequent source of confusion: the NAT gateway needs its own route to the IGW to reach the internet, so it must sit in a subnet whose route table already points to the IGW — a public subnet by definition. The private subnet's route table then points `0.0.0.0/0` at the NAT gateway itself. Two different route tables, two different subnets, one resource bridging them.

### Connection tracking and limits worth knowing before production

The NAT gateway maintains a connection table mapping private IP and port to its own Elastic IP and ephemeral port, per destination — this is what makes it stateful, not any action from a security group. A few hard limits matter for sizing:

- **55,000 concurrent connections per unique destination**, not total. Many instances behind one NAT gateway all hitting the same destination — a single database endpoint or third-party API — can exhaust this per-destination limit well before total connection capacity is a concern.
- **5 Gbps baseline bandwidth, bursting to 100 Gbps**, scaling automatically. Consistent saturation is a signal to reconsider architecture — VPC endpoints, multiple NAT gateways — rather than simply provisioning more.
- Ephemeral port exhaustion per destination shows up as `PortAllocationErrors` in CloudWatch — the metric to watch when outbound connections start failing under load.

### The HA and cost tradeoff

A single NAT gateway is a single point of failure for its Availability Zone — AWS does not replicate one across AZs automatically. One NAT gateway for the whole VPC is the cheapest option, but if that AZ has an outage, every private subnet in every other AZ loses outbound internet access too, and you pay cross-AZ data transfer for traffic routed to it from other AZs. One NAT gateway per AZ, with each AZ's private subnet routing to the NAT gateway in its own AZ, is the standard production pattern — no cross-AZ dependency, no cross-AZ transfer charge, at roughly triple the hourly and data processing cost for a three-AZ VPC.

### NAT Gateway versus NAT instance

| | NAT Gateway | NAT Instance |
| --- | --- | --- |
| Management | Fully managed by AWS | Self-managed EC2, patched by you |
| High availability | Managed within its AZ | Built by you |
| Bandwidth | Auto-scales to 100 Gbps | Capped by instance type |
| Security group | Not applicable — not a real ENI | Standard EC2 security group applies |
| Cost model | Hourly plus per-GB processed | Instance cost only |

NAT instances are effectively legacy advice at this point, worth using only for a specific reason like running custom traffic inspection on the NAT path itself. The managed NAT gateway is the correct default for nearly everyone.

### A cost trap worth auditing

Traffic to AWS services like S3 and DynamoDB from private subnets doesn't need to go through NAT at all if you use VPC Gateway or Interface Endpoints instead. Routing S3 traffic through a NAT gateway is a common accidental cost, since S3 traffic processed through NAT is billed per GB with no benefit over a free Gateway Endpoint — worth checking on any VPC that's been running for a while without this having been reviewed.

## Security groups versus network ACLs

Both sit on top of everything described above as independent firewall layers, and traffic must pass both to reach its destination.

| | Security group | Network ACL |
| --- | --- | --- |
| Scope | Instance or ENI level | Subnet level |
| State | Stateful — return traffic automatically permitted | Stateless — both directions must be allowed explicitly |
| Rule types | Allow only | Allow and deny |
| Evaluation | All rules evaluated cumulatively | Numbered rules, first match wins |

The default network ACL allows all traffic; the default security group allows all outbound traffic and denies all inbound traffic except from itself. This is also the reason ephemeral port rules matter so much for NACLs specifically — a security group tracks that a response belongs to a connection it initiated, but a NACL evaluates each direction as if it were unrelated to the other.

## Putting it together

The full picture, read as one flow: a VPC defines the address space; subnets carve that space per Availability Zone; a route table attached to each subnet decides where unmatched traffic goes; an IGW provides the only bidirectional path in and out, gated by whether an instance has a public IP; a NAT gateway provides an outbound-only path for private subnets by borrowing the IGW's route from a public subnet; and security groups plus NACLs layer independent, complementary filtering on top of all of it.

None of these pieces is complicated in isolation. What causes confusion in practice is treating them as independent knobs rather than a single connected system — and that's usually where the "why can't this instance reach the internet" debugging sessions come from. Once the full path is clear, most of those tickets resolve to checking one specific link in the chain rather than re-auditing the whole VPC.
