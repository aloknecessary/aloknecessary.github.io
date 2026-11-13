---
title: "Autoscaling Agent Workloads"
date: 2026-11-04
last_modified_at: 2026-11-04T17:29:24+05:30
author: Alok Ranjan Daftuar
description: "CPU-based autoscaling fails for I/O-bound MCP servers — a replica holding 20 concurrent tool calls waiting on downstream APIs shows near-zero CPU while fully saturated. This article replaces the HPA with KEDA scaling on in-flight concurrency, adds drain-aware scale-down, and pre-provisions capacity so bursts never wait on a node."
excerpt: "CPU utilization barely moves while an I/O-bound MCP server is completely busy. Scale on in-flight concurrency instead, protect busy replicas on the way down, and put capacity in place before the pods need it."
keywords: "mcp, kubernetes, keda, autoscaling, karpenter, hpa, concurrency, agent workloads, agentic infrastructure"
twitter_card: "summary_large_image"
categories:
  - cloud
  - devops
tags: [mcp, kubernetes, keda, autoscaling, karpenter, aws, azure]
series: "Agentic Infrastructure"
series_order: 6
---

> The 70% that doesn't mean anything

The HorizontalPodAutoscaler in [Deploying MCP Servers on Kubernetes](/blogs/deploying-mcp-servers-on-kubernetes/) was labelled a starting point, with its weakness stated up front: CPU utilization doesn't track what an I/O-bound server is doing. This article replaces it, and the reason is worth seeing in numbers before touching any YAML.

Take a replica holding 20 concurrent tool calls, each waiting around 25 seconds on a downstream API. The pod is fully occupied: every call it accepts is parked until its response arrives. CPU is nearly idle, because waiting costs almost nothing. The autoscaler sees 5-6% utilization and holds the replica count at the minimum while the 21st caller queues behind work that isn't computing anything. (These figures are illustrative, not a benchmark; the shape is what matters.) The failure also runs in reverse. When a burst of queued calls all return at once, CPU spikes after the damage is done, and the autoscaler scales up for load that has already passed.

The signal that tracks agent load is concurrency: how many calls a replica is holding right now. Inference-serving stacks reached the same conclusion about LLM workloads, where queue depth and in-flight requests drive scaling because accelerator utilization sits high at both low and high concurrency. An MCP server fronting slow tools has the same property from the other side, with CPU pinned low at every load level.

## Instrument the signal first

Nothing can scale on concurrency until the server reports it. A Prometheus gauge incremented when a call starts and decremented when it finishes is enough, plus a plain counter the rest of this article reuses:

```typescript
import { Gauge } from "prom-client";

const inflight = new Gauge({
  name: "mcp_inflight_calls",
  help: "Tool calls currently executing in this pod",
});
let active = 0;       // same number, readable without scraping
let draining = false; // flipped on SIGTERM; /ready returns 503 while true

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

Wrap every tool handler in `withTracking`, and the gauge becomes the demand signal. If the server uses the Tasks extension with a work queue, queued-task depth is the complementary signal, because it shows load that hasn't reached a replica yet.

## Let readiness carry the capacity signal

Autoscaling reacts on a delay: a 15-second polling interval, then however long a new pod takes to start. During that gap the existing replicas keep taking calls. The readiness probe from [Why Agent Infrastructure Is Its Own Discipline](/blogs/why-agent-infrastructure-is-its-own-discipline/) was defined as "can this pod accept new work right now," and this is where that definition earns its keep: a pod at its concurrency ceiling should say no, so the Service routes new calls to replicas that still have room.

```typescript
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 12);

app.get("/ready", (_req, res) => {
  // Not ready for new work while draining or at the ceiling.
  // /health stays a pure liveness check and is unaffected.
  const ready = !draining && active < MAX_CONCURRENCY;
  res.status(ready ? 200 : 503).end();
});
```

Treat this as a backstop, not a limiter. With the probe settings from the deployment article (every 5 seconds, two failures), a saturated pod stays in rotation for up to about ten seconds before it's removed. If every replica reaches the ceiling at once, the Service has no ready endpoints and callers get errors instead of queueing, which is why the autoscaling threshold has to sit well below the ceiling, and why the ceiling itself needs a hard check in the handler where overload would be damaging.

## Replace the HPA with KEDA

KEDA's Prometheus scaler queries Prometheus directly and generates the HPA itself, so no Prometheus Adapter is needed; inference-serving projects now document it as the supported path. On AKS KEDA is a managed add-on, and on EKS it's a Helm install:

```bash
# AKS: managed add-on
az aks update --resource-group rg-mcp --name aks-mcp --enable-keda

# EKS: Helm
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace
```

Then define the ScaledObject. The scale-up and scale-down policies are deliberately asymmetric, extending the stabilization windows from the earlier HPA:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: mcp-server
spec:
  scaleTargetRef:
    name: mcp-server
  minReplicaCount: 3
  maxReplicaCount: 16            # bounded by the tenant ResourceQuota, see below
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
        threshold: "8"           # target concurrent calls per replica
```

With `AverageValue`, desired replicas is the summed in-flight count divided by the threshold, rounded up. Scale-up has no stabilization delay and can double every 30 seconds; scale-down removes one pod a minute after a five-minute window, so a lull between bursts doesn't strip capacity the next burst needs.

The old resource-based HPA has to go first, because two autoscalers on one Deployment fight each other:

```bash
kubectl delete hpa mcp-server
kubectl get scaledobject mcp-server
kubectl get hpa keda-hpa-mcp-server -w
```

Two limits on that `maxReplicaCount: 16` matter. The quota in [Multi-Tenant MCP: Isolation Patterns That Hold Up](/blogs/multi-tenant-mcp-isolation-patterns/) allowed `requests.cpu: "4"`, and at 250m per pod that's 16 replicas, tighter than the quota's `pods: "20"`. A ceiling above that makes the autoscaler request pods the quota rejects. The second limit is downstream: if a tool calls an API with a rate limit, more replicas just hit that limit harder. Cap the maximum at what the slowest dependency can absorb.

For managed Prometheus (Amazon Managed Prometheus or Azure Monitor managed Prometheus), the `serverAddress` and authentication change. KEDA authenticates with a `TriggerAuthentication` bound to workload identity, so check the Prometheus scaler's auth docs for your provider.

## Scale-down is where agents get hurt

Scaling up is forgiving: a slow replica costs latency. Scaling down can destroy work. When the autoscaler removes a replica, Kubernetes picks which pod to terminate with no knowledge of which one is mid-task, and a lightly loaded node can be consolidated out from under a busy one. Three controls address this. None of them requires the autoscaler to understand agents.

**Make the busiest pod the last to go.** The `controller.kubernetes.io/pod-deletion-cost` annotation tells the ReplicaSet to terminate lower-cost pods first when scaling down. Publishing each pod's in-flight count as its cost makes idle replicas go before busy ones. The same update can set `karpenter.sh/do-not-disrupt` while a pod holds work, which blocks voluntary node consolidation:

```typescript
const API = "https://kubernetes.default.svc";
const POD = process.env.POD_NAME!;
const NS = process.env.POD_NAMESPACE!;
let published = -1;

// Runs on a timer, not per call: frequent annotation updates load the API server
setInterval(async () => {
  const current = active;
  if (current === published) return;
  const token = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
  await fetch(`${API}/api/v1/namespaces/${NS}/pods/${POD}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      metadata: {
        annotations: {
          "controller.kubernetes.io/pod-deletion-cost": String(current),
          "karpenter.sh/do-not-disrupt": current > 0 ? "true" : null, // null removes it
        },
      },
    }),
  });
  published = current;
}, 15_000);
```

The pod needs its own name and namespace from the downward API, the cluster CA for the API call, and permission to patch pods:

```yaml
env:
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
  - name: NODE_EXTRA_CA_CERTS
    value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-annotator
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["patch"]
```

This pattern has a real cost, and it pulls against [Securing MCP in Production](/blogs/securing-mcp-servers-in-production/). Kubernetes can't scope `patch` to a pod's own name, so the Role grants patching on every pod in the namespace, and a command-injection bug in the server inherits it. If that trade is wrong for your threat model, the alternative is a small separate controller that reads the same metric and writes the annotations, keeping the permission out of the request-handling process. The timer also means the annotation can lag by up to 15 seconds, which is why the next control exists.

**Drain on SIGTERM.** The `/ready` probe from the first article in this series is what takes a draining pod out of rotation, while the process waits for held calls to finish:

```typescript
process.on("SIGTERM", async () => {
  draining = true;                              // /ready now returns 503
  const deadline = Date.now() + 40_000;         // inside terminationGracePeriodSeconds: 45
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  server.close(() => process.exit(0));
});
```

The 40-second deadline sits just inside the 45-second grace period, so the process exits on its own terms before Kubernetes sends SIGKILL. A single tool call that runs longer than the grace period will still be cut off, which is an argument for the per-call timeout budgets discussed earlier in this series rather than for a longer grace period.

## Capacity before the pods

Pod autoscaling is fast, but a new pod still needs a node. If the cluster is full, the pod sits Pending while a node provisions, and that gap is the actual cold start for a bursty agent workload. Two mechanisms close it.

**Placeholder pods.** A deployment of low-priority pods that reserve capacity and get evicted the moment real work needs it:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overprovisioning
value: -10
globalDefault: false
description: "Placeholder pods that real workloads preempt"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: capacity-reserve
spec:
  replicas: 2
  selector:
    matchLabels: { app: capacity-reserve }
  template:
    metadata:
      labels: { app: capacity-reserve }
    spec:
      priorityClassName: overprovisioning
      terminationGracePeriodSeconds: 0
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests: { cpu: 500m, memory: 512Mi }
```

MCP pods run at the default priority of 0, so they preempt the placeholders immediately. The evicted placeholders then go Pending, which prompts the node autoscaler to add capacity in the background. If the real pods use the gVisor `RuntimeClass` from the multi-tenant article, give the placeholders the same one so the reserved nodes are compatible.

**Node provisioning.** Karpenter on EKS and node auto-provisioning on AKS (built on Karpenter) both provision nodes from pending pods. The setting that matters for agents is how aggressively they consolidate:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: mcp-agents
spec:
  template:
    spec:
      nodeClassRef:                  # provider-specific: EC2NodeClass on EKS,
        group: karpenter.k8s.aws     # an AKS node class under node auto-provisioning
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
  limits:
    cpu: "64"
```

`consolidateAfter: 5m` stops nodes being reshuffled the instant a burst ends, and the `do-not-disrupt` annotation from the previous section protects any node still holding a task. `limits.cpu` is the cost guardrail: it caps how far a runaway signal can grow the cluster.

## Derive the threshold, don't guess

The `threshold: "8"` in the ScaledObject is a placeholder. The right number is the concurrency at which a single replica's latency starts to degrade, and it comes from a load test against a fixed replica count with autoscaling switched off:

```javascript
import http from "k6/http";
import { check } from "k6";

export const options = {
  stages: [
    { duration: "2m", target: 10 },
    { duration: "2m", target: 20 },
    { duration: "2m", target: 40 },
    { duration: "2m", target: 80 },
  ],
};

export default function () {
  const res = http.post(
    __ENV.MCP_URL,
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "slow-lookup", arguments: {} },
    }),
    { headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "slow-lookup",
    } },
  );
  check(res, { ok: (r) => r.status === 200 });
}
```

Scale the Deployment to a known size, run the ramp, and watch p95 latency against `mcp_inflight_calls` per pod. Find the concurrency where p95 first breaks your latency target, then set the threshold at roughly 70% of it. That leaves headroom for the 15-second polling interval and the time a new pod takes to become ready, during which load keeps rising. Repeat the test whenever the tool set changes, since a new slow tool shifts the number.

## What to watch once it's live

An autoscaler that's working looks the same as one that's quietly capped, so two alerts are worth wiring up on day one. The first fires when the autoscaler wants more replicas than `maxReplicaCount` allows, which means demand has outgrown the ceiling you set. The second fires when a single pod sits at its concurrency limit for several minutes, which means the threshold is too high or scale-up is too slow:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mcp-autoscaling
spec:
  groups:
    - name: mcp-autoscaling
      rules:
        - alert: McpAtReplicaCeiling
          expr: |
            kube_horizontalpodautoscaler_status_desired_replicas{horizontalpodautoscaler="keda-hpa-mcp-server"}
              >= kube_horizontalpodautoscaler_spec_max_replicas{horizontalpodautoscaler="keda-hpa-mcp-server"}
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "MCP autoscaler is pinned at maxReplicaCount; demand exceeds the ceiling"
        - alert: McpPodSaturated
          expr: max(mcp_inflight_calls{app="mcp-server"}) >= 12   # keep in step with MAX_CONCURRENCY
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "An MCP pod has sat at its concurrency ceiling for 5 minutes"
```

The first alert is the one that catches the quota and downstream-limit problems from earlier in this article before users do. A replica count stuck at the maximum for ten minutes is either a real capacity shortfall or a ceiling that was set too low, and both are worth knowing about before the next burst.

> 📌 **Key Takeaway:** An I/O-bound MCP server can be fully saturated while its CPU sits near idle, so CPU-based autoscaling reacts late or not at all. Scale on in-flight concurrency per replica, derive the threshold from a load test, and treat scale-down as the dangerous direction: make busy pods the last to be removed, drain before exit, and keep spare capacity ready so a burst never waits on a node.
