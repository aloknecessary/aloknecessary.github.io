---
title: "The Reconciliation Loop, Mechanically: Triggers, Requeues, Finalizers, and Status"
date: 2026-11-16
last_modified_at: 2026-11-16T12:48:06+05:30
author: Alok Ranjan Daftuar
description: "A mechanical walkthrough of the Kubernetes controller reconciliation loop: what Reconcile() actually receives, how to structure idempotent passes, requeue semantics, finalizer safety, and status that reflects observed generation."
excerpt: "Reconcile() doesn't receive an event, a diff, or a reason. It receives a name. What follows from that: idempotent steps, correct requeue semantics, finalizers that can't wedge a resource, and status that tells the truth."
keywords: "kubernetes operators, reconciliation loop, controller-runtime, finalizers, requeue, kubebuilder, operator pattern, idempotent controller"
twitter_card: "summary_large_image"
categories:
  - devops
tags: [kubernetes-operators, controller-runtime, operator-pattern, kubebuilder]
series: "Kubernetes Operators in Practice"
series_order: 2
---

Most first controllers are written as event handlers. A `TenantEnvironment` is created, so create a namespace. It's updated, so patch the quota. It's deleted, so clean up. The code reads naturally, passes a happy-path test, and fails in production in ways that are hard to reproduce: a missed update, a controller restart mid-change, two edits collapsed into one.

The assumption underneath is that `Reconcile` is told what happened. It isn't. This article covers what the function actually receives, how to structure one pass so it's safe to run any number of times, what wakes the loop, and the three mechanisms most likely to go wrong: requeues, finalizers, and status. The running example is the `TenantEnvironment` from [why build a custom operator](/blogs/why-build-a-custom-operator/).

## What Reconcile actually receives

```go
func (r *TenantEnvironmentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error)

// ctrl.Request is only a key. For a cluster-scoped resource, just a name.
type Request struct {
    types.NamespacedName
}
```

No event type, no old object, no diff, no reason. The function can't tell whether it was called because the resource was created, a child object changed, a timer fired, or the controller just started. That's deliberate. Controllers are **level-triggered**: on every pass they read current state, compute desired state, and converge the difference. An edge-triggered design reacts to change events, so a lost or duplicated event leaves the system permanently wrong. A level-triggered one can't be wrong for long, because the next pass starts from the truth.

```text
 API server ──watch──► shared informer ──► local cache  (what r.Get / r.List read)
                            │
                            │ Create / Update / Delete events
                            ▼
                  event handlers + predicates
        For: own key · Owns: owner's key · Watches: mapped keys
                            │ enqueue the object's NAME only
                            ▼
                  rate-limited workqueue
        identical keys dedup; one key never runs on two workers at once
                            │
                            ▼
          Reconcile(ctx, {Name: "checkout-prod"})   ← no event, no diff
```

Three consequences shape everything below:

1. **Every step must be idempotent.** The same key can arrive ten times for one real change.
2. **Events coalesce.** Ten rapid edits may produce one pass that sees only the last. Never assume you'll observe each intermediate state.
3. **Memory isn't state.** On startup the controller lists every existing object and enqueues each one, which is also how drift that accumulated during downtime gets healed. Anything the controller "knew" in a variable is gone; what matters lives in objects and `status`.

## Anatomy of one pass

```go
const finalizerName = "platform.example.org/tenant-cleanup"

func (r *TenantEnvironmentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var tenv platformv1alpha1.TenantEnvironment
    if err := r.Get(ctx, req.NamespacedName, &tenv); err != nil {
        // Gone between enqueue and now. Nothing to do, and not an error.
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    if !tenv.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, &tenv)
    }

    if controllerutil.AddFinalizer(&tenv, finalizerName) { // true if it was added
        if err := r.Update(ctx, &tenv); err != nil {
            return ctrl.Result{}, err
        }
    }

    steps := []func(context.Context, *platformv1alpha1.TenantEnvironment) error{
        r.ensureNamespace, r.ensureQuota, r.ensureNetworkPolicy, r.ensureRoleBinding,
    }
    for _, step := range steps {
        if err := step(ctx, &tenv); err != nil {
            _ = r.setReady(ctx, &tenv, metav1.ConditionFalse, "ReconcileFailed", err.Error())
            return ctrl.Result{}, err // retried with backoff
        }
    }
    return ctrl.Result{}, r.setReady(ctx, &tenv, metav1.ConditionTrue, "Reconciled",
        "namespace, quota, network policy and role binding in sync")
}
```

Each `ensure*` step computes desired state from `spec` and converges to it, never branching on "did this just get created." `CreateOrUpdate` does the read-compare-write for you:

```go
func (r *TenantEnvironmentReconciler) ensureQuota(ctx context.Context, t *platformv1alpha1.TenantEnvironment) error {
    quota := &corev1.ResourceQuota{ObjectMeta: metav1.ObjectMeta{
        Name: "tenant-quota", Namespace: namespaceFor(t),
    }}
    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, quota, func() error {
        quota.Spec.Hard = corev1.ResourceList{
            corev1.ResourcePods: *resource.NewQuantity(int64(t.Spec.MaxPods), resource.DecimalSI),
        }
        return controllerutil.SetControllerReference(t, quota, r.Scheme)
    })
    return err
}
```

`SetControllerReference` matters twice. It makes Kubernetes garbage-collect the child when the owner is deleted, and it's what lets `Owns()` route a child's change back to this parent. A cluster-scoped owner may own namespaced children, which is why a cluster-scoped `TenantEnvironment` can own the quota inside its namespace.

`CreateOrUpdate` fetches, mutates, and writes back, so it only touches what the mutate function sets. That works until another actor legitimately edits the same object. Server-side apply states ownership explicitly: the controller declares the fields it manages under a named field owner, and the API server tracks and arbitrates the rest.

```go
quota := &corev1.ResourceQuota{
    TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "ResourceQuota"}, // required for Apply
    ObjectMeta: metav1.ObjectMeta{Name: "tenant-quota", Namespace: namespaceFor(t)},
    Spec:       corev1.ResourceQuotaSpec{Hard: hardLimitsFor(t)},
}
_ = controllerutil.SetControllerReference(t, quota, r.Scheme)
return r.Patch(ctx, quota, client.Apply, client.FieldOwner("tenant-operator"), client.ForceOwnership)
```

Apply needs `TypeMeta` populated and the full desired object each time, and `ForceOwnership` resolves conflicts in the controller's favor. Either approach is sound; pick one per resource type and stay consistent.

One trap: `r.Get` and `r.List` read from the informer cache, not the API server. Right after you create an object, the cache may not have seen it. A second pass can `Get` NotFound, call `Create`, and get `AlreadyExists`. Returning that error is fine; the retry sees the cache caught up and converges. Don't build logic that assumes read-your-writes. For the rare check that must be fresh, `mgr.GetAPIReader()` bypasses the cache.

## What wakes the loop

```go
func (r *TenantEnvironmentReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        // Ignore status-only updates so our own status writes don't re-trigger us.
        // Setting deletionTimestamp bumps generation, so deletes still get through.
        For(&platformv1alpha1.TenantEnvironment{},
            builder.WithPredicates(predicate.GenerationChangedPredicate{})).
        // A change to a child enqueues its owner's key.
        Owns(&corev1.Namespace{}).
        Owns(&corev1.ResourceQuota{}).
        Owns(&networkingv1.NetworkPolicy{}).
        Owns(&rbacv1.RoleBinding{}).
        // Not an owner relationship: when the shared tier-profile ConfigMap
        // changes, every TenantEnvironment needs another pass.
        Watches(&corev1.ConfigMap{},
            handler.EnqueueRequestsFromMapFunc(r.allTenants),
            builder.WithPredicates(predicate.NewPredicateFuncs(isTierProfile))).
        WithOptions(controller.Options{MaxConcurrentReconciles: 2}).
        Complete(r)
}

func (r *TenantEnvironmentReconciler) allTenants(ctx context.Context, _ client.Object) []reconcile.Request {
    var list platformv1alpha1.TenantEnvironmentList
    if err := r.List(ctx, &list); err != nil {
        return nil
    }
    reqs := make([]reconcile.Request, 0, len(list.Items))
    for _, t := range list.Items {
        reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Name: t.Name}})
    }
    return reqs
}
```

Prefer a watch over a timer whenever the thing you're waiting on is observable in the cluster. Use `RequeueAfter` for what you can't watch:

| Signal | Use when | Cost |
| --- | --- | --- |
| `For` | The primary resource's own spec changes | Free |
| `Owns` | Children you create, so drift gets corrected | One informer per child type |
| `Watches` + map function | Related objects without an ownership link | Informer plus a mapping function you must keep cheap |
| `RequeueAfter` | External systems (cloud APIs), time-based checks, or objects too expensive to cache | Latency up to the interval; extra API calls while it runs |
| Cache resync | Safety net only; it's on the order of hours by default | Never rely on it for correctness |

The `MaxConcurrentReconciles: 2` option deserves a sentence, because the default is 1. The workqueue guarantees a single key is never processed by two workers at once, so two workers means two *different* tenants reconcile in parallel, never the same one twice. The cost is that anything shared across passes (a cache, a client wrapper, a map) must now be goroutine-safe. Raise it when queue depth shows tenants waiting behind slow ones, not by default.

## Return values decide retry behavior

| Return | Effect |
| --- | --- |
| `ctrl.Result{}, nil` | Done. Wait for the next trigger. |
| `ctrl.Result{}, err` | Requeue with per-item exponential backoff (5ms base, 1000s cap), combined with an overall rate limit. |
| `ctrl.Result{RequeueAfter: d}, nil` | Run again after `d`, with no backoff. |
| `ctrl.Result{RequeueAfter: d}, err` | The `Result` is ignored. The error wins. |

The common mistake is returning an error for an *expected* wait, such as a namespace that isn't Active yet. It spams error logs, grows the backoff for a healthy resource, and hides real failures in the noise. For waits, record the state in `status` and either watch the dependency or return `RequeueAfter`. Reserve `err` for "something is wrong and a retry might fix it." Conflict errors ("the object has been modified") are routine: return them, the retry re-reads, and they shouldn't be logged as failures.

## Finalizers: the part that wedges resources

Owner references already clean up in-cluster children. A finalizer earns its place when deletion must be *conditional* or must reach something garbage collection can't see. Here it guards against tearing down a namespace that still runs workloads:

```go
func (r *TenantEnvironmentReconciler) reconcileDelete(ctx context.Context, t *platformv1alpha1.TenantEnvironment) (ctrl.Result, error) {
    if !controllerutil.ContainsFinalizer(t, finalizerName) {
        return ctrl.Result{}, nil
    }

    var pods corev1.PodList
    if err := r.List(ctx, &pods, client.InNamespace(namespaceFor(t))); err != nil {
        return ctrl.Result{}, err
    }
    if n := len(pods.Items); n > 0 {
        msg := fmt.Sprintf("%d pods still running in %s", n, namespaceFor(t))
        _ = r.setReady(ctx, t, metav1.ConditionFalse, "DeletionBlocked", msg)
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil // an expected wait, not an error
    }

    // External cleanup goes here, before the finalizer is removed. Idempotent:
    // an already-deleted resource must count as success.

    controllerutil.RemoveFinalizer(t, finalizerName)
    return ctrl.Result{}, r.Update(ctx, t)
}
```

That `RequeueAfter` is a deliberate trade. Watching Pods would make the check event-driven, but it means caching every Pod in the cluster to serve a rare deletion. Polling every 30 seconds, only while a tenant is deleting, is cheaper.

The same slot is where cloud cleanup belongs. If each tenant also got an EKS Pod Identity association on AWS or a federated identity credential on AKS, deleting those happens here, before the finalizer comes off, and a NotFound from the cloud API must be treated as success. Otherwise a half-finished cleanup wedges the resource forever on its own retry.

A finalizer is a promise that the controller will finish the job. If the delete path keeps erroring, or the controller is uninstalled while finalizers remain, the resource sits in `Terminating` indefinitely. The last-resort escape hatch removes the promise by hand:

```bash
kubectl patch tenv checkout-prod --type=merge -p '{"metadata":{"finalizers":null}}'
```

Do that only after confirming nothing external is left behind. It skips the cleanup the finalizer existed to guarantee.

## When the pass calls a cloud API

Level-triggered has a sharp edge once a pass reaches outside the cluster. On startup, every existing resource is enqueued, so a controller managing 400 tenants makes roughly 400 cloud calls in the first minute, and every periodic resync repeats some of them. Plan for it:

- **Expect throttling and route it through the retry path.** AWS SDKs retry many throttling errors internally, but a persistent `ThrottlingException` should come back as an error so the workqueue's backoff spaces out the retries. Azure Resource Manager returns HTTP 429 with a `Retry-After` header; honor it with `RequeueAfter` rather than a blind retry.
- **Make external writes idempotent.** Use deterministic names derived from the resource (never random suffixes), and idempotency tokens where the API offers them. Azure's PUT semantics already converge; for AWS, prefer calls that take a client token or are naturally idempotent.
- **Read before you write, cheaply.** Check whether the external resource already matches before calling create or update, and record its ID or ARN in `status` so the next pass doesn't have to search.

The controller's identity for these calls (IRSA or EKS Pod Identity on AWS, Microsoft Entra Workload ID on AKS) should carry only the verbs the delete and ensure paths actually use.

## Status that tells the truth

```go
func (r *TenantEnvironmentReconciler) setReady(ctx context.Context, t *platformv1alpha1.TenantEnvironment,
    status metav1.ConditionStatus, reason, msg string) error {
    meta.SetStatusCondition(&t.Status.Conditions, metav1.Condition{
        Type: "Ready", Status: status, Reason: reason, Message: msg,
        ObservedGeneration: t.Generation,
    })
    t.Status.ObservedGeneration = t.Generation
    t.Status.Namespace = namespaceFor(t)
    return r.Status().Update(ctx, t)
}
```

Two mechanics matter. Status goes through `r.Status().Update`, the status subresource, so it never races a user's spec edit and needs no spec permissions. And stamping `ObservedGeneration` is what lets a consumer, or a GitOps health check, tell whether `Ready: True` describes the spec they just applied or the previous one. `meta.SetStatusCondition` only advances `lastTransitionTime` when the status value actually changes, so a steady-state pass doesn't churn.

## Failure modes worth recognizing

| Symptom | Cause | Fix |
| --- | --- | --- |
| Reconcile runs continuously; CPU and API calls climb | A status write re-triggers the watch on the primary resource | `GenerationChangedPredicate` on `For` |
| `AlreadyExists` right after a successful Create | Cache lag: the `Get` ran before the informer saw the write | Treat as transient; use `GetAPIReader()` only where freshness is required |
| Resource stuck in `Terminating` | Delete path errors, or the controller is gone with finalizers still set | Fix or redeploy the controller; patch finalizers only after manual cleanup |
| Backoff grows for a healthy resource | An error returned for an expected wait | Record state in `status`, then watch or `RequeueAfter` |
| Controller works, then misses changes after a long idle | Logic depended on in-memory state or on seeing every event | Derive everything from objects on each pass |

Most of these show up in metrics before they show up in tickets. controller-runtime exports `controller_runtime_reconcile_total` and `controller_runtime_reconcile_errors_total` per controller, `controller_runtime_reconcile_time_seconds` for pass duration, and `workqueue_depth` for backlog. A reconcile rate that stays high while nothing is changing points to a self-triggering loop; a rising error ratio with flat traffic points to a stuck dependency; a growing queue depth is the signal to raise concurrency or shorten slow passes.

The loop is small: read, compare, converge, report. Nearly every production bug in a controller is a violation of one of its three guarantees. It can run any number of times. It can be handed any trigger. It can be killed at any line.
