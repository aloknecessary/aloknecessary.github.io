---
title: "Security Groups and NACLs at Scale: Design Patterns That Survive Growth"
date: 2026-11-05
last_modified_at: 2026-11-10T18:49:58+05:30
author: Alok Ranjan Daftuar
description: "Security groups work fine at ten instances and become a liability at ten thousand. This article covers the design patterns that keep that from happening: group references over CIDRs, single-purpose composition, managed prefix lists, egress control, and how NACLs fit in as a coarse guardrail."
excerpt: "Security groups work fine at ten instances and become a liability at ten thousand. The failure isn't the feature, it's the habits: CIDR-based rules, one giant group per app, and no way to tell which rules anything still depends on."
keywords: "security groups, nacl, aws, vpc, prefix lists, firewall manager, vpc flow logs, network security, terraform"
twitter_card: "summary_large_image"
categories:
  - cloud
  - security
tags: [security-groups, nacl, prefix-lists, firewall-manager, vpc-flow-logs, network-security]
series: "AWS Network Architecture"
series_order: 8
---

> At small scale, security groups feel almost too simple: open the port, attach the group, move on.

The trouble shows up gradually. Rules accumulate with no owner. A group created for one service gets attached to five. Someone adds `0.0.0.0/0` "temporarily" to debug something. A few hundred security groups later, nobody can say which rules are still needed, and removing any of them feels risky.

This article is about the design habits that keep that from happening. It builds on the SG-versus-NACL comparison in [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/), and touches the earlier pieces where security groups appear: the [load balancer](/blogs/aws-load-balancer-internals-alb-nlb-gwlb/) article's ALB-to-target pattern, the [endpoint](/blogs/aws-vpc-endpoints-gateway-vs-interface/) article's per-endpoint security group, and the [multi-account](/blogs/aws-multi-account-networking/) article's split of centralized routing and decentralized security groups. This is design reasoning from how the features behave, not a record of one specific deployment.

## The mental model worth keeping

A security group isn't attached to a subnet or an instance in the abstract. It's attached to a **network interface**, and it's a **stateful, allow-only** filter evaluated cumulatively: if any rule in any attached group allows the traffic, it's allowed. There's no deny, and no ordering. A NACL is the opposite on nearly every axis: subnet-scoped, stateless, numbered, with both allow and deny rules and first-match-wins.

That difference suggests a division of labour. Security groups are the precise, per-workload control, and they should carry almost all of the policy. NACLs are a coarse subnet-level guardrail, useful for the things security groups structurally can't do, mainly explicit denies. Most scaling problems come from blurring those roles.

## Pattern 1: reference security groups, not CIDRs

The single most valuable habit is expressing rules in terms of *who* rather than *where*. A rule that says "allow 5432 from `10.0.16.0/20`" breaks when the app tier is re-addressed and quietly allows anything that happens to land in that range. A rule that says "allow 5432 from the app security group" follows the workload and allows only members of that group.

```text
Internet
   │ 443
   ▼
[ alb-sg ]  ingress 443 from 0.0.0.0/0
   │ 8080  (source = alb-sg)
   ▼
[ app-sg ]  ingress 8080 from alb-sg
   │ 5432  (source = app-sg)
   ▼
[ db-sg ]   ingress 5432 from app-sg
```

Each tier admits only the tier in front of it. No CIDR appears anywhere inside the VPC, so subnets can be re-planned without touching rules, and a compromised web-tier instance can't reach the database directly because it isn't in `app-sg`.

```hcl
resource "aws_security_group" "alb" {
  name_prefix = "alb-"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "app" {
  name_prefix = "app-"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name_prefix = "db-"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Public HTTPS to the load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "App port from the ALB only"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the app tier only"
}
```

Two implementation notes. First, the standalone `aws_vpc_security_group_ingress_rule` and `..._egress_rule` resources are generally preferable to inline `ingress` blocks at scale: each rule is its own object with its own description and tags, so changes are small, targeted diffs instead of whole-group rewrites. Second, always fill in `description`. Six months later it's the only record of why a rule exists.

## Pattern 2: compose several small groups per interface

The alternative to one large group per application is several small groups with a single purpose each, attached together. An instance in the app tier might carry `app-sg` (its service port), `monitoring-agent-sg` (scrape port from the monitoring group), and `ssm-egress-sg` (egress to the endpoint it needs). Because rules are cumulative, the effective policy is the union.

This keeps each group understandable on its own, lets shared concerns like monitoring be defined once and reused, and makes removal safe: detach one purpose-built group and exactly one capability goes away. The cost is a limit worth knowing about: by default an interface can have only a handful of security groups attached, and the rules across all of them are bounded by a combined quota. Both quotas can be raised within limits, so check the current numbers before designing around five-way composition.

## Pattern 3: remove inbound SSH entirely

The most common long-lived overly broad rule is port 22 open to a corporate range, or worse to the world. The cleaner design is not having an inbound administrative rule at all. Session Manager uses an outbound connection from the instance's SSM agent, so no inbound port is needed:

```bash
aws ssm start-session --target i-0abc123def4567890
```

This requires the instance to reach the SSM endpoints (through NAT or, better, Interface endpoints, as covered in the endpoints article) and an instance profile that allows it. In exchange, "who can get a shell on this instance" becomes an IAM question with audit logging, not a firewall question with a list of source IPs that someone has to keep current.

## Pattern 4: managed prefix lists for shared address sets

Some rules genuinely do need CIDRs: corporate egress ranges, partner IPs, on-premises networks reached over VPN or Direct Connect. Pasting the same ten CIDRs into forty security groups is how they drift apart. A **managed prefix list** is a named, reusable set of CIDRs that security group rules and route tables can reference:

```hcl
resource "aws_ec2_managed_prefix_list" "corp_ranges" {
  name           = "corp-office-and-vpn"
  address_family = "IPv4"
  max_entries    = 20

  entry {
    cidr        = "203.0.113.0/24"
    description = "HQ egress"
  }
  entry {
    cidr        = "198.51.100.0/24"
    description = "VPN concentrator"
  }
}

resource "aws_vpc_security_group_ingress_rule" "admin_from_corp" {
  security_group_id = aws_security_group.admin_tool.id
  prefix_list_id    = aws_ec2_managed_prefix_list.corp_ranges.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
```

Update the list once and every rule referencing it follows. Two caveats. A prefix list counts against a security group's rule quota by its *maximum* size, not its current entry count, so a list with `max_entries = 200` consumes a lot of rule budget even with five entries in it. And prefix lists can be shared across accounts through Resource Access Manager, which fits the central-network-account pattern from the multi-account article: one team owns the list, every account references it.

## Pattern 5: control egress, not just ingress

Security groups allow all outbound traffic by default, and many designs never revisit it. For sensitive tiers that's a gap: an exploited instance can reach anywhere. Terraform adds a subtlety here, since a Terraform-managed `aws_security_group` removes AWS's default allow-all egress rule, so a group with no egress rules defined blocks all outbound traffic and can surprise you the first time an instance can't reach anything.

For a database tier, a sensible default is to permit almost nothing outbound, and to reach AWS services through endpoints using AWS-managed prefix lists rather than open egress:

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

This works well alongside the Gateway endpoint from the endpoints article: the route sends S3 traffic to the endpoint, and the egress rule permits exactly that destination and nothing else.

## Pattern 6: keep the default security group empty

Every VPC has a default security group that, as shipped, allows all traffic between its own members and all outbound traffic. Anything launched without an explicit group lands in it. The safe stance is to strip it of all rules so that forgetting to assign a group results in an unreachable instance instead of a permissive one:

```hcl
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  # no ingress or egress blocks: removes all rules
}
```

## NACLs: the coarse guardrail

With security groups carrying the policy, NACLs earn their place for a short list of jobs: explicitly denying a known-bad range (which security groups can't express), enforcing a hard subnet-boundary rule for compliance, and acting as an independent second layer if a security group is misconfigured. Beyond those, a custom NACL mostly adds operational burden.

Because NACLs are stateless, every allow needs a matching rule for the return traffic, including ephemeral ports. A data-tier NACL permitting only the app tier to reach the database looks like this:

```hcl
resource "aws_network_acl" "data" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = [aws_subnet.data_a.id, aws_subnet.data_b.id]
}

# Explicit deny of a known-bad range, numbered low so it matches first
resource "aws_network_acl_rule" "deny_bad_range" {
  network_acl_id = aws_network_acl.data.id
  rule_number    = 50
  egress         = false
  protocol       = "-1"
  rule_action    = "deny"
  cidr_block     = "198.51.100.0/24"
}

resource "aws_network_acl_rule" "db_in_from_app" {
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "10.0.16.0/20"
  from_port      = 5432
  to_port        = 5432
}

resource "aws_network_acl_rule" "db_out_ephemeral" {
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "10.0.16.0/20"
  from_port      = 1024
  to_port        = 65535
}
```

Number rules in steps of 10 or 100 so there's room to insert a rule later without renumbering. A custom NACL denies everything until you add allows, so forgetting the return-traffic rule is the classic way to break a working service. It's also worth knowing what NACLs *don't* see: they filter traffic crossing a subnet boundary, so traffic between instances in the same subnet isn't evaluated, and certain infrastructure traffic such as DNS to the Amazon-provided resolver and instance metadata isn't filtered by them either.

## Cross-VPC and cross-account referencing

Security group references have scope limits that matter as the network grows beyond one VPC. Referencing another group by ID works within a VPC and across a VPC peering connection in the same region, but not across a Transit Gateway. The second case is the one that catches hub-and-spoke designs: once VPCs are connected through a Transit Gateway, rules between them have to use CIDRs or prefix lists. A practical convention is to give each VPC or segment a stable, documented CIDR block and manage those blocks as prefix lists, so cross-VPC rules stay readable. In a Shared VPC, participants can generally reference security groups owned by other participants in the same VPC; check the current documentation for the exact behaviour before relying on it.

## Enforcing a baseline across accounts

Policy that depends on every team remembering a convention won't hold across dozens of accounts. Three controls help, each at a different layer:

- **AWS Firewall Manager** can apply security group policies across an Organization: enforce a common baseline group, audit for overly permissive rules, and flag unused groups.
- **AWS Config managed rules** detect drift: the default security group having rules, SSH or common ports open to the world, and similar conditions.
- **Service control policies** can restrict *who* may modify security groups, so changes go through the pipeline rather than the console.

For finding the problems that already exist, a few CLI queries go a long way:

```bash
# Groups with any rule open to the whole internet
aws ec2 describe-security-groups \
  --filters Name=ip-permission.cidr,Values=0.0.0.0/0 \
  --query 'SecurityGroups[].{Id:GroupId,Name:GroupName,VpcId:VpcId}' \
  --output table

# Security groups not attached to any network interface (cleanup candidates)
aws ec2 describe-security-groups --query 'SecurityGroups[].GroupId' --output text \
  | tr '\t' '\n' | sort > all-sgs.txt
aws ec2 describe-network-interfaces --query 'NetworkInterfaces[].Groups[].GroupId' --output text \
  | tr '\t' '\n' | sort -u > used-sgs.txt
comm -23 all-sgs.txt used-sgs.txt
```

Treat the unattached list as candidates, not a delete list. A group can be referenced by another group's rules without being attached to anything itself, and the default group will always appear unused.

## Debugging: telling a security group from a NACL

When traffic is blocked and you aren't sure which layer is responsible, VPC Reachability Analyzer evaluates a path configuration and reports which component blocks it, without sending packets:

```bash
aws ec2 create-network-insights-path \
  --source i-0aaa111122223333 --destination i-0bbb444455556666 \
  --protocol tcp --destination-port 5432

aws ec2 start-network-insights-analysis --network-insights-path-id nip-0abc123
```

VPC Flow Logs complement it with what actually happened. The useful signal is stateful versus stateless behaviour: a security group that allows a connection also allows its replies, so if you see the inbound request logged as `ACCEPT` but the reply logged as `REJECT`, the likely culprit is a NACL missing a return-traffic rule. If the request itself is `REJECT`, either layer could be responsible, and Reachability Analyzer is the quicker way to find out.

## A short checklist

1. Express intra-VPC rules as security group references, not CIDRs.
2. Prefer small, single-purpose groups composed per interface over one group per app.
3. Remove inbound administrative ports; use Session Manager.
4. Put shared CIDR sets in managed prefix lists, and mind their effect on rule quotas.
5. Restrict egress for sensitive tiers and use AWS-managed prefix lists for service endpoints.
6. Empty the default security group.
7. Use NACLs for explicit denies and coarse subnet guardrails, with return-traffic rules and rule numbers spaced out.
8. Enforce a baseline with Firewall Manager, Config, and SCPs; audit open and unused groups regularly.

> 📌 **Key Takeaway**: Security groups should carry nearly all of your network policy, and at scale the difference is in how the rules are expressed. Reference groups instead of CIDRs, compose small single-purpose groups, keep shared address sets in prefix lists, restrict egress where it matters, and leave the default group empty. Use NACLs sparingly for explicit denies and coarse guardrails. Then enforce the baseline centrally and audit it, because the real scaling problem is never the feature, it's rules that nobody can account for.
