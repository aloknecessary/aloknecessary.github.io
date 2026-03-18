---
title: "Self-Hosted Runners on Kubernetes: Architecture, Security, and Cost Analysis"
date: 2026-02-26
last_modified_at: 2026-02-26
author: Alok Ranjan Daftuar
description: "Deep dive into self-hosted GitHub Actions runners on Kubernetes — isolation models, blast radius, security hardening, and cost vs managed runners."
excerpt: "Running GitHub Actions self-hosted runners on Kubernetes at scale requires careful architectural decisions around isolation, security, and cost. This deep dive covers Actions Runner Controller (ARC) deployment patterns, namespace vs node-level isolation models, blast radius analysis, security hardening strategies, and realistic cost comparisons against GitHub-managed runners. Learn when self-hosted makes sense and how to implement it safely."
keywords: "self-hosted runners kubernetes, github actions kubernetes, ARC actions runner controller, runner isolation, CI/CD security"
categories:
  - architecture
  - system-design
  - devops
tags: [kubernetes, github-actions, devops, ci-cd, security, arc, container-security, cloud-architecture, platform-engineering, automation]
---

## Introduction

Running CI/CD workloads at scale forces a reckoning with a deceptively simple question: *who controls the machines your code runs on?* GitHub's managed runners hand that control to GitHub. Self-hosted runners hand it back to you — along with every operational burden that comes with it.

This post is a technical deep-dive into running self-hosted GitHub Actions runners on Kubernetes using the [Actions Runner Controller (ARC)](https://github.com/actions/actions-runner-controller). We'll cover isolation models, blast radius analysis, security hardening, and a realistic cost comparison against managed runners. By the end, you'll have the mental model to decide which path is right for your workload — and the configuration to get there if you go self-hosted.

<!--more-->

---

## Why Kubernetes for Runners?

Before ARC, self-hosted runners were typically long-lived VMs or bare-metal machines — stateful, hard to scale, and expensive to maintain. Kubernetes changes the equation:

- **Ephemeral pods** replace persistent VMs; each job gets a fresh environment.
- **HPA / KEDA** autoscale runner replicas based on queue depth.
- **Node pools** let you isolate workloads by resource class (CPU-heavy builds, GPU inference tests, etc.).
- **Namespacing and RBAC** give you a native isolation boundary you control.

The tradeoff is real though: you own the control plane, the node OS patching, the runner image maintenance, and all the operational observability. That's not free.

---

## Architecture: Actions Runner Controller (ARC)

ARC is the Kubernetes operator that manages the lifecycle of runner pods. As of 2024, the canonical implementation is the `gha-runner-scale-set` pattern (replacing the older `RunnerDeployment` / `HorizontalRunnerAutoscaler` model).

### Component Overview

```
GitHub Actions API
       │
       ▼
┌─────────────────────────────────────────┐
│         ARC Controller Manager          │  ← watches CRDs, talks to GitHub API
│  (gha-runner-scale-set-controller)      │
└────────────────┬────────────────────────┘
                 │ manages
                 ▼
┌─────────────────────────────────────────┐
│         AutoscalingRunnerSet CRD        │  ← one per runner group/scale set
│  namespace: arc-runners                 │
└────────────────┬────────────────────────┘
                 │ creates
                 ▼
┌─────────────────────────────────────────┐
│         EphemeralRunner Pod             │  ← one per queued job
│  - init container: runner registration  │
│  - main container: job execution        │
│  - dind sidecar (optional)              │
└─────────────────────────────────────────┘
```

### Minimal ARC Installation

```bash
# Install the controller
helm install arc \
  --namespace arc-systems \
  --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

# Install a runner scale set
helm install arc-runner-set \
  --namespace arc-runners \
  --create-namespace \
  --set githubConfigUrl="https://github.com/your-org/your-repo" \
  --set githubConfigSecret=gh-token-secret \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

```yaml
# gh-token-secret.yaml (use a GitHub App in prod, not a PAT)
apiVersion: v1
kind: Secret
metadata:
  name: gh-token-secret
  namespace: arc-runners
stringData:
  github_token: ghp_XXXXXXXXXXXXXXXXXXXX
```

**Production recommendation**: Use a GitHub App for authentication instead of a PAT. App tokens are short-lived (1h), scoped to specific repos/orgs, and have granular permissions.

```yaml
# GitHub App auth secret
apiVersion: v1
kind: Secret
metadata:
  name: gh-app-secret
  namespace: arc-runners
stringData:
  github_app_id: "12345"
  github_app_installation_id: "67890"
  github_app_private_key: |
    -----BEGIN RSA PRIVATE KEY-----
    ...
    -----END RSA PRIVATE KEY-----
```

---

## Isolation Models

This is where architecture decisions get consequential. You have four practical isolation models, each trading security boundary strength against operational cost.

### Model 1: Shared Node Pool, Shared Namespace

All runners run in the same namespace on the same node pool. Fast to set up, cheap to operate. Acceptable for trusted internal teams running non-sensitive workloads.

```yaml
# Single scale set, no node affinity
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: arc-runner-shared
  namespace: arc-runners
spec:
  values:
    maxRunners: 20
    minRunners: 0
    template:
      spec:
        containers:
          - name: runner
            image: ghcr.io/actions/actions-runner:latest
            resources:
              requests: { cpu: "1", memory: "2Gi" }
              limits:   { cpu: "4", memory: "8Gi" }
```

**Blast radius**: A compromised runner pod can potentially access Kubernetes API via the default service account, read secrets in the same namespace, and influence other pods on the same node via kernel exploits.

### Model 2: Namespace Isolation Per Team/Project

Each team or project gets its own namespace with a dedicated runner scale set and RBAC. This is the most common production pattern.

```yaml
# team-a/runners/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-a-runners
resources:
  - runner-scale-set.yaml
  - rbac.yaml
  - network-policy.yaml
```

```yaml
# rbac.yaml — restrict the runner's service account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: runner-sa
  namespace: team-a-runners
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: runner-role
  namespace: team-a-runners
rules: []  # No permissions — runners don't need cluster access
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: runner-rolebinding
  namespace: team-a-runners
subjects:
  - kind: ServiceAccount
    name: runner-sa
roleRef:
  kind: Role
  name: runner-role
  apiGroup: rbac.authorization.k8s.io
```

```yaml
# network-policy.yaml — default deny, allow only egress needed
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-netpol
  namespace: team-a-runners
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: []   # No inbound traffic to runner pods
  egress:
    - to: []
      ports:
        - port: 443
          protocol: TCP
        - port: 53
          protocol: UDP
```

**Blast radius**: Contained to the namespace. A compromised runner cannot read secrets from `team-b-runners` namespace. Lateral movement to other namespaces requires an additional privilege escalation vector.

### Model 3: Node-Level Isolation (Dedicated Node Pools)

For high-security workloads — deploying to production, handling secrets, processing PII — you want runner pods on dedicated nodes that normal workloads cannot be scheduled on.

```yaml
# Dedicated runner node pool (AKS example via Bicep/Terraform, shown as nodeSelector pattern)
# Node labeled: role=ci-runners, team=platform

# runner-scale-set values.yaml
template:
  spec:
    nodeSelector:
      role: ci-runners
    tolerations:
      - key: "ci-only"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
```

```bash
# Taint the node pool so only runner pods can schedule here
kubectl taint nodes -l role=ci-runners ci-only=true:NoSchedule
```

**Blast radius**: A node-level exploit is still possible, but the blast radius is limited to the CI node pool. Your application workloads are on separate nodes and cannot be accessed via node-level container escapes.

### Model 4: VM-Level Isolation (Kata Containers / Firecracker)

For the highest security requirement — running untrusted third-party code, open-source contribution pipelines — use VM-based sandboxing with Kata Containers or Firecracker on top of Kubernetes.

```yaml
# RuntimeClass for Kata Containers
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-containers
handler: kata
---
# Apply to runner pods
template:
  spec:
    runtimeClassName: kata-containers
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
```

Each pod runs inside a lightweight VM. A container escape does not compromise the host kernel. This comes with ~20-30% overhead on compute and significantly higher operational complexity.

**Blast radius**: Near-zero lateral movement. Kernel exploits are contained within the microVM boundary.

---

## Blast Radius Analysis

Here's a consolidated view of each model's failure surface:

| Isolation Model | Namespace Lateral Move | Node Lateral Move | Cloud API Blast | Setup Complexity | Cost Overhead |
|---|---|---|---|---|---|
| Shared pool/namespace | High | High | High | Low | None |
| Namespace per team | **Low** | Medium | Medium | Medium | Low |
| Dedicated node pools | **Low** | **Low** | Medium | Medium-High | 15–30% |
| Kata/Firecracker VMs | **None** | **None** | Low | High | 20–40% |

"Cloud API blast" refers to the risk of a compromised runner abusing the node's instance metadata service (IMDS) to retrieve cloud credentials. Mitigate this with:

```yaml
# Block IMDS access via network policy (AWS: 169.254.169.254, Azure: 169.254.169.254/GCP: 169.254.169.254)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: block-imds
  namespace: arc-runners
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.169.254/32  # Block IMDS
      ports:
        - port: 443
        - port: 80
        - port: 53
          protocol: UDP
```

For AWS EKS, use pod-level IAM roles (IRSA) scoped to the minimum required permissions instead of relying on node-level instance profiles.

---

## Security Hardening Checklist

Beyond isolation models, harden individual runner pods:

### Drop Capabilities and Enforce Read-Only Filesystem

```yaml
template:
  spec:
    securityContext:
      runAsNonRoot: true
      runAsUser: 1001
      fsGroup: 1001
      seccompProfile:
        type: RuntimeDefault
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: [ALL]
        volumeMounts:
          - name: tmp
            mountPath: /tmp
          - name: work
            mountPath: /home/runner/_work
    volumes:
      - name: tmp
        emptyDir: {}
      - name: work
        emptyDir: {}
```

### Docker-in-Docker vs. Rootless Buildah

Running Docker inside a runner pod is a common requirement and a common source of privilege escalation. Avoid privileged DinD where possible.

**Option A: DinD with user namespaces (less bad)**

```yaml
# dind sidecar, not recommended for high-security environments
- name: dind
  image: docker:24-dind
  securityContext:
    privileged: true  # ← still required for standard DinD
  env:
    - name: DOCKER_TLS_CERTDIR
      value: /certs
```

**Option B: Rootless Buildah (recommended)**

```yaml
# Use Buildah for OCI image builds without Docker socket or privileged mode
- name: runner
  image: your-registry/runner-with-buildah:latest
  securityContext:
    runAsUser: 1001
    allowPrivilegeEscalation: false
  env:
    - name: BUILDAH_ISOLATION
      value: chroot  # or 'rootless' with user namespaces configured
```

```dockerfile
# Dockerfile for a runner with rootless buildah
FROM ghcr.io/actions/actions-runner:latest
USER root
RUN apt-get update && apt-get install -y buildah fuse-overlayfs
# Configure subuid/subgid for rootless operation
RUN echo "runner:100000:65536" >> /etc/subuid && \
    echo "runner:100000:65536" >> /etc/subgid
USER runner
```

**Option C: Kaniko for image builds in CI**

```yaml
# In your workflow, use Kaniko as a build step — no Docker daemon needed
- name: Build Image
  uses: docker://gcr.io/kaniko-project/executor:latest
  with:
    args: --dockerfile=Dockerfile --context=. --destination=your-registry/app:{% raw %}${{ github.sha }}{% endraw %}
```

### Secret Management — Don't Use Env Vars

Never inject secrets as environment variables into runner pods if they can be stored in a secrets manager and fetched at runtime.

```yaml
# workflow: use OIDC + AWS Secrets Manager instead of env var secrets
- name: Configure AWS Credentials via OIDC
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
    aws-region: us-east-1

- name: Get DB Password from Secrets Manager
  run: |
    DB_PASS=$(aws secretsmanager get-secret-value \
      --secret-id prod/db/password \
      --query SecretString \
      --output text)
    echo "::add-mask::$DB_PASS"
```

Configure the OIDC trust policy on the IAM role to scope it to your specific repo and branch:

```json
{
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:ref:refs/heads/main"
    }
  }
}
```

---

## Cost Analysis: Self-Hosted vs. Managed Runners

This is where teams often have inflated expectations. Self-hosted is *not always cheaper*. Let's be precise.

### Managed Runner Pricing (GitHub-hosted, as of early 2025)

| Runner Type | Price per Minute |
|---|---|
| ubuntu-latest (2-core) | $0.008 |
| ubuntu-latest (4-core) | $0.016 |
| ubuntu-latest (16-core) | $0.064 |
| ubuntu-latest (64-core) | $0.256 |

For a team running 500 CI minutes/day on 4-core runners:

```
500 min/day × $0.016/min × 22 workdays/month = $176/month
```

### Self-Hosted on Kubernetes (EKS example)

Assume a dedicated node pool of 3× `m6i.xlarge` (4 vCPU, 16GB) in us-east-1, on-demand pricing:

```
3 nodes × $0.192/hr × 730 hrs/month = $420/month

Add:
- EKS cluster overhead (control plane): $73/month
- NAT Gateway (egress for pulls): ~$50/month
- Persistent storage (PVCs for cache): ~$20/month
- Engineer time for maintenance: 2–4 hrs/month × $150/hr = $300–600/month

Total self-hosted: $863–$1,163/month
```

At that workload level, managed runners at $176/month are dramatically cheaper.

### When Self-Hosted Wins

Self-hosted becomes cost-effective when:

**1. Volume is high.** GitHub charges per minute. Your infrastructure cost is largely fixed (you pay for nodes whether idle or not). The crossover typically happens around 5,000–10,000 CI minutes/month depending on runner size.

```
Break-even (4-core equivalent):
Fixed cost: ~$860/month
Managed cost per minute: $0.016

Break-even = $860 / $0.016 = 53,750 minutes/month (~1,790 min/day)
```

**2. You need hardware you can't get from managed runners.** GPU nodes for ML testing, ARM64 for multi-arch builds, high-memory nodes (>64GB) for monorepo builds, or specific CPU architectures.

**3. Data residency or network requirements.** If your build artifacts, source code, or test data cannot leave a specific network boundary, managed runners are off the table. Self-hosted in your VPC is the only option.

**4. Caching dramatically changes the economics.** Managed runners lose cache between jobs (S3/GCS cache actions add latency and cost). Self-hosted runners can use a shared PVC or a local registry/cache service:

```yaml
# Local registry mirror for fast image pulls
# Deploy in-cluster: distribution/distribution

# Persistent cache via actions/cache with local backend
- name: Cache Go Modules
  uses: actions/cache@v4
  with:
    path: /home/runner/.cache/go
    key: {% raw %}${{ runner.os }}{% endraw %}-go-{% raw %}${{ hashFiles('**/go.sum') }}{% endraw %}
    # With self-hosted + local PVC: cache hits are instant, no S3 latency
```

**5. Reserved/Spot instances.** Self-hosted on Spot (AWS) or Spot VMs (Azure) with proper interruption handling can reduce node costs 60–70%:

```yaml
# Karpenter provisioner for spot-first runner nodes
apiVersion: karpenter.sh/v1alpha5
kind: Provisioner
metadata:
  name: ci-runners
spec:
  requirements:
    - key: karpenter.sh/capacity-type
      operator: In
      values: ["spot", "on-demand"]
    - key: node.kubernetes.io/instance-type
      operator: In
      values: ["m6i.xlarge", "m6a.xlarge", "m5.xlarge"]
  limits:
    resources:
      cpu: 100
  taints:
    - key: ci-only
      value: "true"
      effect: NoSchedule
```

Pair this with KEDA to scale runner replicas based on GitHub Actions queue depth:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: arc-runner-scaledobject
  namespace: arc-runners
spec:
  scaleTargetRef:
    apiVersion: actions.github.com/v1alpha1
    kind: AutoscalingRunnerSet
    name: arc-runner-set
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
    - type: github-runner
      metadata:
        githubApiURL: "https://api.github.com"
        owner: "your-org"
        runnerScope: "org"
        targetWorkflowQueueLength: "1"
      authenticationRef:
        name: keda-github-auth
```

---

## When Managed Runners Are the Better Choice

Don't let the engineering appeal of a custom platform override the economics and operational reality. Choose managed runners when:

**Low-to-medium CI volume** (< 5,000 min/month). The fixed cost of self-hosted infrastructure plus maintenance engineering time exceeds managed runner costs by a wide margin.

**Small or early-stage teams.** Every hour spent on runner infrastructure is an hour not spent on product. GitHub's managed runners are production-hardened, automatically updated, and require zero operational overhead.

**Security posture doesn't require network isolation.** If your workloads don't have data residency requirements and you're not deploying to production directly from CI, managed runners with OIDC are secure enough and simpler.

**You need Windows or macOS builds.** Self-hosted Windows/macOS on Kubernetes is genuinely complex. GitHub's managed runners handle this natively.

**Compliance requirements map to GitHub's attestations.** GitHub maintains SOC 2, ISO 27001 certifications. If your compliance framework accepts these, self-hosted adds compliance burden, not relief.

---

## Observability for Self-Hosted Runners

If you go self-hosted, you own the observability too. At minimum:

```yaml
# Scrape runner pod metrics via Prometheus
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: arc-runner-monitor
  namespace: arc-runners
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: gha-runner-scale-set
  podMetricsEndpoints:
    - port: metrics
      interval: 30s
```

Key metrics to track:

- `arc_runner_queue_depth` — jobs waiting for a runner (signals scaling lag)
- `arc_runner_pod_startup_seconds` — time from job queued to runner ready (image pull latency dominates here)
- `arc_runner_job_duration_seconds` — per-workflow job duration trends
- Pod OOMKilled events — signals misconfigured resource limits

Log aggregation from runner pods to your central log backend (Loki, CloudWatch, etc.) should capture:

- Job start/end with run ID and workflow name
- Any `actions/runner` process crash logs
- DinD/Buildah build logs if image builds are part of CI

---

## Decision Framework

```
Is your CI volume > 5,000 min/month?
├── No  → Use managed runners. Revisit in 6 months.
└── Yes → Do you have network/data isolation requirements?
          ├── Yes → Self-hosted is required. Choose isolation model.
          └── No  → Do you need specialized hardware (GPU, ARM, high-mem)?
                    ├── Yes → Self-hosted on dedicated node pools.
                    └── No  → Run the break-even calculation.
                              Is self-hosted cheaper including engineer time?
                              ├── Yes → Self-hosted with namespace isolation.
                              └── No  → Managed runners (larger runner types).
```

For isolation model selection:

```
Are workflows running untrusted/external contributor code?
├── Yes → Kata Containers / Firecracker isolation.
└── No  → Are multiple teams sharing the cluster?
          ├── Yes → Namespace isolation per team, dedicated node pools for sensitive workloads.
          └── No  → Namespace isolation is sufficient.
```

---

## Conclusion

Self-hosted runners on Kubernetes give you a powerful, flexible CI platform — but they're not universally better than managed runners. The architecture is sound, the tooling (ARC, KEDA, Karpenter) is mature, and the security controls are sophisticated when implemented correctly.

The key decision variables are volume (does self-hosted break even?), isolation requirements (do your workloads demand it?), and operational capacity (do you have the platform engineering bandwidth to maintain it?).

If you clear those bars, namespace isolation per team with dedicated node pools for sensitive workloads is the right starting point. Layer in rootless image builds, OIDC-based cloud auth, IMDS blocking, and Spot instances for cost efficiency — and you'll have a CI platform that's both cheaper at scale and more secure than the default managed runner configuration.

Start simple. Measure. Scale the isolation to match your actual threat model, not your theoretical one.

---

*Have questions about ARC architecture or runner security configurations? Reach out via the comments or connect on LinkedIn.*
