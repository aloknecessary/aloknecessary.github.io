---
title: "Load Balancer Internals: ALB vs NLB vs GWLB, and What Actually Happens to a Packet"
published: false
description: ALB, NLB, and GWLB operate at different OSI layers, and that single distinction — not the feature checklist — determines what each type can and cannot do to your traffic.
tags: aws, networking, cloud, devops
canonical_url: https://aloknecessary.in/blogs/aws-load-balancer-internals-alb-nlb-gwlb/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-load-balancer-internals-alb-nlb-gwlb
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of three parallel network pathways at different OSI layers — one terminating and re-establishing connections at the application layer, one forwarding packets transparently at the transport layer, one redirecting traffic through an inspection appliance at the network layer. Each path glows with a distinct neon color (electric blue, violet, soft cyan) against a deep dark background (#0d1117). No humans, no hands, no text. Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

The question "ALB or NLB?" usually gets answered by feature comparison — ALB has path-based routing, NLB has static IPs. That's not wrong, but it skips the decision that actually matters first: which OSI layer does your traffic need to be load balanced at. ALB operates at Layer 7, NLB at Layer 4, and GWLB at Layer 3, and that single distinction determines far more about behavior, performance, and what's even possible than any feature checklist does.

This article works through each type by what it actually does to a packet — connection handling, health check granularity, cross-zone cost model, and the failure modes each type produces in production.

---

## ALB: Layer 7 — terminates the connection

ALB terminates the client's TCP connection entirely, reads the actual HTTP request — method, path, headers, host — and makes a routing decision based on that content before opening a new, separate TCP connection to the chosen backend.

```
Client ──TCP/TLS──> ALB ──reads HTTP request──> routing decision
                      │
                      └──new TCP connection──> Target (backend)
```

This connection termination is the architectural fact that explains everything else ALB can do. Because it's parsing HTTP, it can route on path (`/api/*` to one target group, `/static/*` to another), host header, or query parameters — none of which are visible to a load balancer that only sees TCP segments.

```hcl
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

The cost: ALB adds processing latency per request, and because it terminates TLS, the backend sees the ALB's IP as the source — not the client's real IP — unless you read it from the `X-Forwarded-For` header ALB injects. This is a frequent source of confusion in application logs and IP-based rate limiting logic that wasn't written with a Layer 7 proxy in mind.

---

## NLB: Layer 4 — preserves the connection

NLB doesn't terminate the client connection or read anything above the transport layer. It forwards packets to a chosen target based on a consistent hash of the connection's 5-tuple, and the TCP connection stays intact end-to-end between client and target.

```
Client ──TCP connection (same connection throughout)──> NLB ──> Target
                                                            (NLB forwards, doesn't terminate)
```

Two direct consequences: the backend sees the **client's actual source IP** by default — no `X-Forwarded-For` needed — and NLB can sustain millions of requests per second with single-digit-millisecond latency, because it isn't doing HTTP parsing or connection re-establishment.

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

NLB also supports assigning a **static Elastic IP per Availability Zone** — something ALB architecturally cannot do. This is the single most common reason teams choose NLB even for HTTP traffic: the static IP requirement alone rules out ALB regardless of everything else.

---

## GWLB: Layer 3 — transparent network insertion

GWLB solves a genuinely different problem: inserting third-party network appliances — firewalls, IDS/IPS, deep packet inspection tools — transparently into a traffic path, without the appliance needing to be the traffic's actual destination.

```
Client traffic ──> GWLB ──> Appliance (inspects/filters) ──> GWLB ──> original destination
                     (via GENEVE encapsulation, traffic returns through GWLB)
```

GWLB uses GENEVE encapsulation (port 6081) to wrap the original traffic and send it to a fleet of appliance instances, which inspect or transform it and send it back through the same GWLB endpoint. ALB and NLB sit *in* the traffic path as the thing clients connect to; GWLB sits *beside* the traffic path, transparently redirecting traffic through an appliance fleet without the client or destination needing any awareness.

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

Most teams never need GWLB directly unless they're deploying a specific third-party security appliance that integrates with it, or building a centralized inspection architecture across many VPCs in an AWS Organization.

---

## Health checks: where the layer difference matters most

ALB health checks are HTTP/HTTPS requests expecting a specific status code range — a target returning 500 consistently is marked unhealthy even if the TCP port is accepting connections fine. NLB's default health check is often just a TCP connection check, which only confirms the port is accepting connections, not that the application is functioning correctly. A target that accepts TCP connections but can't process the specific protocol correctly passes NLB health checks while still failing real requests.

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

The asymmetric thresholds (2 to become healthy, 3 to become unhealthy) are deliberate — the cost of routing to a still-recovering target is usually higher than slightly slower failure detection.

---

## Cross-zone load balancing: a cost detail that differs by type

For ALB, cross-zone load balancing is **enabled by default and free**. For NLB, it is **disabled by default**, and enabling it incurs standard cross-AZ data transfer charges for any request forwarded to a target in a different AZ. This is worth being deliberate about specifically because NLB is often chosen for high-throughput workloads — exactly the situation where an unexpected cross-AZ data transfer bill shows up fastest.

---

## Side-by-side summary

| | ALB | NLB | GWLB |
| --- | --- | --- | --- |
| OSI layer | 7 (Application) | 4 (Transport) | 3 (Network) |
| Connection handling | Terminates and re-establishes | Forwards, preserves end-to-end | Transparent redirect via GENEVE |
| Protocols | HTTP, HTTPS, WebSocket | TCP, UDP, TLS passthrough | Any IP traffic |
| Client source IP visible to backend | Via `X-Forwarded-For` only | Natively, by default | N/A |
| Static IP support | No | Yes, per AZ | N/A |
| Content-based routing | Yes (path, host, headers) | No | No |

---

## Read the Full Article

The full post covers:

- The complete decision framework restated as a single question — layer first, features second
- The four most common production failure modes for each type (ALB 502s, NLB health check blind spots, GWLB return routing, missing source IP after switching types)
- The "topic fan-out into per-consumer queues" pattern and when to reach for a log instead
- Why "exactly-once" delivery guarantees are narrower than the name suggests across SQS FIFO, Service Bus, and Kafka transactions

**👉 [Load Balancer Internals: ALB vs NLB vs GWLB — Full Article](https://aloknecessary.in/blogs/aws-load-balancer-internals-alb-nlb-gwlb/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-load-balancer-internals-alb-nlb-gwlb)**
