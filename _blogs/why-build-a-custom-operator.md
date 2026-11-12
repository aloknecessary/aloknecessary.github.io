---
title: "Why Build a Custom Operator: Knowing When a CRD and Controller Earn Their Keep"
date: 2026-11-12
last_modified_at: 2026-11-12T12:31:05+05:30
author: Alok Ranjan Daftuar
description: "A decision framework for when a Kubernetes operator is the right tool, and a practical guide to designing the CRD API — the part you can't easily take back."
excerpt: "An operator is a long-running program you now deploy, upgrade, and carry a pager for. How to tell when that cost is justified, and how to design the one part you can't easily take back: the API."
keywords: "kubernetes operators, custom resource definition, controller-runtime, kubebuilder, operator pattern, CRD design, platform engineering"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [kubernetes-operators, controller-runtime, crd, kubebuilder, operator-pattern]
series: "Kubernetes Operators in Practice"
series_order: 1
---

Most custom operators shouldn't exist. They usually start the same way: someone has a script that applies five manifests in the right order, someone else says "that should really be an operator," and a few months later the team owns a Go service with cluster-wide write permissions, a CRD that can't change without a migration plan, and exactly one engineer who understands how it works.

Operators get treated as a maturity badge, the thing you build once Helm and Kustomize start to feel small. That framing is backwards. An operator is a long-running program you deploy, monitor, upgrade, and carry a pager for, and it runs with the cluster privileges of everything it manages. Sometimes that cost is exactly right. This article is about telling the difference before `kubebuilder init`, and then, for the cases that pass, designing the part you can't easily take back: the API.

## What an operator actually is

An operator is two things: a CustomResourceDefinition (CRD) that adds a new resource type to the Kubernetes API, and a controller that watches those resources and drives the cluster toward what they declare. If you've run Argo CD, you've already been using operators. `Application`, `ApplicationSet`, and `AppProject` (see [repo structure and application patterns](/blogs/gitops-repo-structure-application-patterns/)) are CRDs, and Argo CD's controllers reconcile them. Argo Rollouts' `Rollout` works the same way.

The example used throughout this article is a `TenantEnvironment`: a cluster-scoped resource that gives a team a namespace with a quota, a default-deny network policy, and a role binding.

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
                 │
                 ▼
      status written back ──► TenantEnvironment.status
```

Helm renders templates and applies them when you run an install or upgrade; after that, nothing watches the result. A controller never stops watching. That is the entire distinction, and it explains why operators fit some problems and are wasted on others.

## Do you need one?

| Need | Reach for | Why not an operator |
| --- | --- | --- |
| Enforce or default fields on resources other people create | ValidatingAdmissionPolicy (CEL, GA in Kubernetes 1.30), Kyverno, Gatekeeper | Policy engines already own the admission plumbing |
| Stamp out objects per tenant or app from a template | ApplicationSet generators, Kyverno `generate` rules | Fine until you need ordering, cleanup, or status |
| Manage cloud resources (S3, RDS, Azure SQL, Service Bus) from the cluster | ACK, Azure Service Operator, Crossplane | Maintained operators already cover that API surface |
| Continuously reconcile coupled resources with an ordered lifecycle, cleanup on delete, and one status surface for consumers | A custom operator | This is the gap |

The cloud-resource row deserves emphasis because it's the most common mistake on both AWS and Azure. AWS Controllers for Kubernetes, Azure Service Operator, and Crossplane already ship CRDs and controllers for most managed services. Writing your own `Bucket` operator means re-implementing their drift handling, deletion policies, and credential plumbing. The gap worth filling sits above them: a smaller, opinionated API that composes those resources with in-cluster objects.

Four tests separate a real operator case from a script wearing a controller costume:

1. **Ongoing drift.** Something needs correcting after creation, not just at creation.
2. **Ordered lifecycle.** Create A before B, delete in reverse, or sequence upgrades.
3. **A smaller API than what it creates.** Consumers should write a few lines instead of four manifests.
4. **A status surface.** Consumers need to ask one object whether it worked.

Test one is the subtle one, because GitOps already corrects drift on what it manages. Argo CD's self-heal will recreate a deleted NetworkPolicy that's declared in Git. The operator case appears when what must be restored isn't a static manifest but something computed from a spec: the quota that depends on `tier`, the RoleBinding whose subjects come from `owner`. If a template plus a GitOps controller can express the desired state, test one is already satisfied without custom code.

For `TenantEnvironment`, all four hold. Someone deletes the NetworkPolicy and it must come back; the namespace must exist before the quota and be removed last; a team writes six lines of YAML instead of four manifests; and "is my environment ready" has a single answer. Had only the first test passed, a Kyverno `generate` rule with synchronization would do the job with no code to own.

## Scaffold the project

Kubebuilder wires up controller-runtime: the manager, a caching client, a leader-election flag, a metrics endpoint, and generators that turn Go markers into CRD YAML and RBAC.

```bash
kubebuilder init --domain example.org --repo github.com/example-org/tenant-operator
kubebuilder create api --group platform --version v1alpha1 \
  --kind TenantEnvironment --resource --controller
```

```text
tenant-operator/
├── api/v1alpha1/
│   └── tenantenvironment_types.go       # the API: spec, status, validation markers
├── internal/controller/
│   └── tenantenvironment_controller.go  # reconcile logic
├── cmd/main.go                          # manager setup
└── config/
    ├── crd/bases/                       # generated CRD YAML
    ├── rbac/                            # generated roles from markers
    └── manager/                         # controller Deployment
```

Go with controller-runtime is the default for good reasons: the largest ecosystem, the best-documented patterns, and Kubebuilder's generators. It isn't the only option. KubeOps for .NET, the Java Operator SDK, Kopf for Python, and kube-rs for Rust all implement the same watch-and-reconcile model, and a team that ships .NET services every day can reasonably prefer the first. The API design rules below are language-independent; only the markers are Kubebuilder-specific.

You'll live in two files: the types file and the controller. Start with the types.

## Design the API first

The controller is replaceable; the API is not. Once teams commit `TenantEnvironment` manifests to Git, every field is a contract. A few rules keep that contract cheap to hold:

- **Spec is intent, status is observation.** Nothing the controller computes belongs in `spec`, and nothing the user sets belongs in `status`. Enabling the status subresource sends the two through separate endpoints with separate RBAC, and makes `metadata.generation` bump only on spec changes. That is what lets a controller record `observedGeneration` and distinguish "I've seen this version" from "I've acted on it."
- **Declare state, not actions.** `spec.maxPods: 40` is state. `spec.recreateQuota: true` is a command that has to be cleared after it runs and means nothing on the second reconcile. If you're adding a verb, you're modelling a Job, not a resource.
- **Push validation into the schema.** A structural OpenAPI v3 schema covers types, ranges, and enums. CEL rules (`x-kubernetes-validations`, GA since Kubernetes 1.29) cover cross-field checks and immutability. The API server rejects bad input before the controller sees it, with no webhook to run.
- **Choose scope and version deliberately.** A CRD's scope can't be changed after creation. Cluster scope is correct here because the resource creates namespaces. Start at `v1alpha1` and keep the first schema small: fields are easy to add and expensive to remove once consumers have stored them in Git.
- **Report status the way tooling expects.** A `metav1.Condition` list with a `Ready` condition, plus printer columns so `kubectl get` shows the answer.

Two smells show up early in review. The first is exposing a raw Kubernetes type, such as embedding a full `PodSpec` in `spec`. It looks flexible, but you've committed to supporting every field and every future change to that type. Expose the few fields consumers actually vary. The second is secret material in `spec`. Custom resources live in Git and etcd like any other manifest, so reference a Secret by name (`spec.credentialsRef`) rather than carrying the value. How those Secrets reach the cluster is a separate problem, covered in [secrets management in GitOps](/blogs/gitops-secrets-management/).

```go
// api/v1alpha1/tenantenvironment_types.go

// +kubebuilder:validation:XValidation:rule="self.tier != 'sandbox' || self.maxPods <= 20",message="sandbox tier is capped at 20 pods"
type TenantEnvironmentSpec struct {
    // Owner is the team that owns this environment.
    // +kubebuilder:validation:MinLength=3
    // +kubebuilder:validation:MaxLength=40
    // +kubebuilder:validation:XValidation:rule="self == oldSelf",message="owner is immutable"
    Owner string `json:"owner"`

    // Tier selects the quota and network profile.
    // +kubebuilder:validation:Enum=sandbox;standard;restricted
    // +kubebuilder:default=standard
    Tier string `json:"tier,omitempty"`

    // MaxPods caps total Pods in the tenant namespace.
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=500
    // +kubebuilder:default=50
    MaxPods int32 `json:"maxPods,omitempty"`
}

type TenantEnvironmentStatus struct {
    // +listType=map
    // +listMapKey=type
    Conditions         []metav1.Condition `json:"conditions,omitempty"`
    ObservedGeneration int64              `json:"observedGeneration,omitempty"`
    Namespace          string             `json:"namespace,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=tenv
// +kubebuilder:printcolumn:name="Owner",type=string,JSONPath=`.spec.owner`
// +kubebuilder:printcolumn:name="Tier",type=string,JSONPath=`.spec.tier`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
type TenantEnvironment struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   TenantEnvironmentSpec   `json:"spec,omitempty"`
    Status TenantEnvironmentStatus `json:"status,omitempty"`
}
```

Conditions follow a convention worth keeping: positive-polarity types (`Ready`, not `Failed`), a machine-readable CamelCase `reason`, a human-readable `message`, and `observedGeneration` so a reader can tell whether `Ready: True` describes the current spec or a stale one. The printer columns turn that into the day-to-day interface:

```text
$ kubectl get tenv
NAME            OWNER           TIER       READY
billing-dev     billing-team    sandbox    True
checkout-prod   checkout-team   standard   False
```

## What the API server enforces

`make manifests` turns those markers into the CRD. An abridged view of what lands in `config/crd/bases/`:

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: tenantenvironments.platform.example.org
spec:
  group: platform.example.org
  scope: Cluster
  names:
    kind: TenantEnvironment
    plural: tenantenvironments
    shortNames: [tenv]
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          properties:
            spec:
              required: [owner]
              properties:
                owner:
                  type: string
                  minLength: 3
                  maxLength: 40
                  x-kubernetes-validations:
                    - rule: self == oldSelf
                      message: owner is immutable
                tier:
                  type: string
                  enum: [sandbox, standard, restricted]
                  default: standard
                maxPods:
                  type: integer
                  format: int32
                  minimum: 1
                  maximum: 500
                  default: 50
              x-kubernetes-validations:
                - rule: "self.tier != 'sandbox' || self.maxPods <= 20"
                  message: sandbox tier is capped at 20 pods
```

Apply a resource that breaks the cross-field rule:

```yaml
apiVersion: platform.example.org/v1alpha1
kind: TenantEnvironment
metadata:
  name: payments-sandbox
spec:
  owner: payments-team
  tier: sandbox
  maxPods: 40
```

```text
The TenantEnvironment "payments-sandbox" is invalid: spec: Invalid value: "object": sandbox tier is capped at 20 pods
```

The request dies at the API server. The controller never runs, never logs, and never needs a defensive branch for it. Rules that must consult other objects or call out to external systems still need an admission webhook, but anything expressible over the object itself is cheaper as CEL because it removes a component you'd otherwise have to run and keep available.

Two details make the API self-documenting and quick to iterate on. The Go doc comment above each field becomes a `description` in the generated schema, so `kubectl explain tenv.spec.tier` returns exactly what you wrote. And `make install` applies the CRD to your current cluster, after which `make run` starts the controller locally against it. That is the fastest way to test an API change, long before it ships in an image or touches a shared environment.

## What you're signing up for

- **Cluster-scoped privilege.** The controller's ServiceAccount holds the RBAC for everything it creates: here, Namespaces, ResourceQuotas, NetworkPolicies, and RoleBindings across the cluster. Kubebuilder generates that Role from `+kubebuilder:rbac` markers, and the generated output deserves the same review as any other privileged identity. Granting RoleBindings also triggers Kubernetes' privilege-escalation check: the controller needs either the `bind` verb on the referenced role or every permission that role contains.
- **CRD delivery is its own problem.** Helm installs files in a chart's `crds/` directory on first install but never upgrades or deletes them. A schema change shipped in a chart upgrade silently doesn't apply. CRDs need an explicit delivery path, whether a separate chart or GitOps-managed manifests applied ahead of the controller.
- **Degraded mode is a design input.** If the controller is down, what it already created keeps running, but drift goes uncorrected and any object it has to clean up on delete stays in `Terminating` until it returns. Decide what an hour of controller downtime costs before you depend on it.
- **Cloud identity, if it touches cloud APIs.** A controller that calls AWS or Azure needs its own scoped, short-lived identity: IRSA or EKS Pod Identity on AWS, Microsoft Entra Workload ID on AKS, bound to the controller's ServiceAccount. It's the same trust-boundary reasoning as registering spoke clusters in [multi-cluster ArgoCD architecture](/blogs/multi-cluster-argocd-architecture/): scoped, assumable, never a static credential.
- **A permanent maintenance line.** controller-runtime releases track Kubernetes minor versions, so each cluster upgrade eventually means a dependency bump, a rebuild, and a regression pass on code only your team understands.

## Before you run `kubebuilder init`

1. Can the desired state be written as a small declarative spec with no verbs?
2. What breaks if the controller is down for an hour?
3. Does an existing operator already own this API: ACK, Azure Service Operator, Crossplane, a policy engine?
4. Who is on call for it, and who upgrades it?
5. What would the first breaking schema change cost your consumers?

If the answers are comfortable, the API you design now is most of the work that matters. If any of them isn't, a Helm chart, a policy rule, or an existing operator probably already solves the problem.
