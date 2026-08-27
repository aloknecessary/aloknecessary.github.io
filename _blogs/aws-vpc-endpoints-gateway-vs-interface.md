---
layout: blog
title: "VPC Endpoints: Gateway vs Interface, and the AWS Traffic That Shouldn't Touch the Internet"
date: 2026-08-25
last_modified_at: 2026-08-27T13:55:22+05:30
author: Alok Ranjan Daftuar
description: "A practical guide to AWS VPC endpoints — how Gateway endpoints (S3, DynamoDB) and Interface endpoints (PrivateLink) work under the hood, when each is worth adding, and the failure modes that actually show up in production."
excerpt: "Traffic to S3 and DynamoDB from a private subnet routes through a NAT gateway by default — and gets billed for it — unless you tell AWS it doesn't need to leave the VPC at all."
keywords: "vpc endpoints, gateway endpoint, interface endpoint, privatelink, aws networking, s3 endpoint, nat gateway, private subnet, terraform, cost optimization"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [vpc-endpoints, privatelink, gateway-endpoint, interface-endpoint, cost-optimization, aws, networking, terraform, security, nat-gateway]
series: "AWS Network Architecture"
series_order: 3
---

Two articles ago, in [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/), I flagged a detail almost in passing: traffic from a private subnet to S3 routes through the NAT gateway by default, and gets billed per GB for the privilege, when a free alternative exists. The follow-up article on [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/) mentioned it again in the context of a hub-and-spoke architecture. It's worth its own article, because the fix — VPC endpoints — is one of the highest-leverage, lowest-effort changes available in most AWS accounts, and the two flavors of endpoint work in genuinely different ways under the hood.

## Why this traffic touches NAT in the first place

An instance in a private subnet, by definition, has no route to the internet except through a NAT gateway. Every AWS service — S3, DynamoDB, Secrets Manager, ECR, SQS, all of it — has a public API endpoint, reachable at a public DNS name resolving to a public IP. So without any other configuration, a private instance calling `s3.ap-south-1.amazonaws.com` does exactly what it would do calling any other internet host: routes to the NAT gateway, gets source-translated, exits through the IGW, and comes back the same way.

This isn't a bug or an oversight — it's just what "private subnet with NAT" means by default. The problem is that this traffic never actually needed to leave AWS's network at all. Both the instance and the S3 bucket are inside AWS. Routing that traffic out through an internet gateway and back is unnecessary hops, unnecessary NAT processing charges, and — depending on your security posture — an unnecessary path that technically transits infrastructure your security team may want to keep in scope for internet-egress review, when it doesn't need to be internet egress at all.

VPC endpoints solve this by giving AWS services a **private, in-VPC address path** — either through route table entries (Gateway endpoints) or through an actual ENI in your subnet (Interface endpoints). Which mechanism applies depends entirely on which service you're connecting to; this isn't a setting you choose per-service, it's fixed by AWS per service.

## Gateway endpoints: a route table entry, nothing more

Gateway endpoints exist for exactly two services: **S3 and DynamoDB**. A Gateway endpoint isn't a network device sitting in your VPC — it's a target you add to a route table, functioning conceptually like the `local` route or the IGW route, except it points at the AWS service directly.

```hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name       = "com.amazonaws.ap-south-1.s3"
  vpc_endpoint_type  = "Gateway"
  route_table_ids    = [aws_route_table.private.id]

  tags = {
    Name = "vpce-s3-gateway"
  }
}
```

Once associated with a route table, AWS injects a route automatically for S3's published IP prefix list — you don't manage individual CIDR entries yourself, and the prefix list updates as AWS's ranges change:

```bash
aws ec2 describe-route-tables \
  --route-table-ids rtb-0private123 \
  --query 'RouteTables[0].Routes[?GatewayId!=`null`]' \
  --output table
```

```text
------------------------------------------------------------
| DestinationPrefixListId | GatewayId              | State  |
------------------------------------------------------------
| pl-63a5400a              | vpce-0abc123s3         | active |
------------------------------------------------------------
```

Traffic to any IP in that prefix list now routes to the Gateway endpoint instead of the NAT gateway — no DNS change, no application code change, no client library configuration. The instance still resolves `s3.ap-south-1.amazonaws.com` to the same public IP it always did; what changes is the *route* that IP now matches, because the prefix list route is more specific than the default `0.0.0.0/0` route to NAT.

### The cost model

Gateway endpoints have **no hourly charge and no per-GB data processing charge**. This is the detail that makes them close to a strict upgrade with no downside for S3 and DynamoDB traffic — there's essentially no reason to route S3 or DynamoDB traffic through NAT once a Gateway endpoint exists in the VPC, unless you have a specific reason to inspect that traffic through a NAT-adjacent proxy layer.

### The one real limitation

Gateway endpoints are associated with specific route tables, not with the whole VPC — if you add a new private subnet with its own route table later, you need to explicitly associate the Gateway endpoint with that new route table too, or that subnet's traffic falls back to NAT silently. This is a common source of "S3 traffic is going through NAT for this one new subnet but not the others" tickets, and it's worth adding to any subnet-creation checklist rather than discovering it in a cost report weeks later.

## Interface endpoints: a real ENI, backed by PrivateLink

Every other AWS service that supports VPC endpoints — Secrets Manager, ECR (both API and Docker registry), SQS, SNS, STS, CloudWatch Logs, Systems Manager, and dozens more — uses an **Interface endpoint**, which works completely differently from a Gateway endpoint. Rather than a route table entry, AWS provisions an actual **Elastic Network Interface** in a subnet you specify, with a private IP address from that subnet's range, backed by AWS PrivateLink.

```hcl
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name         = "com.amazonaws.ap-south-1.secretsmanager"
  vpc_endpoint_type    = "Interface"
  subnet_ids           = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids   = [aws_security_group.vpce_sm.id]
  private_dns_enabled  = true
}

resource "aws_security_group" "vpce_sm" {
  name   = "sg-vpce-secretsmanager"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}
```

Because it's a real ENI, an Interface endpoint has a security group — this is the first meaningful architectural difference from a Gateway endpoint, and it means Interface endpoint access is controlled the same way any other instance-level resource is: by security group rules, not by route table association.

### Private DNS: the setting that makes this transparent

`private_dns_enabled = true` is what makes Interface endpoints usable without changing application code. When enabled, AWS automatically creates a private hosted zone that overrides the public DNS name for the service (`secretsmanager.ap-south-1.amazonaws.com`) to resolve to the endpoint's private IP, for any resolver query originating inside the VPC. Without it, the standard public DNS name still resolves to a public IP, and you'd need to explicitly target the endpoint-specific DNS name AWS generates (`vpce-0abc...secretsmanager.ap-south-1.vpce.amazonaws.com`) in application configuration — which works, but means every service client needs to know it's talking to an endpoint rather than the standard name. Leaving `private_dns_enabled` on is almost always the right default, since it makes the endpoint transparent to code that was written assuming standard AWS SDK endpoint resolution.

### The cost model — the opposite of Gateway endpoints

Interface endpoints bill **hourly per AZ the endpoint is deployed in, plus per-GB data processed**. This is the trade-off that matters when deciding whether to add one: for a low-traffic service like Secrets Manager calls at application startup, the hourly charge across multiple AZs can, in some account sizes, cost more than the NAT gateway processing charge it's replacing. For a high-traffic service — CloudWatch Logs from a busy application, or ECR pulls during frequent deployments — the NAT processing charge being avoided is usually larger than the endpoint's own cost, and the endpoint is a clear win.

This is the opposite cost shape from Gateway endpoints, and it means "add Interface endpoints for everything" isn't automatically correct the way "add the S3 Gateway endpoint" almost always is. Worth actually pricing per service based on real traffic volume rather than applying a blanket policy.

## Deciding which services actually need an Interface endpoint

A practical filter, based on what I've prioritized in the current migration work: start with services every private instance talks to constantly regardless of application logic — **STS** (IAM role assumption, called far more often than people expect under the hood), **CloudWatch Logs** (if you're shipping logs continuously), and **ECR** (if pulling images from private subnets, especially during CI/CD or autoscaling events with cold starts). These three tend to justify their hourly cost quickly in any account with meaningful private-subnet compute. Lower-traffic services — Secrets Manager called once at startup, SNS for occasional notifications — are worth evaluating with real CloudWatch usage data rather than provisioning preemptively.

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-07-01,End=2026-08-01 \
  --granularity MONTHLY \
  --filter file://nat-gateway-filter.json \
  --metrics "UsageQuantity" "BlendedCost"
```

Running a Cost Explorer query filtered to NAT Gateway data processing charges, broken down by usage type, is the fastest way to find which destinations are actually driving NAT cost in a specific account — rather than guessing which services to prioritize for Interface endpoints.

## Security group and NACL implications

Because a Gateway endpoint is a route table target, it doesn't introduce a new security boundary to configure — traffic to it is governed by the same security groups and NACLs already controlling the instance's outbound traffic generally. An Interface endpoint, being a real ENI, needs its own security group permitting inbound HTTPS from the VPC CIDR (or more narrowly, from the specific security groups of instances that should reach it) — and this is a boundary worth actually using, not leaving wide open to the whole VPC CIDR by default. Scoping an Interface endpoint's security group to only the application tier that legitimately calls that service is a meaningful, low-effort security improvement over the NAT-routed alternative, where any instance with a route to NAT could reach the public service endpoint with no additional gate at all.

## A side-by-side summary

| | Gateway Endpoint | Interface Endpoint |
| --- | --- | --- |
| Mechanism | Route table entry | ENI backed by PrivateLink |
| Services supported | S3, DynamoDB only | Most other AWS services |
| Cost | Free | Hourly per AZ + per-GB processed |
| Security control | Via existing SG/NACL on the instance | Own security group on the endpoint ENI |
| DNS | No change needed | Private DNS override, if enabled |
| Multi-subnet | Must associate route table per subnet | Deploy ENI per AZ you need it in |

## Troubleshooting: the failure modes that actually show up

Interface endpoints fail in a small, predictable set of ways, and it's worth knowing them before you're debugging one under pressure:

- **Private DNS conflicts across accounts or VPCs sharing a Transit Gateway.** If two VPCs both have Interface endpoints for the same service with private DNS enabled, and they're connected via Transit Gateway or peering, DNS resolution can become ambiguous depending on which VPC's resolver handles the query — an instance in VPC-A might resolve the service name to VPC-B's endpoint ENI instead of its own. This is worth testing explicitly in any hub-and-spoke design rather than assuming it resolves correctly by default, since the fundamentals article's point about DNS not automatically following routing connectivity applies here too.
- **Security group too narrow, blocking the endpoint's own health check or the client's ephemeral return traffic.** Since the Interface endpoint's security group is a real, instance-style security group, it needs to allow inbound HTTPS specifically from whatever's calling it — a security group that only permits a narrow CIDR and misses the actual calling subnet produces a connection timeout that looks identical to a NAT or routing failure, but is actually a security group issue at the endpoint itself, not at the calling instance.
- **Endpoint deployed in the wrong AZ relative to the calling instance.** An Interface endpoint's ENI lives in a specific subnet in a specific AZ. If it's only deployed in AZ-a but calling instances are also in AZ-b and AZ-c, cross-AZ calls still work, but they incur cross-AZ data transfer charges on top of the endpoint's own per-GB cost — deploying the endpoint into every AZ that has calling instances is the fix, and it's a cost detail easy to miss since the endpoint still functions correctly with only one AZ, just at avoidable extra cost.
- **`private_dns_enabled` set on the endpoint but a custom DHCP option set or resolver override on the VPC taking precedence.** If a VPC has custom DNS resolution configured — a Route 53 Resolver rule pointing elsewhere, for instance — the endpoint's private hosted zone override can be superseded, and traffic reverts to the public endpoint through NAT despite everything on the endpoint side being configured correctly. Worth checking VPC-level resolver configuration as a checklist item, not just the endpoint's own settings, when private DNS doesn't seem to be taking effect.

## What to do this week if you haven't already

If there's one specific, low-risk action to take away from this article: add the S3 Gateway endpoint to every VPC with private subnets that touch S3 at all, today, if it isn't already there. There's no cost, no application change, and no meaningful downside — it's one of the few AWS changes that's close to strictly beneficial. Interface endpoints deserve the more deliberate, usage-data-driven evaluation described above, but the Gateway endpoint for S3 is close to a default-yes.

> 📌 **Key Takeaway**: Gateway endpoints (S3, DynamoDB) are free route table entries with essentially no downside — enable them by default. Interface endpoints (everything else) are real, billed infrastructure with their own security group, and deserve real usage data before you add them broadly. Both exist to keep AWS-to-AWS traffic off the public internet path entirely, which is a security improvement as much as a cost one.
