---
layout: post
title: "Site-to-Site VPN vs Direct Connect: Hybrid Connectivity Is a Choice of Kind, Not Speed"
series: "AWS Network Architecture"
date: 2026-10-29
categories: [aws, networking, cloud-architecture]
tags: [site-to-site-vpn, direct-connect, bgp, hybrid-networking, transit-gateway, direct-connect-gateway]
excerpt: "VPN and Direct Connect aren't a starter tier and an upgrade tier. One is encrypted tunnels over the public internet; the other is a private physical link with no encryption by default. The choice follows from that difference, not from the bandwidth number."
---

The usual framing is that a Site-to-Site VPN is what you use until you're big enough to justify Direct Connect. It's a tidy story, and it hides the actual decision. The two differ in kind: a VPN is IPsec tunnels riding the public internet, encrypted but subject to internet path variability, while Direct Connect is a dedicated private circuit with consistent latency and, perhaps surprisingly, no encryption unless you add it. Picking by bandwidth alone misses the questions that usually decide the matter: how long you can wait for the link, what happens when it fails, and whether your compliance posture requires encryption in transit.

This article assumes the building blocks from earlier in the series. Route tables and most-specific-route-wins come from [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/). Both connectivity types terminate most cleanly on the Transit Gateway covered in [VPC Peering vs Transit Gateway](/blogs/aws-vpc-peering-vs-transit-gateway/), and the central-network-account ownership model from [Multi-Account Networking](/blogs/aws-multi-account-networking/) is where these resources normally live. The [DNS article](/blogs/route53-dns-resolution-hybrid-networking/) assumed hybrid connectivity already existed; this is the piece that builds it.

## The shape of each option

```
Site-to-Site VPN                          Direct Connect

On-prem / Azure                           On-prem / Azure
   │ customer gateway                        │ router
   │                                         │ dedicated or hosted circuit
   ├── tunnel 1 (IPsec, internet) ──┐        │ (colocation / DX location)
   └── tunnel 2 (IPsec, internet) ──┤        └── virtual interface (VIF)
                                    ▼                       ▼
                          VGW or Transit Gateway    Direct Connect gateway
                                                     → VGW or Transit Gateway
```

A VPN connection always has **two tunnels**, terminating on two different AWS endpoints, so a single connection already gives you a degree of redundancy on the AWS side. Direct Connect has no equivalent built in: a single connection is a single physical link, and resilience is something you design by adding more of them.

## Site-to-Site VPN in detail

### The three resources

A VPN needs a **customer gateway** (an AWS resource that describes your on-premises or other-cloud device: its public IP and BGP ASN), a **VPN connection**, and a **termination point** on the AWS side. That termination point is the first real decision, because it determines what the VPN can do later.

| Termination point | Scope | Notable capability | Limitation |
|---|---|---|---|
| Virtual private gateway (VGW) | Attached to one VPC | Simple, no extra hourly attachment charge | One VPC only; no ECMP |
| Transit Gateway | Hub for many VPCs | ECMP across tunnels, central route tables, shared via RAM | Per-attachment and per-GB charges |

For a single VPC with modest needs, a VGW is fine. For anything that will eventually serve several VPCs or accounts, terminating on a Transit Gateway avoids rebuilding the connectivity later, which is the same retrofit problem the peering and Transit Gateway article warned about.

```hcl
resource "aws_customer_gateway" "datacenter" {
  bgp_asn    = 65010
  ip_address = "203.0.113.10"   # public IP of the on-prem/Azure-side device
  type       = "ipsec.1"

  tags = { Name = "cgw-datacenter-a" }
}

resource "aws_vpn_connection" "to_tgw" {
  customer_gateway_id = aws_customer_gateway.datacenter.id
  transit_gateway_id  = aws_ec2_transit_gateway.main.id
  type                = aws_customer_gateway.datacenter.type
  static_routes_only  = false   # dynamic routing over BGP

  tunnel1_ike_versions = ["ikev2"]
  tunnel2_ike_versions = ["ikev2"]

  tags = { Name = "vpn-datacenter-a-tgw" }
}
```

The VGW equivalent, for the single-VPC case, adds route propagation so learned routes appear in the VPC's route table automatically:

```hcl
resource "aws_vpn_gateway" "main" {
  vpc_id          = aws_vpc.main.id
  amazon_side_asn = 64512
}

resource "aws_vpn_gateway_route_propagation" "private" {
  vpn_gateway_id = aws_vpn_gateway.main.id
  route_table_id = aws_route_table.private.id
}
```

### BGP or static routing

Prefer BGP (dynamic routing) wherever the customer device supports it. With BGP, a failed tunnel withdraws its routes and traffic shifts to the surviving tunnel without anyone touching a route table. With static routing, you maintain the prefix list on both sides by hand and failover behaviour is coarser. BGP also gives you the foundation for the Direct Connect failover pattern covered below.

### What limits a VPN

Each tunnel is capped at roughly 1.25 Gbps, and a single flow is limited to one tunnel. A VGW-terminated connection therefore tops out around that figure per flow. On a Transit Gateway, you can run multiple VPN connections with BGP and use **ECMP** to spread traffic across tunnels and aggregate bandwidth, though each individual flow still rides one tunnel. Two more practical limits show up in real deployments: the encapsulation overhead means the effective MTU is below 1500, so MSS clamping is worth configuring on the customer device to avoid fragmentation, and the number of routes you can advertise over a BGP session is quota-limited, so summarise prefixes instead of advertising every subnet individually.

### Monitoring tunnel state

A VPN that's silently running on one of its two tunnels looks healthy until the second one drops. Check both, and alarm on it:

```bash
aws ec2 describe-vpn-connections \
  --query 'VpnConnections[].{Id:VpnConnectionId,Tunnels:VgwTelemetry[].{Outside:OutsideIpAddress,Status:Status,Routes:AcceptedRouteCount}}' \
  --output json
```

```hcl
resource "aws_cloudwatch_metric_alarm" "vpn_degraded" {
  alarm_name          = "vpn-datacenter-a-degraded"
  namespace           = "AWS/VPN"
  metric_name         = "TunnelState"
  dimensions          = { VpnId = aws_vpn_connection.to_tgw.id }
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1          # below 1 means at least one tunnel is not UP
  evaluation_periods  = 3
  period              = 60
}
```

Alarming on "less than fully up" rather than "fully down" is the point. By the time both tunnels are down, you've already lost the redundancy you were paying for and the outage has begun.

## Direct Connect in detail

### Connection types

A **dedicated connection** is a physical port allocated to you at a Direct Connect location, offered at 1, 10, and 100 Gbps. A **hosted connection** is provisioned by an AWS partner on their own capacity at a wider range of speeds, including much smaller ones, which suits workloads that need a private link but not a full port. In either case there's a physical component: a cross-connect at a colocation facility, a letter of authorisation, and a partner or carrier in the middle. That's why Direct Connect is measured in weeks, where a VPN is measured in minutes.

### Virtual interfaces

The physical link carries one or more **virtual interfaces (VIFs)**, each a BGP session with a specific purpose:

| VIF type | Reaches | Use |
|---|---|---|
| Private VIF | A VPC, via a VGW or Direct Connect gateway | Private connectivity to a VPC's private addresses |
| Transit VIF | Transit Gateways, via a Direct Connect gateway | Hub-and-spoke access to many VPCs |
| Public VIF | AWS public service endpoints | Reaching S3 or other public AWS endpoints over the private link |

### The Direct Connect gateway

A **Direct Connect gateway** is a global construct that lets one connection reach VPCs or Transit Gateways across regions and accounts. In the central-network-account model, it sits alongside the Transit Gateway and is associated with it, with `allowed_prefixes` controlling which of your AWS-side prefixes are advertised back over the link:

```hcl
resource "aws_dx_gateway" "central" {
  name            = "dxgw-central"
  amazon_side_asn = 64513    # must differ from the Transit Gateway's own ASN
}

resource "aws_dx_gateway_association" "to_tgw" {
  dx_gateway_id         = aws_dx_gateway.central.id
  associated_gateway_id = aws_ec2_transit_gateway.main.id

  allowed_prefixes = [
    "10.0.0.0/16",
    "10.1.0.0/16",
  ]
}
```

The `allowed_prefixes` list is worth treating as a deliberate allowlist. It defines exactly what your on-premises or Azure side learns about the AWS network, so it's both a routing control and a small security boundary.

```bash
aws directconnect describe-virtual-interfaces \
  --query 'virtualInterfaces[].{Id:virtualInterfaceId,Type:virtualInterfaceType,State:virtualInterfaceState,BGP:bgpPeers[].bgpStatus}' \
  --output json
```

### Direct Connect is not encrypted by default

This catches teams who equate "private" with "encrypted." Traffic on a Direct Connect circuit travels over a dedicated path, not the public internet, but it isn't encrypted unless you make it so. If your requirements demand encryption in transit, you have two main options: MACsec, available on supported dedicated connections at higher speeds, or running an IPsec VPN over the Direct Connect link itself. The second approach gives you encryption on a private path at the cost of the VPN's throughput ceiling, and it's worth deciding before the circuit is ordered rather than after a compliance review asks.

## Combining them: Direct Connect primary, VPN backup

The most common production pattern isn't either one alone. A Direct Connect circuit carries the steady traffic, and a Site-to-Site VPN stands by as a backup path over the internet. Because both advertise the same prefixes over BGP, the failover is automatic when routing is set up correctly.

```
On-prem / Azure ──── Direct Connect (preferred) ────┐
        │                                            ├── Transit Gateway ── VPCs
        └────── Site-to-Site VPN (backup) ───────────┘
```

AWS prefers a Direct Connect path over a VPN path for the same prefix, so the VPN carries traffic only when the Direct Connect route is withdrawn. Two details matter here. Route selection still begins with longest-prefix match, as in the fundamentals article, so if you advertise a more specific prefix over the VPN than over Direct Connect, the VPN will win for that range regardless of the preference between the two types. And the on-premises side needs its own consistent preference, usually via local preference or AS path prepending, so return traffic takes the same path. An asymmetric setup, where outbound goes one way and returns another, is a classic cause of stateful firewalls dropping connections.

Test the failover deliberately. A backup path that has never carried traffic is an assumption, and the first time you learn it doesn't work shouldn't be during a real circuit failure.

## Resilience: what "redundant" actually means

A single Direct Connect connection is a single point of failure at the port, the cross-connect, and the location. AWS describes tiers of resilience that run from one connection at one location, through connections at two locations, up to fully separate connections at separate devices and locations. The right tier depends on what an outage costs you. For critical workloads, two connections at two locations plus a VPN as a third path is a reasonable shape. For anything where a few hours of reduced connectivity is tolerable, a single connection with a VPN backup is often enough, and cheaper.

## Choosing between them

| Consideration | Site-to-Site VPN | Direct Connect |
|---|---|---|
| Time to provision | Minutes to hours | Weeks to months |
| Path | Public internet | Private dedicated circuit |
| Encryption | IPsec, built in | None by default; MACsec or IPsec over it |
| Latency and jitter | Variable with internet path | Consistent |
| Bandwidth | About 1.25 Gbps per tunnel; aggregate with ECMP on Transit Gateway | 1 to 100 Gbps dedicated; partner speeds lower |
| Cost shape | Hourly per connection plus data transfer | Port-hours plus lower per-GB transfer, plus carrier and colocation costs |
| Redundancy | Two tunnels per connection | Designed by adding connections and locations |
| Good fit | Getting connected quickly, backup path, modest or bursty traffic | Sustained high volume, latency-sensitive traffic, large data transfer |

On cost, the crossover isn't a fixed traffic number. VPN is cheap to hold and charges for data transfer at the standard rate; Direct Connect has a fixed port cost and carrier fees but a lower per-GB rate, so it wins when volume is high and steady. Run the numbers on your actual transfer volume rather than assuming the dedicated link is automatically cheaper.

## Cross-cloud: connecting an Azure environment

For a phased migration from Azure, the AWS-side options above apply unchanged. What differs is the other end. The usual starting point is a Site-to-Site VPN between an Azure VPN gateway and the AWS Transit Gateway, which can be up quickly and carries the DNS forwarding traffic described in the DNS article. A private circuit between the two clouds typically goes through a shared colocation facility or a connectivity provider rather than a direct link. Whichever you choose, the address spaces have to be reconciled first: overlapping CIDRs make any of this unusable, which is the central point of the [CIDR planning article](/blogs/aws-migration-cidr-planning/) in the Migration Playbook series.

## Troubleshooting, in order

When hybrid connectivity fails, work from the bottom up:

1. **Is the tunnel or BGP session up?** Check `VgwTelemetry` for VPN, or the VIF's BGP status for Direct Connect. A down session explains everything above it.
2. **Are routes being exchanged?** A session can be up with zero accepted routes. Check the accepted route count, and on the Direct Connect side check `allowed_prefixes`.
3. **Do the route tables use them?** For a VGW, confirm route propagation is enabled on the right route table. For a Transit Gateway, confirm the attachment is associated with, and propagating to, the intended TGW route table.
4. **Is anything overlapping?** Overlapping CIDRs produce confusing partial connectivity, since the more specific local route wins.
5. **Are security groups and NACLs allowing it?** Same as any other path; the link being up says nothing about whether the traffic is permitted.
6. **Is the failure MTU-shaped?** Small packets work, large transfers stall. That pattern points at fragmentation over the VPN, and MSS clamping on the customer device is the fix.
7. **Is it asymmetric?** Outbound works, replies vanish. Check that both sides prefer the same path.

> 📌 **Key Takeaway**: VPN and Direct Connect differ in kind, not just speed. VPN is encrypted IPsec over the internet, up in minutes, capped per tunnel; Direct Connect is a private dedicated circuit with consistent performance, weeks to provision, and no encryption unless you add MACsec or an IPsec overlay. Terminate on a Transit Gateway if more than one VPC will ever need the link, use BGP so failover is automatic, and for anything important run Direct Connect as primary with a VPN as a tested backup. Decide on encryption and resilience tier before ordering a circuit, not after.
