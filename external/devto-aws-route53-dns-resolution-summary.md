---
title: "DNS in AWS: Route 53 Resolver, Private Hosted Zones, and Hybrid Resolution"
published: false
description: How DNS resolution works inside a VPC, and what has to be built deliberately to make it work across VPCs, accounts, and hybrid Azure/AWS environments.
tags: aws, networking, dns, devops
canonical_url: https://aloknecessary.in/blogs/aws-route53-dns-resolution/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-route53-dns-resolution
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a layered DNS resolution system — glowing query paths branching outward from a central VPC resolver node, splitting into private hosted zones, inbound and outbound resolver endpoints, and hybrid forwarding paths toward an external cloud network. The visual suggests intelligent, directional name resolution flowing across cloud boundaries. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Three earlier articles in the AWS Network Architecture series each hit the same wall and moved past it: VPC Endpoints needed `private_dns_enabled` to work transparently. VPC Peering noted that DNS resolution across a peering connection needs its own explicit setting. Multi-Account Networking flagged that Transit Gateway spoke accounts don't automatically share DNS resolution scope. This article is the piece all three were pointing toward.

Connectivity at the routing layer and name resolution are two separate problems. It's entirely possible — common, even — to have flawless routing and completely broken DNS, or vice versa. Both layers have to be built correctly, and this article covers the DNS side end to end.

---

## The Default: What a VPC Resolves Out of the Box

Every VPC gets a built-in DNS resolver at its base CIDR plus two — for `10.0.0.0/16`, that's `10.0.0.2`. It's provided automatically, no provisioning required.

```bash
# From inside an EC2 instance
cat /etc/resolv.conf
# nameserver 10.0.0.2

nslookup s3.ap-south-1.amazonaws.com 10.0.0.2
```

This default resolver handles three things without any additional configuration: public DNS, AWS service endpoints, and any private hosted zone associated with that specific VPC. That third one is where most of this article lives — it works cleanly for a single VPC, and requires deliberate extra infrastructure the moment more than one VPC needs to share the same private namespace.

## Private Hosted Zones: DNS Scoped to a VPC

A Route 53 private hosted zone only resolves for VPCs it's explicitly associated with — it never appears in public DNS. This is the mechanism behind `private_dns_enabled` on Interface endpoints: AWS creates a private hosted zone, associates it with the endpoint's VPC, and that association makes the service's standard public name resolve to the endpoint's private IP.

```hcl
resource "aws_route53_zone" "internal" {
  name = "internal.example.com"

  vpc {
    vpc_id = aws_vpc.main.id
  }
}

resource "aws_route53_record" "app_db" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = "db.internal.example.com"
  type    = "A"
  ttl     = 300
  records = [aws_db_instance.main.address]
}
```

An instance outside the associated VPC gets NXDOMAIN — the zone simply doesn't exist from that vantage point, by design.

## Cross-Account Zone Association

A private hosted zone can be associated with VPCs in other AWS accounts. Cross-account association requires an explicit authorization step from the zone-owning account first — a deliberate security gate so no account can silently attach to another account's internal DNS namespace:

```bash
# Zone-owning account: authorize the spoke VPC
aws route53 create-vpc-association-authorization \
  --hosted-zone-id Z0ABC123DEF \
  --vpc VPCRegion=ap-south-1,VPCId=vpc-0spokeA1234

# Spoke account: complete the association
aws route53 associate-vpc-with-hosted-zone \
  --hosted-zone-id Z0ABC123DEF \
  --vpc VPCRegion=ap-south-1,VPCId=vpc-0spokeA1234
```

This two-step authorize-then-associate pattern fills the DNS gap that Transit Gateway routing alone doesn't provide in a centralized multi-account model.

## Route 53 Resolver: For Anything Crossing Outside AWS

Zone association solves internal-name resolution within AWS. It doesn't solve resolving AWS-side private DNS names from outside AWS, or resolving on-prem/Azure DNS names from inside a VPC. Both directions need Route 53 Resolver endpoints.

An **inbound endpoint** gives external resolvers a private IP inside the VPC to send queries to. An **outbound endpoint** with forwarding rules lets VPC-side resolvers forward specific domain queries out to an external DNS server:

```hcl
resource "aws_route53_resolver_endpoint" "outbound" {
  name      = "resolver-outbound-to-azure"
  direction = "OUTBOUND"

  security_group_ids = [aws_security_group.resolver.id]

  ip_address { subnet_id = aws_subnet.shared_a.id }
  ip_address { subnet_id = aws_subnet.shared_b.id }
}

resource "aws_route53_resolver_rule" "to_azure" {
  domain_name          = "corp.internal.azure.example.com"
  rule_type            = "FORWARD"
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound.id

  target_ip {
    ip = "10.20.0.10"  # Azure private DNS resolver IP
  }
}

resource "aws_route53_resolver_rule_association" "spoke_a" {
  resolver_rule_id = aws_route53_resolver_rule.to_azure.id
  vpc_id           = "vpc-0spokeA1234"
}
```

The rule association step matters as much as the rule itself — a Resolver rule that exists but isn't associated with a given VPC has no effect there.

## Sharing Resolver Rules Across Accounts via RAM

Resolver rules follow the same centralized-ownership pattern as Transit Gateway sharing: a network account creates and owns the outbound endpoint and forwarding rules, then shares them to spoke accounts via AWS Resource Access Manager:

```hcl
resource "aws_ram_resource_share" "resolver_rules" {
  name                      = "ram-resolver-rules-to-azure"
  allow_external_principals = false
}

resource "aws_ram_principal_association" "org_share" {
  principal          = data.aws_organizations_organization.this.arn
  resource_share_arn = aws_ram_resource_share.resolver_rules.arn
}
```

Sharing to the whole Organization ARN means a newly created spoke account can associate with the existing forwarding rule immediately, without a manual RAM step per new account.

## The Failure Checklist

DNS-across-boundaries failures share a common symptom — a name that resolves fine from one vantage point and fails from another. Check in this order:

1. Is the private hosted zone actually associated with the VPC making the query?
2. For cross-account association, was the authorization step completed on the zone-owning side?
3. For Resolver rules, is the rule associated with the specific VPC — not just created?
4. Is a custom DHCP option set overriding the VPC's default resolver?
5. For hybrid resolution, is the underlying VPN/network path actually up?

---

## Read the Full Article

The full post covers additional depth on:

- The complete side-by-side mechanism summary table (default resolver vs. zone association vs. Resolver endpoints)
- Resolver query logging with Terraform — turning DNS debugging from guesswork into a direct log lookup
- Why DNSSEC is orthogonal to everything in this article and what it's actually for
- How this connects to the hybrid Azure/AWS migration scenario from the Migration Playbook series — both inbound and outbound resolution directions needed simultaneously during a phased migration

**👉 [DNS in AWS: Route 53 Resolver, Private Hosted Zones, and Hybrid Resolution — Full Article](https://aloknecessary.in/blogs/aws-route53-dns-resolution/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-route53-dns-resolution)**
