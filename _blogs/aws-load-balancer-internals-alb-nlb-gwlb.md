---
title: "Load Balancer Internals: ALB vs NLB vs GWLB, and What Actually Happens to a Packet"
date: 2026-10-08
last_modified_at: 2026-10-08T15:06:23+05:30
author: Alok Ranjan Daftuar
description: "ALB, NLB, and GWLB operate at different OSI layers — Layer 7, 4, and 3 respectively — and that single distinction determines connection handling, routing capability, source IP visibility, and what each type can and cannot do. A packet-level walkthrough of all three."
excerpt: "Picking a load balancer type by feature checklist misses the actual decision — the three AWS load balancers operate at different layers of the stack, and that difference, not the feature list, is what determines whether one will even work for your traffic."
keywords: "aws load balancer, alb, nlb, gwlb, application load balancer, network load balancer, gateway load balancer, layer 7, layer 4, target groups, health checks, cross-zone load balancing, terraform"
twitter_card: "summary_large_image"
categories:
  - cloud
tags: [alb, nlb, gwlb, load-balancing, aws, networking, target-groups, health-checks, terraform]
series: "AWS Network Architecture"
series_order: 6
---

The question "ALB or NLB?" usually gets answered by feature comparison — ALB has path-based routing, NLB has static IPs, and so on. That's not wrong, but it skips the decision that actually matters first: **which OSI layer does your traffic need to be load balanced at**. ALB operates at Layer 7, NLB at Layer 4, and GWLB at Layer 3, and that single distinction determines far more about behavior, performance, and what's even possible than any feature checklist does. This article works through each type by what it actually does to a packet, not by what's in the console's feature comparison table.

This continues the AWS Network Architecture series' foundation from [VPC Networking Fundamentals](/blogs/aws-vpc-networking-fundamentals/) — all three load balancer types are provisioned into subnets and route traffic according to target group health, but how they handle the connection itself differs enough that the choice has real architectural consequences downstream.

## Application Load Balancer: Layer 7, terminates the connection

ALB operates at the HTTP/HTTPS layer. It terminates the client's TCP connection entirely, reads the actual HTTP request — method, path, headers, host — and makes a routing decision based on that content before opening a *new*, separate TCP connection to the chosen backend target.

```text
Client ──TCP/TLS──> ALB ──reads HTTP request──> routing decision
                      │
                      └──new TCP connection──> Target (backend)
```

This connection termination is the architectural fact that explains everything else ALB can do. Because it's actually parsing HTTP, it can route based on path (`/api/*` to one target group, `/static/*` to another), host header (multiple domains on one ALB, each routed to different backends), or query parameters — none of which are visible to a load balancer that only sees TCP segments. It's also why ALB can do TLS termination with SNI-based certificate selection, serving different certificates for different hostnames off a single ALB, and why it can perform content-based routing that a lower-layer balancer architecturally cannot.

```hcl
resource "aws_lb" "app" {
  name               = "alb-app"
  load_balancer_type = "application"
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_listener_rule" "api_route" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}
```

### The cost of terminating the connection

Reading and re-establishing every connection isn't free. ALB adds processing latency per request — typically single-digit milliseconds, but non-zero and worth knowing about for latency-sensitive workloads — and because it terminates TLS by default, the backend sees the ALB's IP as the source, not the client's real IP, unless you explicitly read it from the `X-Forwarded-For` header ALB injects. This is a frequent source of confusion in application logs and IP-based rate limiting logic that wasn't written with a Layer 7 proxy in mind.

### Where ALB is the only correct choice

Anything needing content-aware routing — microservices behind a single domain split by path, multi-tenant SaaS routed by subdomain, WebSocket upgrade handling, or native integration with AWS WAF for request-level inspection — needs ALB specifically, because NLB and GWLB operate below the layer where any of this is even visible.

## Network Load Balancer: Layer 4, preserves the connection

NLB operates at the TCP/UDP layer. It doesn't terminate the client connection or read anything above the transport layer — it forwards packets to a chosen target based on a consistent hash of the connection's 5-tuple (source IP, source port, destination IP, destination port, protocol), and the TCP connection itself stays intact end-to-end between client and target, with NLB acting as a high-performance packet forwarder rather than a proxy.

```text
Client ──TCP connection (same connection throughout)──> NLB ──> Target
                                                            (NLB forwards, doesn't terminate)
```

This has two direct, important consequences. First, the backend target sees the **client's actual source IP** by default — no `X-Forwarded-For` header needed, because there's no proxying rewriting the source address the way ALB's new backend connection does. Second, NLB can sustain **millions of requests per second with single-digit-millisecond latency**, because it isn't doing HTTP parsing or connection re-establishment — it's closer to a highly available, managed packet-forwarding layer than an application proxy.

```hcl
resource "aws_lb" "network" {
  name               = "nlb-tcp-service"
  load_balancer_type = "network"
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "tcp" {
  name        = "tg-tcp-service"
  port        = 5432
  protocol    = "TCP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    protocol = "TCP"
    port     = "5432"
  }
}
```

### Static IP addresses, and why that matters more than it sounds

NLB supports assigning a **static Elastic IP per Availability Zone** — something ALB architecturally cannot do, since ALB's IPs are managed and can change. This matters specifically for scenarios where a downstream consumer needs to allowlist a fixed IP — a partner integration requiring IP-based firewall rules, or a database client expecting a stable connection target — and it's the single most common reason teams choose NLB even for HTTP traffic that doesn't strictly need Layer 4 performance: the static IP requirement alone rules out ALB regardless of everything else.

### Where NLB is the only correct choice

Non-HTTP protocols — raw TCP services, UDP (DNS servers, game servers, IoT telemetry ingestion), or anything needing extreme throughput with minimal latency overhead — need NLB, since ALB only understands HTTP/HTTPS and WebSocket upgrades, nothing else. Needing the client's real source IP without extra header-parsing logic on the backend is another common deciding factor, as is any requirement for a static, allowlist-able IP.

## Gateway Load Balancer: Layer 3, transparent network insertion

GWLB is the least commonly needed of the three, and it solves a genuinely different problem from the other two: inserting third-party or custom network appliances — firewalls, intrusion detection/prevention systems, deep packet inspection tools — transparently into a traffic path, without the appliance needing to be the traffic's actual destination or source.

```text
Client traffic ──> GWLB ──> Appliance (inspects/filters) ──> GWLB ──> original destination
                     (via GENEVE encapsulation, traffic returns through GWLB)
```

GWLB uses **GENEVE encapsulation** (port 6081) to wrap the original traffic and send it to a fleet of appliance instances in a GWLB target group, which inspect or transform it and send it back through the same GWLB endpoint toward its original destination. Architecturally, this is the piece that makes GWLB fundamentally different from ALB and NLB: those two sit *in* the traffic path as the thing clients connect to; GWLB sits *beside* the traffic path, transparently redirecting traffic through an appliance fleet without the client or the ultimate destination needing any awareness that inspection is happening.

```hcl
resource "aws_lb" "gateway" {
  name               = "gwlb-firewall-fleet"
  load_balancer_type = "gateway"
  subnets            = [aws_subnet.appliance_a.id, aws_subnet.appliance_b.id]
}

resource "aws_vpc_endpoint" "gwlb" {
  vpc_id            = aws_vpc.main.id
  service_name       = aws_vpc_endpoint_service.gwlb.service_name
  vpc_endpoint_type  = "GatewayLoadBalancer"
  subnet_ids         = [aws_subnet.private_a.id]
}
```

### Where GWLB is the only correct choice

Centralizing third-party firewall or IDS/IPS appliances across many VPCs in an Organization — the same multi-account centralization pattern from the [Multi-Account Networking](/blogs/aws-multi-account-networking/) article, applied to a security appliance fleet rather than a routing hub. A GWLB endpoint in each spoke VPC's route table redirects traffic transparently through a centrally managed appliance fleet in a dedicated inspection VPC, without every spoke VPC needing its own appliance deployment. This is a specialized pattern — most teams never need GWLB directly unless they're deploying a specific third-party security appliance that integrates with it, or building this kind of centralized inspection architecture themselves.

## Health checks: the mechanism all three share, with real differences

All three load balancer types route only to targets passing health checks, but what counts as "healthy" differs meaningfully by type. ALB health checks are HTTP/HTTPS requests expecting a specific status code range — a target returning 500 consistently is marked unhealthy even if the TCP port is accepting connections fine, which is exactly the granularity ALB's Layer 7 awareness enables. NLB health checks are typically TCP (connection succeeds) or HTTP if configured, but without ALB's deep content awareness — a TCP health check only confirms the port is accepting connections, not that the application behind it is actually functioning correctly, which is a real blind spot worth knowing about if you choose NLB for an HTTP service specifically for its performance characteristics.

```hcl
resource "aws_lb_target_group" "api" {
  name     = "tg-api"
  port     = 443
  protocol = "HTTPS"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
  }
}
```

A `healthy_threshold` of 2 and `unhealthy_threshold` of 3 with a 15-second interval means a target needs two consecutive successful checks (30 seconds) to be marked healthy, but three consecutive failures (45 seconds) to be marked unhealthy — deliberately asymmetric, since the cost of prematurely routing to a still-recovering target is usually higher than the cost of a slightly slower failure detection.

## Cross-zone load balancing: a cost detail that differs by type

All three types support distributing traffic evenly across targets in every enabled Availability Zone rather than just the AZ a request happened to arrive in, but the cost model for this differs in a way worth knowing before enabling it blindly. For ALB, cross-zone load balancing is **enabled by default and free** — there's no separate charge for traffic crossing AZs specifically for ALB's own balancing. For NLB, cross-zone load balancing is **disabled by default**, and enabling it incurs standard cross-AZ data transfer charges for any request that gets forwarded to a target in a different AZ than the one the client connected through.

```hcl
resource "aws_lb" "network" {
  name                              = "nlb-tcp-service"
  load_balancer_type                = "network"
  subnets                           = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  enable_cross_zone_load_balancing  = true  # explicit opt-in, has a cost
}
```

This is worth being deliberate about specifically because NLB is often chosen for high-throughput workloads, which is exactly the situation where an unexpected cross-AZ data transfer bill from enabling this without realizing the cost model shows up fastest. For most production deployments the even-distribution benefit is worth the cost, but it should be a deliberate choice, not a default left unexamined.

## Troubleshooting: where each type actually fails

- **ALB returning 502 with healthy-looking targets.** Often a target group protocol/port mismatch, or a target application closing idle connections faster than ALB's idle timeout (default 60 seconds) expects, which ALB interprets as a bad response rather than a timing issue — worth checking the target application's own keep-alive timeout against ALB's configured idle timeout specifically when this happens intermittently under load rather than consistently.
- **NLB health checks passing but real traffic failing.** Since NLB's default health check is often just a TCP connection check, a target that accepts TCP connections but can't actually process the specific protocol correctly passes health checks while still failing real requests — switching to an HTTP health check path if the service is HTTP-based, even when using NLB specifically for Layer 4 performance, closes this gap.
- **GWLB appliance fleet traffic not returning correctly.** Almost always a routing configuration issue on the appliance instances themselves — they need to route return traffic back through the GWLB endpoint rather than directly to the original destination, since GWLB's transparent insertion model depends on traffic flowing back through the same path it arrived on, not a more "direct" route the appliance's own routing table might otherwise prefer.
- **Client source IP missing or wrong on an ALB-fronted target.** Check whether the application is reading `X-Forwarded-For` at all — a common cause of "NLB works but ALB doesn't" complaints when a team switches load balancer types without updating application logic that assumed the connection's own source address would always be the client's.

## Side-by-side summary

| | ALB | NLB | GWLB |
| --- | --- | --- | --- |
| OSI layer | 7 (Application) | 4 (Transport) | 3 (Network) |
| Connection handling | Terminates and re-establishes | Forwards, preserves end-to-end | Transparent redirect via GENEVE |
| Protocols | HTTP, HTTPS, WebSocket | TCP, UDP, TLS passthrough | Any IP traffic |
| Client source IP visible to backend | Via `X-Forwarded-For` only | Natively, by default | N/A — passes through to appliance |
| Static IP support | No | Yes, per AZ | N/A |
| Content-based routing | Yes (path, host, headers) | No | No |
| Typical use | Web apps, microservices, APIs | High-throughput TCP/UDP services, static IP needs | Centralized third-party security appliances |

## Choosing correctly, restated as one question

Start with what your traffic actually is, not what features you want. HTTP/HTTPS traffic that needs routing decisions based on anything in the request itself — path, host, headers — needs ALB; there's no substitute, since the other two can't see that far up the stack. Raw TCP or UDP traffic, or HTTP traffic with a hard requirement for a static IP or the client's real source address without extra parsing, needs NLB. Transparently inserting a security or inspection appliance into a traffic path without becoming the traffic's actual endpoint needs GWLB, and if that's not your specific problem, you almost certainly don't need it at all. The layer question settles the choice before any feature comparison would even be relevant.

> 📌 **Key Takeaway**: ALB, NLB, and GWLB aren't three tiers of the same product — they operate at three different OSI layers and solve structurally different problems. ALB terminates connections to read and route on HTTP content; NLB forwards packets with the connection intact for raw performance and a stable source IP; GWLB transparently redirects traffic through an appliance fleet without becoming the destination itself. Pick based on what layer your actual traffic needs inspected or routed at, not by comparing feature lists across all three.
