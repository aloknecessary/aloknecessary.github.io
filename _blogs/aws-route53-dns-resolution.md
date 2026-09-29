---
title: "DNS in AWS: Route 53 Resolver, Private Hosted Zones, and Hybrid Resolution"
date: 2026-09-22
last_modified_at: 2026-09-22T13:40:26+05:30
author: Alok Ranjan Daftuar
description: "How DNS resolution actually works inside a VPC, and what has to be built deliberately to make it work across VPCs, accounts, and hybrid Azure/AWS environments using Route 53 Resolver and private hosted zones."
excerpt: "Connectivity at the routing layer and name resolution are two separate problems, solved by two separate systems — and every earlier article in this series has been quietly deferring the second one."
keywords: "route53, dns, private hosted zone, route53 resolver, hybrid dns, aws networking, vpc dns, cross-account dns"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [route53, dns, resolver, private-hosted-zone, hybrid-dns, privatelink]
series: "AWS Network Architecture"
series_order: 5
---

Three earlier articles in this series each hit the same wall and moved past it without fully resolving it. [VPC Endpoints](/blogs/aws-vpc-endpoints-gateway-vs-interface/) needed `private_dns_enabled` to make an Interface endpoint transparent to application code. [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/) noted that DNS resolution across a peering connection needs its own explicit setting, separate from the routing itself. [Multi-Account Networking](/blogs/aws-multi-account-networking/) flagged that centralized Transit Gateway spoke accounts don't automatically share DNS resolution scope the way Shared VPC accounts do. This article is the piece all three were pointing toward: how DNS resolution actually works inside a VPC, and what has to be built deliberately to make it work across VPCs, accounts, and — for anyone running a migration in parallel with this series — a hybrid Azure/AWS environment.

## The default: what a VPC resolves out of the box

Every VPC gets a built-in DNS resolver, reachable at the VPC's base CIDR address plus two — for `10.0.0.0/16`, that's `10.0.0.2`. This isn't a resource you provision; it's provided automatically the moment the VPC exists, and it's what instances use by default via the VPC's DHCP option set.

```bash
# From inside an EC2 instance
cat /etc/resolv.conf
# nameserver 10.0.0.2

nslookup s3.ap-south-1.amazonaws.com 10.0.0.2
```

This default resolver handles three things without any additional configuration: public DNS resolution (forwarding out to the internet the normal way), resolution of AWS service endpoints, and resolution of any private hosted zone associated with that specific VPC. That third one is where most of this article lives — it works cleanly for a single VPC, and requires deliberate extra infrastructure the moment more than one VPC needs to share the same private namespace.

## Private hosted zones: DNS scoped to a VPC, not the internet

A Route 53 private hosted zone is a DNS zone that only resolves for VPCs it's explicitly associated with — it never appears in public DNS at all. This is the mechanism behind `private_dns_enabled` on an Interface endpoint from the earlier article: AWS creates and manages a private hosted zone on your behalf, associates it with the VPC the endpoint lives in, and that association is what makes the service's standard public name resolve to the endpoint's private IP for anything inside that VPC.

You can build the same pattern for your own internal services:

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

An instance in `vpc.main` resolving `db.internal.example.com` gets the private record. An instance in any other VPC, or anything outside AWS entirely, gets NXDOMAIN — the zone simply doesn't exist from that vantage point, by design.

## Associating a private hosted zone with more than one VPC

This is the first real extension past the single-VPC default, and it's the piece that makes private hosted zones actually useful in a Shared VPC or centralized Transit Gateway architecture, both covered in the multi-account article. A private hosted zone can be associated with multiple VPCs — including VPCs in other AWS accounts, which is exactly the cross-account DNS gap the multi-account article flagged for the centralized Transit Gateway model specifically.

```hcl
# In the zone-owning account
resource "aws_route53_zone_association" "spoke_a" {
  zone_id = aws_route53_zone.internal.zone_id
  vpc_id  = "vpc-0spokeA1234"
}
```

Cross-account association requires an authorization step from the zone-owning account before the spoke account's association will take effect — this is a deliberate security gate, not an oversight, since without it any account could silently attach itself to another account's internal DNS namespace:

```bash
# In the zone-owning account, authorize the spoke account/VPC first
aws route53 create-vpc-association-authorization \
  --hosted-zone-id Z0ABC123DEF \
  --vpc VPCRegion=ap-south-1,VPCId=vpc-0spokeA1234

# Then, in the spoke account, complete the association
aws route53 associate-vpc-with-hosted-zone \
  --hosted-zone-id Z0ABC123DEF \
  --vpc VPCRegion=ap-south-1,VPCId=vpc-0spokeA1234
```

This two-step authorize-then-associate pattern is the answer to the exact gap the multi-account article left open: for a centralized Transit Gateway model where every spoke account has its own VPC, associating each spoke VPC with a shared private hosted zone owned by the network account gives every spoke uniform resolution of internal names — filling in the DNS layer that Transit Gateway's routing alone doesn't provide.

## Route 53 Resolver: the piece for anything beyond simple association

Zone association solves internal-name resolution *within* AWS. It doesn't solve two other common requirements: resolving AWS-side private DNS names from outside AWS (an on-prem network, or — directly relevant to anyone running the migration work referenced elsewhere on this blog — an Azure VNet during a phased migration), or resolving on-prem/Azure DNS names from inside a VPC. Both directions need **Route 53 Resolver endpoints**.

```text
                    Route 53 Resolver
              ┌─────────────────────────┐
              │                          │
   Inbound    │   Outbound endpoint      │   Outbound
   endpoint ──┤   (VPC → external DNS)   │
   (external  │                          │
   → VPC)     │   Inbound endpoint       │
              │   (external → VPC)       │
              └─────────────────────────┘
                shared-services VPC
                         │
        ┌────────────────┼────────────────┐
        │                │                 │
   spoke VPC A      spoke VPC B      Azure VNet
   (via TGW)         (via TGW)      (via VPN/ExpressRoute)
```

An **inbound endpoint** gives external resolvers — a DNS server on Azure, or on-prem — a private IP inside the VPC to send queries to, letting them resolve AWS-side private hosted zone records. An **outbound endpoint** does the reverse: it lets resolvers inside the VPC forward specific domain queries out to an external DNS server, via **Resolver rules** that define which domains get forwarded where.

```hcl
resource "aws_route53_resolver_endpoint" "outbound" {
  name      = "resolver-outbound-to-azure"
  direction = "OUTBOUND"

  security_group_ids = [aws_security_group.resolver.id]

  ip_address {
    subnet_id = aws_subnet.shared_a.id
  }
  ip_address {
    subnet_id = aws_subnet.shared_b.id
  }
}

resource "aws_route53_resolver_rule" "to_azure" {
  domain_name          = "corp.internal.azure.example.com"
  rule_type            = "FORWARD"
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound.id

  target_ip {
    ip = "10.20.0.10"  # Azure private DNS resolver / custom DNS server IP
  }
}

resource "aws_route53_resolver_rule_association" "spoke_a" {
  resolver_rule_id = aws_route53_resolver_rule.to_azure.id
  vpc_id           = "vpc-0spokeA1234"
}
```

The rule association step matters as much as the rule itself — a Resolver rule that exists but isn't associated with a given VPC has no effect there, the same way a Transit Gateway route table that exists but isn't associated with an attachment does nothing for that attachment, from the peering/TGW article. Each spoke VPC that needs to resolve Azure-side names needs its own explicit association with the rule, not just proximity to a VPC that has one.

## The hybrid case: this migration's actual requirement

For a phased Azure-to-AWS migration — the scenario underlying this blog's separate Migration Playbook series — this Resolver pattern is exactly what closes the gap flagged in that series' CIDR planning article: a service already cut over to AWS needing to resolve a name still hosted on Azure, or vice versa, during the transition window. The inbound endpoint above gives Azure's DNS servers a path to resolve AWS-side private hosted zone records; the outbound endpoint and forwarding rule give AWS-side resolvers a path to Azure's private DNS. Both directions typically need to exist simultaneously during a real phased migration, not just one — services rarely migrate in a single wave, and dependencies between waves run in both directions until the migration is fully complete.

This only works once actual network connectivity exists between the two environments — VPN or ExpressRoute-equivalent — which is a prerequisite this article assumes rather than covers; DNS forwarding rules route name resolution queries, not general traffic, and they're only reachable once the underlying network path is already there.

## What breaks, and the order to check it in

DNS-across-boundaries failures share a common symptom — a name that resolves fine from one vantage point and fails or resolves to the wrong thing from another — and the check order that resolves this fastest:

1. **Is the private hosted zone associated with the VPC actually making the query?** The most common cause, and the same "did you actually associate it" check from the multi-account article's own DNS section — a zone can exist and be perfectly configured while simply not covering the VPC in question.
2. **For cross-account association, was the authorization step completed on the zone-owning side, not just the association attempted on the spoke side?** An association attempted without a matching authorization fails outright, and the error message doesn't always make this obviously the missing piece.
3. **For Resolver rules, is the rule associated with the specific VPC**, not just created? Same pattern as Transit Gateway route table association — existence isn't effect.
4. **Is a custom DHCP option set overriding the VPC's default resolver** in a way that bypasses the intended resolution path entirely — the same gotcha flagged in the VPC endpoints article's troubleshooting section, worth checking here too since it affects every DNS mechanism in this article, not just Interface endpoints specifically.
5. **For hybrid resolution specifically, is the underlying network path (VPN/ExpressRoute) actually up** — a Resolver rule pointing at an unreachable target IP fails the same way a route to a down peering connection does, and it's worth confirming the transport layer before assuming the DNS configuration itself is wrong.

## Sharing Resolver rules across accounts via RAM

Resolver rules follow the same centralized-ownership pattern as the Transit Gateway sharing covered in the multi-account article: a network account creates and owns the outbound endpoint and forwarding rules, then shares the rules to spoke accounts via AWS Resource Access Manager, so each spoke account associates the shared rule with its own VPC without needing to manage the endpoint infrastructure itself.

```hcl
resource "aws_ram_resource_share" "resolver_rules" {
  name                      = "ram-resolver-rules-to-azure"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "azure_rule" {
  resource_arn       = aws_route53_resolver_rule.to_azure.arn
  resource_share_arn = aws_ram_resource_share.resolver_rules.arn
}

resource "aws_ram_principal_association" "org_share" {
  principal          = data.aws_organizations_organization.this.arn
  resource_share_arn = aws_ram_resource_share.resolver_rules.arn
}
```

Sharing to the whole Organization ARN rather than individual account IDs — the same pattern used for the Transit Gateway share in the multi-account article — means a newly created spoke account can associate with the existing forwarding rule immediately, without a manual RAM step per new account. This is the standard shape for a centralized network account model generally: one team owns the Resolver endpoints, the Transit Gateway, and the shared private hosted zones; every other account just associates with what's already there.

## Query logging and a note on DNSSEC

Two adjacent Route 53 features worth knowing about even though they're not central to the resolution mechanics above. **Resolver query logging** captures every DNS query made through a VPC's resolver — useful for security investigation (what domains has this instance actually been resolving) and for debugging exactly the kind of cross-boundary resolution failures this article covers, since query logs show definitively whether a query left the VPC's resolver at all versus failing before ever reaching it:

```hcl
resource "aws_route53_resolver_query_log_config" "main" {
  name            = "resolver-query-log"
  destination_arn = aws_cloudwatch_log_group.dns_queries.arn
}

resource "aws_route53_resolver_query_log_config_association" "vpc" {
  resolver_query_log_config_id = aws_route53_resolver_query_log_config.main.id
  resource_id                   = aws_vpc.main.id
}
```

Enabling this on any VPC where DNS resolution across boundaries is expected to work reliably — a shared-services VPC hosting Resolver endpoints, in particular — turns a "why isn't this resolving" investigation from guesswork into a direct log lookup.

DNSSEC, by contrast, is largely orthogonal to everything in this article: it's a public DNS integrity feature for hosted zones serving public records, validating that DNS responses haven't been tampered with in transit across the public internet. It has no bearing on private hosted zone resolution or Resolver-based hybrid forwarding, both of which operate entirely within AWS's private network fabric or over an already-authenticated VPN/ExpressRoute link — worth knowing it exists and what it's actually for, mainly so it isn't mistakenly reached for as a fix to a private-resolution problem it was never designed to address.

## A side-by-side summary of the mechanisms

| Mechanism | Solves | Scope |
| --- | --- | --- |
| Default VPC resolver | Public DNS + AWS services + own VPC's private zones | Single VPC |
| Private hosted zone, single VPC | Internal names, one VPC | Single VPC |
| Private hosted zone, multi-VPC association | Internal names shared across VPCs/accounts | Any number of associated VPCs |
| Resolver inbound endpoint | External resolvers querying into AWS private zones | VPC ↔ external network |
| Resolver outbound endpoint + rules | AWS-side resolvers querying external DNS | VPC ↔ external network |

## Why this belongs at this point in the series

Every mechanism in this article assumes the network-layer connectivity covered earlier in the series already exists — Transit Gateway attachments, peering connections, or hybrid VPN/ExpressRoute links. DNS never substitutes for routing, and routing never substitutes for DNS; they're independent layers that both have to be built correctly, and it's entirely possible — common, even — to have flawless connectivity at one layer and a completely broken experience at the other, which is exactly why three separate earlier articles in this series each ran into this same gap before it had its own treatment.

> 📌 **Key Takeaway**: A VPC's default resolver only covers that one VPC's own private hosted zones out of the box — everything beyond that (multi-VPC association, cross-account sharing, hybrid resolution against Azure or on-prem) requires deliberate infrastructure: zone association with authorization for cross-account cases, and Route 53 Resolver inbound/outbound endpoints with explicit rule associations for anything crossing outside AWS entirely. Treat DNS resolution scope as its own explicit design decision alongside routing, not something that follows automatically once connectivity exists.
