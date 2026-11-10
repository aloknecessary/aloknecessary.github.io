---
title: "Security Groups and NACLs at Scale: Design Patterns That Survive Growth"
published: false
description: Security groups work fine at ten instances and become a liability at ten thousand. Six patterns that keep that from happening, plus where NACLs actually earn their place.
tags: aws, security, networking, terraform
canonical_url: https://aloknecessary.in/blogs/aws-security-group-nacl-design-patterns-at-scale/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-security-group-nacl-design-patterns-at-scale
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a layered AWS network security architecture. Glowing concentric security boundaries around VPC subnets, with directional arrows showing traffic flow between ALB, app tier, and database tier nodes. Shield icons at each layer boundary. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

At small scale, security groups feel almost too simple: open the port, attach the group, move on. The trouble shows up gradually. Rules accumulate with no owner. A group created for one service gets attached to five. Someone adds `0.0.0.0/0` temporarily to debug something. A few hundred security groups later, nobody can say which rules are still needed, and removing any of them feels risky.

The failure isn't the feature — it's the habits. This article covers the design patterns that keep security groups manageable as the environment grows, and where NACLs fit in as a coarse guardrail rather than a parallel policy layer.

---

## Reference security groups, not CIDRs

The single most valuable habit is expressing rules in terms of *who* rather than *where*. A rule that says "allow 5432 from `10.0.16.0/20`" breaks when the app tier is re-addressed and quietly allows anything that lands in that range. A rule that says "allow 5432 from the app security group" follows the workload.

```text
Internet
   | 443
[ alb-sg ]  ingress 443 from 0.0.0.0/0
   | 8080  (source = alb-sg)
[ app-sg ]  ingress 8080 from alb-sg
   | 5432  (source = app-sg)
[ db-sg ]   ingress 5432 from app-sg
```

In Terraform, use `aws_vpc_security_group_ingress_rule` with `referenced_security_group_id` rather than `cidr_ipv4`. Each rule is its own resource with its own description — changes are small targeted diffs, not whole-group rewrites. Always fill in `description`: six months later it's the only record of why a rule exists.

---

## Compose small single-purpose groups per interface

Instead of one large group per application, attach several small groups with a single purpose each. An app-tier instance might carry `app-sg` (its service port), `monitoring-agent-sg` (scrape port from the monitoring group), and `ssm-egress-sg` (egress to the SSM endpoint). Rules are cumulative — the effective policy is the union.

This keeps each group understandable on its own, lets shared concerns be defined once and reused, and makes removal safe: detach one group and exactly one capability goes away. Worth knowing: there's a default limit on how many groups can be attached to a single interface, and a combined rule quota across all of them. Both can be raised, but check the current numbers before designing around deep composition.

---

## Remove inbound SSH — use Session Manager instead

The most common long-lived overly broad rule is port 22 open to a corporate range. Session Manager uses an outbound connection from the SSM agent, so no inbound port is needed at all:

```bash
aws ssm start-session --target i-0abc123def4567890
```

"Who can get a shell on this instance" becomes an IAM question with audit logging, not a firewall question with a list of source IPs that someone has to keep current. The instance needs to reach the SSM endpoints (through NAT or Interface endpoints) and an instance profile that allows it.

---

## Managed prefix lists for shared address sets

Some rules genuinely need CIDRs: corporate egress ranges, partner IPs, on-premises networks over VPN or Direct Connect. A managed prefix list is a named, reusable set of CIDRs that security group rules and route tables can reference:

```hcl
resource "aws_ec2_managed_prefix_list" "corp_ranges" {
  name           = "corp-office-and-vpn"
  address_family = "IPv4"
  max_entries    = 20

  entry { cidr = "203.0.113.0/24", description = "HQ egress" }
  entry { cidr = "198.51.100.0/24", description = "VPN concentrator" }
}
```

Update the list once and every rule referencing it follows. Two caveats: a prefix list counts against a security group's rule quota by its *maximum* size, not its current entry count — a list with `max_entries = 200` consumes a lot of rule budget even with five entries. And prefix lists can be shared across accounts through Resource Access Manager, which fits the central-network-account pattern well.

---

## Control egress for sensitive tiers

Security groups allow all outbound traffic by default. For a database tier, restrict egress to only what's needed and use AWS-managed prefix lists for service endpoints:

```hcl
data "aws_prefix_list" "s3" {
  name = "com.amazonaws.${var.region}.s3"
}

resource "aws_vpc_security_group_egress_rule" "db_to_s3" {
  security_group_id = aws_security_group.db.id
  prefix_list_id    = data.aws_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Backups to S3 via the gateway endpoint"
}
```

Note: a Terraform-managed `aws_security_group` removes AWS's default allow-all egress rule, so a group with no egress rules defined blocks all outbound traffic. This surprises people the first time an instance can't reach anything.

---

## NACLs: the coarse guardrail

With security groups carrying the policy, NACLs earn their place for a short list of jobs: explicitly denying a known-bad range (which security groups can't express), enforcing a hard subnet-boundary rule for compliance, and acting as an independent second layer if a security group is misconfigured.

Because NACLs are stateless, every allow needs a matching rule for return traffic, including ephemeral ports (1024–65535). Number rules in steps of 10 or 100 so there's room to insert later without renumbering. A custom NACL denies everything until you add allows — forgetting the return-traffic rule is the classic way to break a working service.

NACLs don't filter traffic between instances in the same subnet, and certain infrastructure traffic (DNS to the Amazon-provided resolver, instance metadata) isn't filtered by them either.

---

## Enforcing a baseline across accounts

Policy that depends on every team remembering a convention won't hold across dozens of accounts:

- **AWS Firewall Manager** applies security group policies across an Organization: enforce a common baseline group, audit for overly permissive rules, flag unused groups
- **AWS Config managed rules** detect drift: default security group having rules, SSH open to the world, and similar conditions
- **Service control policies** restrict who may modify security groups, so changes go through the pipeline rather than the console

For finding problems that already exist, two CLI queries go a long way — groups with any rule open to the internet, and groups not attached to any network interface (cleanup candidates).

---

## Read the Full Article

The summary covers the core patterns. The full article goes deeper on:

- Complete Terraform for all six patterns: the three-tier SG reference chain, the empty default group, the NACL with explicit deny and return-traffic rules
- Cross-VPC and cross-account referencing limits — what works across peering vs. Transit Gateway, and the practical convention for managing cross-VPC CIDRs as prefix lists
- The CLI queries for auditing open and unused groups, with the caveat about groups referenced by rules but not attached to any interface
- Using VPC Reachability Analyzer and Flow Logs together to distinguish a security group block from a NACL block

**👉 [Security Groups and NACLs at Scale — Full Article](https://aloknecessary.in/blogs/aws-security-group-nacl-design-patterns-at-scale/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-security-group-nacl-design-patterns-at-scale)**
