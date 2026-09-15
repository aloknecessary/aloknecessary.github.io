---
title: "Deploying MCP Servers on Kubernetes"
date: 2026-09-15
last_modified_at: 2026-09-15T11:45:51+05:30
author: Alok Ranjan Daftuar
description: "Containerizing a stdio MCP server and exposing a port is a transport mismatch, not a deployment. This post covers what a correct Kubernetes deployment looks like — probes, IRSA, Workload Identity, rolling updates, and autoscaling — end to end on EKS and AKS."
excerpt: "Wrapping a stdio MCP server in a container and exposing a port isn't a deployment — it's a transport mismatch waiting to surface in production. Here's what an actual Kubernetes deployment looks like, end to end, on EKS and AKS."
keywords: "mcp kubernetes, deploying mcp servers, eks mcp, aks mcp, irsa, workload identity, streamable http, liveness probe, hpa autoscaling, agentic infrastructure"
twitter_card: "summary_large_image"
categories:
  - ai-engineering
  - cloud
tags: [mcp, kubernetes, docker, eks, aks, deployment, irsa, workload-identity, autoscaling, platform-engineering]
series: "Agentic Infrastructure"
series_order: 2
---

## The wrapper that doesn't actually work

Most MCP servers start life as a local, stdio-based process — the client spawns the server directly as a child process, and messages flow over stdin and stdout. That model is genuinely the right one for local development: one client, one process, no network involved. The instinct once that same server needs to serve more than one client is to containerize it and expose a port, treating the move to Kubernetes as packaging rather than architecture.

That instinct produces a container that starts, passes a naive health check, and then does nothing useful, because stdio was never a network transport to begin with. A process reading from stdin and writing to stdout inside a container has no way for a remote client to connect to it — there's no listener, no port, nothing for a Kubernetes Service to route traffic toward. The fix isn't a networking change at the cluster level; it's a transport change in the server itself, from stdio to Streamable HTTP, before Kubernetes enters the picture at all.

This matters enough to state plainly: **a stdio MCP server does not become deployable by containerizing it.** It becomes deployable once it speaks Streamable HTTP, exposes an actual endpoint (conventionally `/mcp`), and handles JSON-RPC over POST the way [the stateless transport described in the previous article](/blogs/the-mcp-stateless-revolution/) expects. Everything in this article assumes that transport work is done — the server accepts HTTP requests, emits the `Mcp-Method`/`Mcp-Name` headers correctly, and doesn't depend on the session ID the 2026-07-28 specification removed. What follows is what happens after that: getting a Streamable HTTP MCP server correctly deployed, probed, and exposed on EKS and AKS.

## The image

The container image itself is unremarkable by design — the interesting decisions happen in the Kubernetes manifests, not the Dockerfile. What matters here is keeping the image minimal and making sure the process binds to the HTTP transport, not stdio, as its entrypoint:

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

The three `MCP_*` environment variables aren't a convention this article is inventing — they mirror the flags production-grade MCP server implementations expose for choosing transport mode at startup (`--transport streamable-http --http-addr :8080 --http-endpoint /mcp` is the equivalent CLI form in several existing servers). The specific variable names will differ by SDK, but the shape is the same: transport, bind address, and endpoint path all need to be explicit and set at deploy time, not hardcoded into the binary.

## The Deployment

This is where the corrected liveness/readiness split from the first article in this series earns its keep. An MCP server mid-tool-call is not the same thing as a hung process, and the probes need to say so explicitly rather than conflating the two:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
  labels:
    app: mcp-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
        - name: mcp-server
          image: registry.example.com/mcp-server:2026.09.0
          ports:
            - containerPort: 8080
              name: http
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            periodSeconds: 5
            failureThreshold: 2
          env:
            - name: MCP_TRANSPORT
              value: "streamable-http"
            - name: MCP_HTTP_ADDR
              value: "0.0.0.0:8080"
      terminationGracePeriodSeconds: 45
```

Two details here are easy to skip past and shouldn't be. First, `terminationGracePeriodSeconds: 45` — the default 30 seconds is a reasonable guess for a request/response service and a poor one for a process that might be mid-tool-call when a rolling update evicts it. Since the stateless transport means a dropped request just gets retried rather than losing an unresumable stream, a 45-second grace period gives an in-flight call a real chance to finish before SIGKILL rather than forcing an unnecessary retry. Second, resource requests are set deliberately modest relative to limits (`250m`/`1` CPU, `256Mi`/`512Mi` memory) — MCP servers spend most of their time waiting on outbound calls to tools and the model itself, not computing locally, so provisioning them like a CPU-bound service wastes cluster capacity that would be better spent on more replicas.

## The Service and Ingress

The Service definition itself is close to the simplest thing in this entire deployment, which is the direct payoff of the stateless transport — there's no session affinity to configure, no cookie-based stickiness annotation, nothing beyond ordinary load balancing:

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

The ingress-level header-based routing (splitting `Mcp-Method` traffic across backend pools on ALB or Application Gateway) was covered in the [previous article](/blogs/the-mcp-stateless-revolution/) and applies unchanged here — this Service is what that ingress ultimately routes to.

## EKS: credentials without a static secret

An MCP server that calls AWS APIs on the tenant's behalf needs credentials, and the deployment-time decision that matters most is avoiding a long-lived static credential baked into the image or mounted as a Secret. IAM Roles for Service Accounts (IRSA) solves this by binding a Kubernetes ServiceAccount to an IAM role via OIDC federation, so the pod gets short-lived, automatically rotated credentials:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mcp-server-role
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  template:
    spec:
      serviceAccountName: mcp-server
      containers:
        - name: mcp-server
          # ...as above
```

The IAM role itself is scoped narrowly to whatever the server's tools actually need to call — this is a case where the temptation to attach a broad managed policy during initial setup and narrow it later is worth resisting from the start, since an MCP server's tool surface is exactly the kind of thing that grows without anyone revisiting the IAM policy that backs it.

## AKS: the same problem, Azure's mechanism

Workload Identity is AKS's equivalent — it federates a Kubernetes ServiceAccount token with an Entra ID application, avoiding both static credentials and the older, heavier AAD Pod Identity approach:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  annotations:
    azure.workload.identity/client-id: "11111111-2222-3333-4444-555555555555"
  labels:
    azure.workload.identity/use: "true"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: mcp-server
      containers:
        - name: mcp-server
          # ...as above
```

The `azure.workload.identity/use: "true"` label has to be present on both the ServiceAccount and the pod template — a common enough gap that it's worth calling out explicitly, since a pod missing that label silently falls back to no identity at all rather than failing loudly, which makes it a frustrating thing to debug after the fact. The federation itself happens through a short-lived, automatically rotated token projected into the pod by the Azure Workload Identity webhook, mirroring what IRSA does on EKS via OIDC — the mechanisms differ, but the underlying decision they both enforce is identical: no credential the pod holds should outlive the pod itself.

## A starting point for autoscaling

A resource-based HorizontalPodAutoscaler is not the ideal long-term signal for a workload that spends most of its time waiting on I/O rather than computing — CPU utilization tracks compute-bound load, not the concurrency of in-flight tool calls, so it will under-react to the specific burst pattern MCP servers actually produce. But a deployment needs *something* running from day one, and a conservative resource-based HPA is a reasonable floor to start from rather than leaving replica count fully static:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mcp-server
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mcp-server
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

The asymmetric stabilization windows are deliberate: scaling up quickly (30 seconds) protects against a burst of concurrent tool-calling tasks queuing up behind too few replicas, while scaling down slowly (300 seconds) avoids flapping — killing a replica just before the next burst arrives and paying the cold-start cost again. This configuration will under-react to the specific load pattern MCP servers actually produce, since CPU utilization doesn't track I/O-bound tool-call concurrency well, but it's a safe default while a better signal is put in place, not a placeholder that actively causes harm in the meantime.

## Rolling updates without dropping in-flight work

The `terminationGracePeriodSeconds` value set earlier only helps if the rollout strategy actually gives pods time to drain before the next batch is cycled. The Deployment's default `RollingUpdate` strategy needs explicit tuning here too, rather than relying on Kubernetes defaults that were sized for faster-draining request/response services:

```yaml
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
```

`maxUnavailable: 0` guarantees the rollout never reduces capacity below the current replica count — a new pod has to become ready before an old one is torn down, rather than the default behavior of taking a pod down first and backfilling after. Combined with `maxSurge: 1`, a rollout across three replicas proceeds one pod at a time, each new pod passing its readiness probe before the corresponding old pod receives its SIGTERM and begins the 45-second grace period. For a stateless transport, this mostly protects latency and throughput during a deploy rather than correctness — a request landing on a pod mid-termination just gets retried against a healthy one — but it's still the difference between a rollout that's invisible to callers and one that produces a visible error-rate blip every time code ships.

## Namespace and labeling conventions worth setting now

One decision worth making explicitly at this stage, even before any dedicated isolation work, is namespace layout. A single shared namespace holding every MCP server across every team is the path of least resistance early on, and it's also the thing that's hardest to unwind later once NetworkPolicies, ResourceQuotas, and RBAC bindings have all been written against a flat structure. Labeling each Deployment and Service with a consistent `team` or `tenant` key from the start — even if nothing enforces it yet — costs nothing today and is what makes namespace-per-tenant or NetworkPolicy-based segmentation a labeling change later instead of a full manifest rewrite:

```yaml
metadata:
  labels:
    app: mcp-server
    team: platform-eng
    mcp.example.com/server-name: internal-tools
```

That third label — a server-name key under a namespaced prefix — is what a header-based routing rule or an authorization policy can key off later without needing to parse the Deployment name itself, which is a small piece of forward-compatible hygiene worth adopting even in a single-tenant deployment.

## Why credential federation matters more than it looks like it should

The IRSA and Workload Identity patterns above aren't just cloud-native best practice for its own sake — they close a gap that's turned out to be a real, measured problem across the MCP ecosystem. A recent analysis of thousands of open-source MCP servers found a majority still rely on long-lived static credentials rather than short-lived, federated ones, which is precisely the exposure that a leaked container image, a misconfigured Secret, or a compromised dependency turns into a standing risk rather than a time-boxed one. Getting identity federation right at initial deployment — rather than retrofitting it after a server has been running on static keys for months — is one of the few places in this article where the "do it properly from day one" advice actually is cheaper than the alternative, not just safer.

## Verifying the deployment

Once applied, a request that exercises the actual transport — headers included — confirms the deployment is correctly speaking the current specification rather than an older, session-based dialect:

```bash
curl -s -X POST https://mcp.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -H "Mcp-Name: mcp-server" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A correctly deployed 2026-07-28-compliant server returns the tool list with no `Mcp-Session-Id` in the response headers and no `initialize` call required beforehand — if a session header does show up, that's a sign the server (or a proxy sitting in front of it) is still running the older, stateful transport path, worth catching in verification rather than discovering under load.

It's worth running that same check again immediately after a rollout, not just once at initial deployment — a regression here is easy to introduce accidentally, for instance by fronting the Service with a proxy or API gateway that was configured against the older transport and silently reintroduces session affinity at a layer this article's manifests don't control. A five-line smoke test in the CI/CD pipeline that runs this `curl` against the newly rolled-out endpoint and asserts the header is absent catches that class of regression before it reaches production traffic, and it's a cheap enough check to run on every deploy rather than treating it as a one-time verification step.

> 📌 **Key Takeaway:** A Kubernetes deployment for an MCP server is not a container-and-port exercise — it depends on transport work happening first (stdio to Streamable HTTP), probes that understand the difference between "alive" and "ready for new work," and cloud-native identity federation instead of static credentials. Get those three right and the Service and Ingress layers stay genuinely simple, which is the actual payoff of the stateless transport underneath all of it.
