---
title: "Site-to-Site VPN vs Direct Connect: Hybrid Connectivity Is a Choice of Kind, Not Speed"
published: false
description: VPN and Direct Connect differ in kind — one is encrypted IPsec over the internet, the other is a private dedicated circuit with no encryption by default. The choice follows from that difference.
tags: aws, networking, cloud, devops
canonical_url: https://aloknecessary.in/blogs/site-to-site-vpn-vs-direct-connect-hybrid-connectivity/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=site-to-site-vpn-vs-direct-connect-hybrid-connectivity
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of two parallel data paths converging into a cloud hub — one path glowing with encrypted tunnel segments over a public internet grid, the other a clean dedicated fiber line bypassing the noise entirely. The two paths merge at a central transit node. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

The usual framing is that a Site-to-Site VPN is what you use until you're big enough to justify Direct Connect. That framing hides the actual decision. The two differ in kind: a VPN is IPsec tunnels riding the public internet — encrypted but subject to internet path variability — while Direct Connect is a dedicated private circuit with consistent latency and, perhaps surprisingly, no encryption unless you add it.

Picking by bandwidth alone misses the questions that usually decide the matter: how long you can wait for the link, what happens when it fails, and whether your compliance posture requires encryption in transit.

---

## The Shape of Each Option

```text
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

A VPN connection always has **two tunnels** terminating on two different AWS endpoints — a single connection already gives you redundancy on the AWS side. Direct Connect has no equivalent built in: a single connection is a single physical link, and resilience is something you design by adding more of them.

## Site-to-Site VPN: Termination Point Is the First Decision

A VPN needs three things: a **customer gateway** (describes your on-prem device — its public IP and BGP ASN), a **VPN connection**, and a termination point on the AWS side.

| Termination point | Scope | Notable capability | Limitation |
| --- | --- | --- | --- |
| Virtual private gateway (VGW) | One VPC | Simple, no extra attachment charge | One VPC only; no ECMP |
| Transit Gateway | Hub for many VPCs | ECMP across tunnels, central route tables | Per-attachment and per-GB charges |

For anything that will eventually serve several VPCs or accounts, terminating on a Transit Gateway avoids rebuilding connectivity later.

```hcl
resource "aws_vpn_connection" "to_tgw" {
  customer_gateway_id = aws_customer_gateway.datacenter.id
  transit_gateway_id  = aws_ec2_transit_gateway.main.id
  type                = "ipsec.1"
  static_routes_only  = false   # dynamic routing over BGP

  tunnel1_ike_versions = ["ikev2"]
  tunnel2_ike_versions = ["ikev2"]
}
```

Prefer BGP over static routing wherever the customer device supports it. With BGP, a failed tunnel withdraws its routes and traffic shifts to the surviving tunnel automatically. With static routing, failover is manual.

### Alarm on Degraded, Not Down

```hcl
resource "aws_cloudwatch_metric_alarm" "vpn_degraded" {
  alarm_name          = "vpn-datacenter-a-degraded"
  namespace           = "AWS/VPN"
  metric_name         = "TunnelState"
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1   # below 1 = at least one tunnel not UP
  evaluation_periods  = 3
  period              = 60
}
```

By the time both tunnels are down, you've already lost the redundancy you were paying for.

## Direct Connect: Private Does Not Mean Encrypted

A **dedicated connection** is a physical port at a Direct Connect location (1, 10, or 100 Gbps). A **hosted connection** is provisioned by an AWS partner at smaller speeds. Either way there's a physical component — a cross-connect, a letter of authorisation, a carrier. That's why Direct Connect is measured in weeks, where a VPN is measured in minutes.

The physical link carries **virtual interfaces (VIFs)**, each a BGP session:

| VIF type | Reaches | Use |
| --- | --- | --- |
| Private VIF | A VPC via VGW or DX gateway | Private connectivity to VPC addresses |
| Transit VIF | Transit Gateways via DX gateway | Hub-and-spoke access to many VPCs |
| Public VIF | AWS public service endpoints | S3 and other public endpoints over the private link |

**Direct Connect is not encrypted by default.** Traffic travels over a dedicated path, not the public internet, but it isn't encrypted unless you add MACsec (on supported dedicated connections) or run an IPsec VPN over the Direct Connect link itself.

### The Direct Connect Gateway and `allowed_prefixes`

```hcl
resource "aws_dx_gateway_association" "to_tgw" {
  dx_gateway_id         = aws_dx_gateway.central.id
  associated_gateway_id = aws_ec2_transit_gateway.main.id

  allowed_prefixes = [
    "10.0.0.0/16",
    "10.1.0.0/16",
  ]
}
```

`allowed_prefixes` is both a routing control and a security boundary — it defines exactly what your on-premises side learns about the AWS network.

## The Production Pattern: Direct Connect Primary, VPN Backup

```text
On-prem / Azure ──── Direct Connect (preferred) ────┐
        │                                            ├── Transit Gateway ── VPCs
        └────── Site-to-Site VPN (backup) ───────────┘
```

AWS prefers a Direct Connect path over a VPN path for the same prefix, so the VPN carries traffic only when the Direct Connect route is withdrawn. Two details matter:

- Route selection still begins with longest-prefix match — a more specific prefix over VPN wins regardless of path preference.
- The on-premises side needs its own consistent preference (local preference or AS path prepending) so return traffic takes the same path. Asymmetric routing causes stateful firewalls to drop connections.

**Test the failover deliberately.** A backup path that has never carried traffic is an assumption.

## Choosing Between Them

| Consideration | Site-to-Site VPN | Direct Connect |
| --- | --- | --- |
| Time to provision | Minutes to hours | Weeks to months |
| Path | Public internet | Private dedicated circuit |
| Encryption | IPsec, built in | None by default |
| Latency | Variable | Consistent |
| Bandwidth | ~1.25 Gbps per tunnel; aggregate with ECMP | 1–100 Gbps dedicated |
| Good fit | Quick start, backup path, bursty traffic | Sustained high volume, latency-sensitive, large transfers |

On cost: VPN is cheap to hold; Direct Connect has fixed port and carrier costs but lower per-GB rates. The crossover depends on your actual transfer volume — don't assume the dedicated link is automatically cheaper.

## Troubleshooting Order

1. Is the tunnel or BGP session up?
2. Are routes being exchanged? (A session can be up with zero accepted routes.)
3. Do the route tables use them? (Check propagation for VGW; check TGW route table association for Transit Gateway.)
4. Is anything overlapping? (More specific local route wins silently.)
5. Are security groups and NACLs allowing it?
6. Is the failure MTU-shaped? (Small packets work, large transfers stall — MSS clamping fix.)
7. Is it asymmetric? (Outbound works, replies vanish — check path preference on both sides.)

---

## Read the Full Article

The full post covers:

- Complete Terraform for customer gateway, VPN connection, VGW route propagation, and Direct Connect gateway association
- ECMP configuration on Transit Gateway for bandwidth aggregation
- MACsec vs IPsec-over-DX encryption trade-offs
- AWS resilience tiers for Direct Connect (single location → two locations → fully redundant)
- Cross-cloud Azure-to-AWS connectivity patterns and CIDR reconciliation
- Full troubleshooting walkthrough with CLI commands

**👉 [Site-to-Site VPN vs Direct Connect: Hybrid Connectivity Is a Choice of Kind, Not Speed — Full Article](https://aloknecessary.in/blogs/site-to-site-vpn-vs-direct-connect-hybrid-connectivity/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=site-to-site-vpn-vs-direct-connect-hybrid-connectivity)**
