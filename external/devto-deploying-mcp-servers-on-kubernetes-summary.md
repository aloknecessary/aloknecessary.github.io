---
title: "Deploying MCP Servers on Kubernetes"
published: false
description: Containerizing a stdio MCP server and exposing a port is a transport mismatch, not a deployment. Here's what a correct Kubernetes deployment looks like on EKS and AKS.
tags: kubernetes, mcp, devops, platform
canonical_url: https://aloknecessary.in/blogs/deploying-mcp-servers-on-kubernetes/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=deploying-mcp-servers-on-kubernetes
cover_image:
---

Most MCP servers start life as a local, stdio-based process — the client spawns the server as a child process, messages flow over stdin and stdout. The instinct once that server needs to serve more than one client is to containerize it and expose a port. That instinct produces a container that starts, passes a naive health check, and then does nothing useful.

A process reading from stdin and writing to stdout inside a container has no listener, no port, nothing for a Kubernetes Service to route traffic toward. The fix isn't a networking change — it's a transport change in the server itself, from stdio to Streamable HTTP, before Kubernetes enters the picture at all.

---

## The image

The Dockerfile is unremarkable by design — the interesting decisions happen in the manifests, not the image. What matters is that the process binds to HTTP transport, not stdio, as its entrypoint:

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
ENV MCP_TRANSPORT=streamable-http
ENV MCP_HTTP_ADDR=0.0.0.0:8080
ENV MCP_HTTP_ENDPOINT=/mcp
EXPOSE 8080
USER node
ENTRYPOINT ["node", "dist/server.js"]
```

The three `MCP_*` variables mirror the flags production-grade MCP server implementations expose for choosing transport mode at startup. Transport, bind address, and endpoint path all need to be explicit and set at deploy time, not hardcoded into the binary.

---

## The Deployment — probes that understand the workload

An MCP server mid-tool-call is not the same thing as a hung process. The probes need to say so explicitly:

```yaml
livenessProbe:
  httpGet:
    path: /health          # answers: is the process itself alive?
    port: 8080
  periodSeconds: 15
  timeoutSeconds: 5
  failureThreshold: 3      # ~45s of true unresponsiveness before restart

readinessProbe:
  httpGet:
    path: /ready            # answers: can this pod accept new work right now?
    port: 8080
  periodSeconds: 5
  failureThreshold: 2
```

`/health` should do nothing more than confirm the process's event loop is running — never block on the status of an in-progress tool call. `/ready` reflects capacity: a pod mid-reasoning can report itself not-ready for new work without being treated as dead.

Two other details in the Deployment matter: `terminationGracePeriodSeconds: 45` (the default 30s is a poor fit for a process that might be mid-tool-call during a rolling update), and resource requests set deliberately modest relative to limits — MCP servers spend most of their wall-clock time waiting on outbound I/O, not computing locally.

---

## The Service — the payoff of stateless transport

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mcp-server
spec:
  selector:
    app: mcp-server
  ports:
    - port: 443
      targetPort: 8080
      name: https
```

No session affinity. No cookie-based stickiness annotation. Nothing beyond ordinary load balancing. This is the direct payoff of the July 2026 MCP spec removing the protocol-level session — any request can land on any pod, so the Service stays genuinely simple.

---

## EKS: IRSA for short-lived credentials

An MCP server calling AWS APIs needs credentials. The deployment-time decision that matters most is avoiding a long-lived static credential baked into the image or mounted as a Secret. IAM Roles for Service Accounts (IRSA) binds a Kubernetes ServiceAccount to an IAM role via OIDC federation:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mcp-server-role
```

The IAM role should be scoped narrowly to whatever the server's tools actually need — an MCP server's tool surface is exactly the kind of thing that grows without anyone revisiting the IAM policy that backs it.

---

## AKS: Workload Identity

Workload Identity is AKS's equivalent — it federates a Kubernetes ServiceAccount token with an Entra ID application:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  annotations:
    azure.workload.identity/client-id: "11111111-2222-3333-4444-555555555555"
  labels:
    azure.workload.identity/use: "true"
```

The `azure.workload.identity/use: "true"` label must be present on both the ServiceAccount and the pod template — a pod missing that label silently falls back to no identity at all rather than failing loudly, which makes it a frustrating thing to debug after the fact.

---

## Autoscaling — a safe floor, not the ideal signal

CPU utilization doesn't track I/O-bound tool-call concurrency well, but a deployment needs something running from day one:

```yaml
spec:
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300
```

The asymmetric stabilization windows are deliberate: scale up quickly (30s) to protect against bursts of concurrent tool-calling tasks, scale down slowly (300s) to avoid flapping. This will under-react to the specific load pattern MCP servers produce, but it's a safe default while a better signal is put in place.

---

## Rolling updates without dropping in-flight work

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1
```

`maxUnavailable: 0` guarantees the rollout never reduces capacity below the current replica count — a new pod must pass its readiness probe before the corresponding old pod receives SIGTERM and begins the 45-second grace period. The difference between a rollout that's invisible to callers and one that produces a visible error-rate blip every time code ships.

---

## Verifying the deployment

A request that exercises the actual transport confirms the deployment is correctly speaking the current specification:

```bash
curl -s -X POST https://mcp.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -H "Mcp-Name: mcp-server" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A correctly deployed 2026-07-28-compliant server returns the tool list with no `Mcp-Session-Id` in the response headers and no `initialize` call required beforehand. If a session header shows up, the server (or a proxy in front of it) is still running the older stateful transport path. Worth catching in verification rather than discovering under load — and worth running as a smoke test on every deploy, not just at initial deployment.

---

## Read the Full Article

The summary covers the core patterns. The full article goes deeper on:

- The complete Deployment YAML with all fields explained — resource requests, grace period, and why each value is what it is
- Why credential federation (IRSA and Workload Identity) matters more than it looks like it should — and the measured ecosystem data on static credential exposure in open-source MCP servers
- Namespace and labeling conventions worth setting at initial deployment, before isolation requirements force a full manifest rewrite
- The rolling update strategy in full context, and why `maxUnavailable: 0` is the right default for this workload class

**👉 [Deploying MCP Servers on Kubernetes — Full Article](https://aloknecessary.in/blogs/deploying-mcp-servers-on-kubernetes/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=deploying-mcp-servers-on-kubernetes)**
