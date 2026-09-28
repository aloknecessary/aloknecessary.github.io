---
title: "VPC Endpoints: Gateway vs Interface, and the AWS Traffic That Shouldn't Touch the Internet"
published: false
description: A practical guide to AWS VPC endpoints — how Gateway (S3, DynamoDB) and Interface (PrivateLink) endpoints work under the hood, when each is worth adding, and the failure modes that show up in production.
tags: aws, networking, devops, cloud
canonical_url: https://aloknecessary.in/blogs/aws-vpc-endpoints-gateway-vs-interface/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-endpoints-gateway-vs-interface
cover_image:
---

Traffic from a private subnet to S3 routes through your NAT gateway by default — and gets billed per GB for the privilege — when a free alternative has existed for years. VPC endpoints give AWS services a private, in-VPC address path that never touches the internet. There are two fundamentally different mechanisms, and understanding how they differ changes how you decide which services actually need one.

---

## Why private subnet traffic hits NAT at all

A private subnet instance calling `s3.ap-south-1.amazonaws.com` does exactly what it would do calling any internet host: routes to the NAT gateway, gets source-translated, exits through the IGW, and comes back the same way. Both the instance and the S3 bucket are inside AWS — the traffic never needed to leave AWS's network. VPC endpoints fix this by giving the traffic a direct in-VPC path.

---

## Gateway endpoints: a route table entry, nothing more

Gateway endpoints exist for exactly two services: **S3 and DynamoDB**. They are not network devices — they are route table targets. AWS injects a managed prefix list route automatically; traffic matching S3's IP ranges routes to the endpoint instead of NAT.

```hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.ap-south-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}
```

**Cost: free.** No hourly charge, no per-GB processing charge. This makes the S3 Gateway endpoint close to a strict upgrade — there is essentially no reason not to add it to every VPC with private subnets that touch S3.

The one real limitation: Gateway endpoints are associated with specific route tables, not the whole VPC. A new private subnet with its own route table falls back to NAT silently unless you explicitly associate the endpoint with that table too. Worth adding to any subnet-creation checklist.

---

## Interface endpoints: a real ENI, backed by PrivateLink

Every other AWS service that supports VPC endpoints uses an **Interface endpoint** — a real Elastic Network Interface provisioned in a subnet you specify, with a private IP from that subnet's range, backed by AWS PrivateLink.

```hcl
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id             = aws_vpc.main.id
  service_name       = "com.amazonaws.ap-south-1.secretsmanager"
  vpc_endpoint_type  = "Interface"
  subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids = [aws_security_group.vpce_sm.id]
  private_dns_enabled = true
}
```

Because it's a real ENI, it has its own security group — Interface endpoint access is controlled by security group rules, not route table association. `private_dns_enabled = true` makes the endpoint transparent to application code: AWS overrides the public DNS name to resolve to the endpoint's private IP inside the VPC, so no SDK or application configuration change is needed.

**Cost: the opposite of Gateway endpoints.** Interface endpoints bill hourly per AZ plus per-GB data processed. "Add Interface endpoints for everything" is not automatically correct — it requires actual usage data.

---

## Which services actually justify an Interface endpoint

Start with services every private instance calls constantly regardless of application logic:

- **STS** — IAM role assumption is called far more often than people expect under the hood
- **CloudWatch Logs** — continuous log shipping from busy applications
- **ECR** — image pulls from private subnets, especially during autoscaling cold starts or frequent CI/CD deployments

These three tend to justify their hourly cost quickly in any account with meaningful private-subnet compute. Lower-traffic services — Secrets Manager called once at startup, SNS for occasional notifications — are worth evaluating with real Cost Explorer data rather than provisioning preemptively.

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-07-01,End=2026-08-01 \
  --granularity MONTHLY \
  --filter file://nat-gateway-filter.json \
  --metrics "UsageQuantity" "BlendedCost"
```

---

## Side-by-side comparison

| | Gateway Endpoint | Interface Endpoint |
| --- | --- | --- |
| Mechanism | Route table entry | ENI backed by PrivateLink |
| Services | S3, DynamoDB only | Most other AWS services |
| Cost | Free | Hourly per AZ + per-GB processed |
| Security control | Existing SG/NACL on the instance | Own security group on the endpoint ENI |
| DNS | No change needed | Private DNS override, if enabled |
| Multi-subnet | Associate route table per subnet | Deploy ENI per AZ needed |

---

## Failure modes worth knowing before you're debugging under pressure

- **Private DNS conflicts in Transit Gateway / peered VPC designs** — if two connected VPCs both have Interface endpoints for the same service with private DNS enabled, DNS resolution can become ambiguous. An instance in VPC-A may resolve the service name to VPC-B's endpoint ENI. Test this explicitly in hub-and-spoke designs.
- **Security group too narrow** — a security group that misses the calling subnet's CIDR produces a connection timeout that looks identical to a routing failure, but is actually a security group issue at the endpoint itself.
- **Endpoint deployed in wrong AZ** — the endpoint still functions cross-AZ, but incurs cross-AZ data transfer charges on top of the endpoint's per-GB cost. Deploy into every AZ that has calling instances.
- **Custom DHCP option set or Route 53 Resolver rule taking precedence** — if the VPC has custom DNS resolution configured, the endpoint's private hosted zone override can be superseded and traffic reverts to NAT despite correct endpoint configuration.

---

## Read the Full Article

This summary covers the core mechanisms and decision framework. The full article includes:

- Complete Terraform for both Gateway and Interface endpoints with security group scoping
- The full AWS CLI route table inspection workflow
- Detailed cost modelling for Interface endpoint break-even analysis
- Security group and NACL implications in depth
- The specific action to take this week if you haven't added the S3 Gateway endpoint yet

**👉 [VPC Endpoints: Gateway vs Interface — Full Article](https://aloknecessary.in/blogs/aws-vpc-endpoints-gateway-vs-interface/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-vpc-endpoints-gateway-vs-interface)**
