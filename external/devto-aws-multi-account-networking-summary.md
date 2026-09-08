---
title: "Multi-Account AWS Networking: Shared VPC, RAM, and the Hub-and-Spoke Model"
published: false
description: Two models for multi-account AWS networking — Shared VPC and centralized Transit Gateway — answer the ownership question differently. Here's how to choose.
tags: aws, networking, devops, cloud
canonical_url: https://aloknecessary.in/blogs/aws-multi-account-networking/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-multi-account-networking
cover_image:
---

Once an AWS Organization crosses a handful of accounts, the question stops being how to connect VPCs and becomes who owns the network at all. Two genuinely different models answer that question differently — Shared VPC and centralized Transit Gateway — and picking the wrong one early is expensive to unwind later.

This post maps both models: what each centralizes, what each delegates, where each breaks down, and how to choose between them based on what your Organization actually needs.

---

## Model 1: Shared VPC

Shared VPC uses AWS Resource Access Manager to let one account (typically a central network account) own a VPC and share specific subnets with other accounts. Those accounts launch resources directly into the shared subnets — EC2, RDS, Lambda in VPC mode — without creating a VPC of their own.

```hcl
# Network account: share a subnet with a spoke account
resource "aws_ram_resource_share" "vpc_share" {
  name                      = "ram-shared-vpc-subnets"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "app_subnet" {
  resource_arn       = aws_subnet.shared_app_a.arn
  resource_share_arn = aws_ram_resource_share.vpc_share.arn
}

resource "aws_ram_principal_association" "app_account" {
  principal          = "222233334444"
  resource_share_arn = aws_ram_resource_share.vpc_share.arn
}
```

The network account retains ownership of route tables, NACLs, Internet Gateway, and NAT gateways. Spoke accounts cannot modify any of these — they can only launch resources into the subnets they've been given. Security groups are the one exception: each account creates and manages its own security groups for the resources it launches, even in a shared subnet.

This split — centralized routing and NACLs, decentralized security groups — defines how Shared VPC feels operationally: the network team owns "can traffic reach this subnet at all," and application teams own "can this specific instance be reached."

**Where it earns its complexity:** accounts that genuinely need to behave as if they're in the same network — shared load balancers, a common data tier, low-latency service-to-service calls. No Transit Gateway hop, no per-attachment cost.

**Where it breaks down:** everything sharing the VPC shares the same blast radius. A misconfigured NACL in the network account affects every spoke simultaneously. Two spoke accounts can reach each other's resources over the VPC's local route by default — isolation requires deliberate security group discipline that Transit Gateway's route table segmentation gives you structurally.

---

## Model 2: Centralized Transit Gateway (Hub-and-Spoke)

Each account owns its own full VPC. A central network account owns a Transit Gateway shared via RAM — every spoke account attaches its VPC to the shared TGW.

```hcl
# Network account: share TGW with the entire Organization
resource "aws_ec2_transit_gateway" "central" {
  description                     = "tgw-org-central"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
}

resource "aws_ram_principal_association" "org_share" {
  principal          = data.aws_organizations_organization.this.arn
  resource_share_arn = aws_ram_resource_share.tgw_share.arn
}
```

Sharing to the Organization ARN rather than individual account IDs means any new account added to the Organization can attach to the TGW without a manual RAM association step — important for Organizations still adding accounts regularly.

Each spoke account attaches independently:

```hcl
resource "aws_ec2_transit_gateway_vpc_attachment" "spoke" {
  subnet_ids         = [aws_subnet.app_private_a.id, aws_subnet.app_private_b.id]
  transit_gateway_id = "tgw-0abc123central"
  vpc_id             = aws_vpc.spoke.id
}
```

The network team's authority is limited to the TGW's own route tables. Everything inside each spoke VPC — CIDRs, route tables, security groups, NACLs — is fully owned by that account's team.

**The actual selling point:** TGW route table associations give you structural segmentation. A production route table, a non-production route table, and a shared-services route table each control a completely different set of reachable attachments. A spoke account has no ability to affect that segmentation from its side. This is the property Shared VPC can't cleanly replicate.

**The cost:** every spoke VPC is a full VPC — its own CIDR allocation, its own NAT gateway, its own VPC endpoints. For an Organization with many small accounts, this multiplies infrastructure cost significantly compared to a single shared VPC.

---

## The Comparison

| | Shared VPC | Centralized Transit Gateway |
| --- | --- | --- |
| VPC ownership | One VPC, centrally owned | Each account owns its own VPC |
| Segmentation between accounts | Requires security group discipline | Native, via TGW route table association |
| CIDR planning | One VPC's CIDR to manage | Every spoke needs non-overlapping CIDR |
| Cost | Lower — one NAT/endpoint fleet | Higher — NAT/endpoints multiplied per spoke |
| Best fit | Many small teams needing shared infrastructure access | Organizations needing strong trust-boundary segmentation |

---

## A Hybrid Pattern Worth Knowing

Keep each application account on its own full VPC connected via Transit Gateway, but put genuinely shared infrastructure — a central logging aggregator, an internal artifact registry, shared Active Directory — in its own dedicated VPC also attached to the same TGW. Every spoke gets low-friction access through normal TGW routing, gated by the same route table segmentation used for everything else. No ownership ambiguity about which application account "hosts" the shared infrastructure.

---

## DNS Across Account Boundaries

Routing connectivity doesn't automatically mean private DNS resolution works across accounts.

For Shared VPC this is largely a non-issue — spoke accounts are in the same VPC, so standard VPC DNS resolution covers everything uniformly.

For centralized TGW, each spoke has its own DNS scope. Cross-account private hosted zone resolution needs to be built deliberately — either through Route 53 Private Hosted Zone association across accounts (requires an authorization step from the zone-owning account) or through a centralized Route 53 Resolver with inbound/outbound endpoints in the shared services VPC. This is one of the more fiddly parts of the hub-and-spoke model and worth treating as its own planning task during initial Organization network design.

---

## Multi-Account-Specific Failure Modes

Beyond the standard route table/security group/NACL checklist:

- **RAM share exists but principal association is missing or not accepted** — the resource simply doesn't appear in the spoke account with no error, just an absence
- **SCPs blocking cross-account resource use** independent of RAM being correctly configured — produces an IAM access denied error, easy to spend time debugging the network layer when the block is a policy layer above it
- **CIDR overlap discovered only at TGW attachment time** — two spoke accounts provisioned independently can end up with overlapping ranges that only become visible when both try to attach and their routes conflict

---

## Read the Full Article

This summary covers both models, the comparison table, the hybrid pattern, DNS considerations, and the key failure modes. The full article includes:

- Complete Terraform for Shared VPC — VPC, subnets, RAM share, principal association
- Complete Terraform for centralized TGW — TGW with disabled default route tables, Organization-wide RAM share, spoke attachment
- Why disabling default TGW route table association matters for segmentation
- The migration-in-progress angle — how the account structure decided before the first MGN wave determines which model is even on the table later
- Full troubleshooting section for multi-account-specific failure modes

**👉 [Multi-Account AWS Networking: Shared VPC, RAM, and the Hub-and-Spoke Model — Full Article](https://aloknecessary.in/blogs/aws-multi-account-networking/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-multi-account-networking)**
