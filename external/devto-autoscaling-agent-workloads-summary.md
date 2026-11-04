---
title: "Autoscaling Agent Workloads"
published: false
description: CPU-based autoscaling fails silently for I/O-bound MCP servers. Here's how to scale on in-flight concurrency with KEDA, protect busy replicas on the way down, and pre-provision capacity so bursts never wait on a node.
tags: kubernetes, mcp, keda, devops
canonical_url: https://aloknecessary.in/blogs/autoscaling-agent-workloads/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=autoscaling-agent-workloads
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of an autonomous Kubernetes autoscaling system responding to agent workload bursts. Glowing concurrency gauges and pod replicas expanding outward from a central cluster node, with wave-like traffic signals flowing in from the left. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

A replica holding 20 concurrent tool calls, each waiting 25 seconds on a downstream API, shows 5–6% CPU utilization. The autoscaler sees a healthy pod and holds the replica count at the minimum. The 21st caller queues. The failure also runs in reverse: when a burst of queued calls all return at once, CPU spikes after the damage is done, and the autoscaler scales up for load that has already passed.

The signal that tracks agent load is concurrency — how many calls a replica is holding right now. This article replaces the CPU-based HPA from the earlier deployment article with KEDA scaling on in-flight concurrency, adds drain-aware scale-down so busy pods are the last to go, and pre-provisions spare capacity so a burst never waits on a node.

---

## Instrument the signal first

Nothing can scale on concurrency until the server reports it. A Prometheus gauge incremented on call start and decremented on finish is enough:

```typescript
import { Gauge } from "prom-client";

const inflight = new Gauge({
  name: "mcp_inflight_calls",
  help: "Tool calls currently executing in this pod",
});
let active = 0;
let draining = false;

async function withTracking<T>(fn: () => Promise<T>): Promise<T> {
  inflight.inc();
  active++;
  try {
    return await fn();
  } finally {
    inflight.dec();
    active--;
  }
}
```

Wrap every tool handler in `withTracking` and the gauge becomes the demand signal. The `active` counter is also used by the readiness probe and the drain handler — one source of truth for the pod's current load.

---

## Readiness as a capacity signal

The readiness probe from the first article in this series — "can this pod accept new work right now?" — earns its keep here. A pod at its concurrency ceiling should say no, so the Service routes new calls to replicas that still have room:

```typescript
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 12);

app.get("/ready", (_req, res) => {
  const ready = !draining && active < MAX_CONCURRENCY;
  res.status(ready ? 200 : 503).end();
});
```

This is a backstop, not a limiter. With a 5-second probe interval and two failures, a saturated pod stays in rotation for up to ten seconds before it's removed. The autoscaling threshold has to sit well below the ceiling so the autoscaler acts before every replica saturates simultaneously.

---

## Replace the HPA with KEDA

KEDA's Prometheus scaler queries Prometheus directly and generates the HPA itself — no Prometheus Adapter needed. The ScaledObject uses `AverageValue` so desired replicas equals the summed in-flight count divided by the threshold, rounded up:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: mcp-server
spec:
  scaleTargetRef:
    name: mcp-server
  minReplicaCount: 3
  maxReplicaCount: 16
  pollingInterval: 15
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Percent
              value: 100
              periodSeconds: 30
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Pods
              value: 1
              periodSeconds: 60
  triggers:
    - type: prometheus
      metricType: AverageValue
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        query: sum(mcp_inflight_calls{app="mcp-server"})
        threshold: "8"
```

Scale-up has no stabilization delay and can double every 30 seconds. Scale-down removes one pod per minute after a five-minute window — a lull between bursts doesn't strip capacity the next burst needs. Delete the old CPU-based HPA before applying this, since two autoscalers on one Deployment fight each other.

---

## Scale-down is where agents get hurt

Scaling up is forgiving — a slow replica costs latency. Scaling down can destroy work. Three controls address this without requiring the autoscaler to understand agents.

**Pod deletion cost.** Publishing each pod's in-flight count as its `pod-deletion-cost` annotation makes idle replicas go before busy ones. Setting `karpenter.sh/do-not-disrupt` while a pod holds work blocks voluntary node consolidation:

```typescript
setInterval(async () => {
  const current = active;
  if (current === published) return;
  const token = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
  await fetch(`${API}/api/v1/namespaces/${NS}/pods/${POD}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      metadata: {
        annotations: {
          "controller.kubernetes.io/pod-deletion-cost": String(current),
          "karpenter.sh/do-not-disrupt": current > 0 ? "true" : null,
        },
      },
    }),
  });
  published = current;
}, 15_000);
```

The annotation can lag by up to 15 seconds, which is why the drain handler exists as a second line of defence.

**Drain on SIGTERM.** Flip the `draining` flag so `/ready` returns 503, then wait for held calls to finish before exiting:

```typescript
process.on("SIGTERM", async () => {
  draining = true;
  const deadline = Date.now() + 40_000;   // inside terminationGracePeriodSeconds: 45
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  server.close(() => process.exit(0));
});
```

---

## Capacity before the pods

Pod autoscaling is fast, but a new pod still needs a node. Placeholder pods reserve capacity and get evicted the moment real work needs it:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overprovisioning
value: -10
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: capacity-reserve
spec:
  replicas: 2
  template:
    spec:
      priorityClassName: overprovisioning
      terminationGracePeriodSeconds: 0
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests: { cpu: 500m, memory: 512Mi }
```

MCP pods run at the default priority of 0 and preempt the placeholders immediately. The evicted placeholders go Pending, which prompts Karpenter (EKS) or node auto-provisioning (AKS) to add capacity in the background.

---

## Derive the threshold, don't guess

The `threshold: "8"` in the ScaledObject is a placeholder. The right number is the concurrency at which a single replica's p95 latency first breaks your target, found by running a k6 ramp against a fixed replica count with autoscaling off. Set the threshold at roughly 70% of that number — the headroom covers the 15-second polling interval and pod startup time during which load keeps rising.

---

## Read the Full Article

The summary covers the core patterns. The full article goes deeper on:

- The complete KEDA installation steps for both AKS (managed add-on) and EKS (Helm), and the managed Prometheus authentication difference
- The RBAC Role required for the pod annotation pattern, and the security trade-off it introduces relative to the securing article in this series
- The Karpenter NodePool configuration for agent workloads, including `consolidateAfter` and the `limits.cpu` cost guardrail
- The full k6 load test script for deriving the concurrency threshold from your actual tool latency profile
- Two PrometheusRule alerts: replica ceiling detection and per-pod saturation, wired to catch quota and downstream rate-limit problems before users do

**👉 [Autoscaling Agent Workloads — Full Article](https://aloknecessary.in/blogs/autoscaling-agent-workloads/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=autoscaling-agent-workloads)**
