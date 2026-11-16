---
title: "Why Build a Custom Operator: Knowing When a CRD and Controller Earn Their Keep"
published: false
description: A decision framework for when a Kubernetes operator is the right tool, and a practical guide to designing the CRD API you can't easily take back.
tags: kubernetes, platform-engineering, devops, cloud-native
canonical_url: https://aloknecessary.in/blogs/why-build-a-custom-operator/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=why-build-a-custom-operator
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a Kubernetes control loop — a custom resource object at the top feeding into a reconcile loop that drives cluster state. Glowing CRD schema nodes connected by directed arrows to namespace, quota, and network policy icons arranged in a dependency graph. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Most custom operators shouldn't exist. They usually start the same way: someone has a script that applies five manifests in the right order, someone else says "that should really be an operator," and a few months later the team owns a Go service with cluster-wide write permissions, a CRD that can't change without a migration plan, and exactly one engineer who understands how it works.

This article is about telling the difference before `kubebuilder init` — and then, for the cases that pass, designing the part you can't easily take back: the API.

---

## What an Operator Actually Is

An operator is two things: a CustomResourceDefinition (CRD) that adds a new resource type to the Kubernetes API, and a controller that watches those resources and drives the cluster toward what they declare.

```text
        kubectl apply / GitOps
                  │
                  ▼
      ┌───────────────────────┐
      │  API server           │   CRD = the API surface
      │  TenantEnvironment    │   (schema, validation, versions)
      └──────────┬────────────┘
                 │ watch events
                 ▼
      ┌───────────────────────┐
      │  Controller (a Pod)   │   compares desired (spec) with observed
      │  reconcile loop       │   state and acts on the difference
      └──────────┬────────────┘
                 │ create / update / delete
                 ▼
   Namespace · ResourceQuota · NetworkPolicy · RoleBinding
```

Helm renders templates and applies them when you run an install or upgrade — after that, nothing watches the result. A controller never stops watching. That is the entire distinction, and it explains why operators fit some problems and are wasted on others.

## The Decision Table

Before writing any code, run through this table:

| Need | Reach for | Why not an operator |
| --- | --- | --- |
| Parameterised install, same every time | Helm / Kustomize via GitOps | Nothing to reconcile beyond what GitOps already does |
| Run something on a schedule | CronJob | No desired-state object to maintain |
| Enforce or default fields on resources | ValidatingAdmissionPolicy, Kyverno, Gatekeeper | Policy engines already own the admission plumbing |
| Stamp out objects per tenant from a template | ApplicationSet generators, Kyverno `generate` | Fine until you need ordering, cleanup, or status |
| Manage cloud resources (S3, RDS, Azure SQL) | ACK, Azure Service Operator, Crossplane | Maintained operators already cover that API surface |
| Continuously reconcile coupled resources with ordered lifecycle, cleanup on delete, and one status surface | A custom operator | This is the gap |

The cloud-resource row deserves emphasis — it's the most common mistake. ACK, Azure Service Operator, and Crossplane already ship CRDs and controllers for most managed services. The gap worth filling sits above them: a smaller, opinionated API that composes those resources with in-cluster objects.

## Four Tests That Separate Real Operator Cases

1. **Ongoing drift** — something needs correcting after creation, not just at creation
2. **Ordered lifecycle** — create A before B, delete in reverse, or sequence upgrades
3. **A smaller API than what it creates** — consumers write a few lines instead of four manifests
4. **A status surface** — consumers need to ask one object whether it worked

Test one is the subtle one, because GitOps already corrects drift on what it manages. Argo CD's self-heal will recreate a deleted NetworkPolicy declared in Git. The operator case appears when what must be restored isn't a static manifest but something *computed* from a spec — the quota that depends on `tier`, the RoleBinding whose subjects come from `owner`. If a template plus a GitOps controller can express the desired state, test one is already satisfied without custom code.

## Designing the API First

The controller is replaceable; the API is not. Once teams commit `TenantEnvironment` manifests to Git, every field is a contract.

Key rules:

- **Spec is intent, status is observation.** Nothing the controller computes belongs in `spec`. Enable the status subresource so spec and status go through separate endpoints with separate RBAC.
- **Declare state, not actions.** `spec.maxPods: 40` is state. `spec.recreateQuota: true` is a command that has to be cleared after it runs and means nothing on the second reconcile.
- **Push validation into the schema.** CEL rules (`x-kubernetes-validations`, GA since Kubernetes 1.29) cover cross-field checks and immutability. The API server rejects bad input before the controller sees it.
- **Choose scope deliberately.** A CRD's scope can't be changed after creation.

```go
// +kubebuilder:validation:XValidation:rule="self.tier != 'sandbox' || self.maxPods <= 20",message="sandbox tier is capped at 20 pods"
type TenantEnvironmentSpec struct {
    // +kubebuilder:validation:XValidation:rule="self == oldSelf",message="owner is immutable"
    Owner string `json:"owner"`

    // +kubebuilder:validation:Enum=sandbox;standard;restricted
    // +kubebuilder:default=standard
    Tier string `json:"tier,omitempty"`

    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=500
    // +kubebuilder:default=50
    MaxPods int32 `json:"maxPods,omitempty"`
}
```

Two smells show up early in review: exposing a raw Kubernetes type (embedding a full `PodSpec` in `spec` commits you to every field and every future change), and secret material in `spec` (reference a Secret by name, never carry the value).

## What the API Server Enforces

`make manifests` turns those markers into the CRD. Apply a resource that breaks the cross-field rule:

```yaml
spec:
  owner: payments-team
  tier: sandbox
  maxPods: 40
```

```text
The TenantEnvironment "payments-sandbox" is invalid: spec: Invalid value: "object": sandbox tier is capped at 20 pods
```

The request dies at the API server. The controller never runs, never logs, and never needs a defensive branch for it.

## What You're Signing Up For

- **Cluster-scoped privilege** — the controller's ServiceAccount holds RBAC for everything it creates. Granting RoleBindings triggers Kubernetes' privilege-escalation check.
- **CRD delivery is its own problem** — Helm installs CRDs on first install but never upgrades them. Schema changes need an explicit delivery path.
- **Degraded mode is a design input** — if the controller is down, drift goes uncorrected and objects it must clean up on delete stay in `Terminating`.
- **Cloud identity if it touches cloud APIs** — IRSA or EKS Pod Identity on AWS, Workload Identity on AKS. Never a static credential.
- **A permanent maintenance line** — controller-runtime releases track Kubernetes minor versions. Each cluster upgrade eventually means a dependency bump and a regression pass on code only your team understands.

---

## Read the Full Article

The full post covers:

- The complete Kubebuilder scaffold and directory layout
- The full `TenantEnvironmentSpec`, `TenantEnvironmentStatus`, and marker annotations with printer columns
- The generated CRD YAML and how CEL validation maps from Go markers to `x-kubernetes-validations`
- The `kubectl get tenv` output showing the status surface in practice
- A pre-flight checklist of five questions to answer before running `kubebuilder init`

**👉 [Why Build a Custom Operator: Knowing When a CRD and Controller Earn Their Keep — Full Article](https://aloknecessary.in/blogs/why-build-a-custom-operator/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=why-build-a-custom-operator)**
