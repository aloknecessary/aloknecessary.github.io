---
title: "The Reconciliation Loop, Mechanically: Triggers, Requeues, Finalizers, and Status"
published: false
description: A mechanical walkthrough of what Reconcile() actually receives, how to structure idempotent passes, requeue semantics, finalizer safety, and status that reflects observed generation.
tags: kubernetes, platform-engineering, devops, cloud-native
canonical_url: https://aloknecessary.in/blogs/reconciliation-loop-mechanics/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=reconciliation-loop-mechanics
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a Kubernetes reconciliation loop — a circular flow diagram showing a workqueue feeding into a reconcile function, which reads from a cache, computes desired state, and writes back to an API server. Glowing arrows indicate the level-triggered cycle. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

Most first controllers are written as event handlers. A resource is created, so create a child. It's updated, so patch something. It's deleted, so clean up. The code reads naturally, passes a happy-path test, and fails in production in ways that are hard to reproduce: a missed update, a controller restart mid-change, two edits collapsed into one.

The assumption underneath is that `Reconcile` is told what happened. It isn't. This article covers what the function actually receives, how to structure one pass so it's safe to run any number of times, what wakes the loop, and the three mechanisms most likely to go wrong: requeues, finalizers, and status.

---

## What Reconcile Actually Receives

```go
func (r *TenantEnvironmentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error)

// ctrl.Request is only a key — no event type, no old object, no diff.
type Request struct {
    types.NamespacedName
}
```

Controllers are **level-triggered**: on every pass they read current state, compute desired state, and converge the difference. An edge-triggered design reacts to change events, so a lost or duplicated event leaves the system permanently wrong. A level-triggered one can't be wrong for long, because the next pass starts from the truth.

Three consequences shape everything:

1. **Every step must be idempotent.** The same key can arrive ten times for one real change.
2. **Events coalesce.** Ten rapid edits may produce one pass that sees only the last.
3. **Memory isn't state.** On startup the controller lists every existing object and enqueues each one. Anything the controller "knew" in a variable is gone; what matters lives in objects and `status`.

## Anatomy of One Pass

The structure of a correct reconcile function:

```go
func (r *TenantEnvironmentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var tenv platformv1alpha1.TenantEnvironment
    if err := r.Get(ctx, req.NamespacedName, &tenv); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    if !tenv.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, &tenv)
    }

    if controllerutil.AddFinalizer(&tenv, finalizerName) {
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
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, r.setReady(ctx, &tenv, metav1.ConditionTrue, "Reconciled", "in sync")
}
```

Each `ensure*` step uses `CreateOrUpdate` or server-side apply — never branching on "did this just get created." `SetControllerReference` makes Kubernetes garbage-collect the child when the owner is deleted, and routes child changes back to the parent via `Owns()`.

One trap: `r.Get` and `r.List` read from the informer cache. Right after you create an object, the cache may not have seen it. A second pass can `Get` NotFound, call `Create`, and get `AlreadyExists`. Return that error — the retry sees the cache caught up. Don't build logic that assumes read-your-writes.

## What Wakes the Loop

```go
ctrl.NewControllerManagedBy(mgr).
    For(&platformv1alpha1.TenantEnvironment{},
        builder.WithPredicates(predicate.GenerationChangedPredicate{})).
    Owns(&corev1.Namespace{}).
    Owns(&corev1.ResourceQuota{}).
    Owns(&networkingv1.NetworkPolicy{}).
    Owns(&rbacv1.RoleBinding{}).
    Watches(&corev1.ConfigMap{},
        handler.EnqueueRequestsFromMapFunc(r.allTenants),
        builder.WithPredicates(predicate.NewPredicateFuncs(isTierProfile))).
    WithOptions(controller.Options{MaxConcurrentReconciles: 2}).
    Complete(r)
```

`GenerationChangedPredicate` on `For` is critical — it prevents your own status writes from re-triggering the watch on the primary resource, which would cause a continuous reconcile loop.

Prefer a watch over a timer whenever the thing you're waiting on is observable in the cluster. Use `RequeueAfter` for what you can't watch — external systems, time-based checks.

## Return Values and Retry Semantics

| Return | Effect |
| --- | --- |
| `ctrl.Result{}, nil` | Done. Wait for the next trigger. |
| `ctrl.Result{}, err` | Requeue with exponential backoff (5ms base, 1000s cap). |
| `ctrl.Result{RequeueAfter: d}, nil` | Run again after `d`, no backoff. |
| `ctrl.Result{RequeueAfter: d}, err` | The `Result` is ignored. The error wins. |

The common mistake is returning an error for an *expected* wait — a namespace not yet Active, a cloud resource still provisioning. It spams error logs, grows the backoff for a healthy resource, and hides real failures in the noise. Reserve `err` for "something is wrong and a retry might fix it."

## Finalizers: The Part That Wedges Resources

Owner references clean up in-cluster children automatically. A finalizer earns its place when deletion must be conditional or must reach something garbage collection can't see:

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
        _ = r.setReady(ctx, t, metav1.ConditionFalse, "DeletionBlocked",
            fmt.Sprintf("%d pods still running", n))
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil // expected wait, not an error
    }

    controllerutil.RemoveFinalizer(t, finalizerName)
    return ctrl.Result{}, r.Update(ctx, t)
}
```

A finalizer is a promise that the controller will finish the job. If the delete path keeps erroring, or the controller is uninstalled while finalizers remain, the resource sits in `Terminating` indefinitely. The escape hatch — `kubectl patch tenv checkout-prod --type=merge -p '{"metadata":{"finalizers":null}}'` — skips the cleanup the finalizer existed to guarantee. Use it only after confirming nothing external is left behind.

## Status That Tells the Truth

```go
meta.SetStatusCondition(&t.Status.Conditions, metav1.Condition{
    Type:               "Ready",
    Status:             status,
    Reason:             reason,
    Message:            msg,
    ObservedGeneration: t.Generation,
})
t.Status.ObservedGeneration = t.Generation
return r.Status().Update(ctx, t)
```

Status goes through `r.Status().Update` — the status subresource — so it never races a user's spec edit. Stamping `ObservedGeneration` is what lets a consumer or GitOps health check tell whether `Ready: True` describes the spec they just applied or the previous one.

---

## Read the Full Article

The full post covers:

- The complete informer/workqueue/predicate flow diagram showing how events become reconcile calls
- `CreateOrUpdate` vs server-side apply — when each is appropriate and the `ForceOwnership` detail
- The full `SetupWithManager` wiring with `Watches` + map function for non-owned dependencies
- Cloud API patterns: throttling, idempotency tokens, reading before writing, recording ARNs in status
- A failure modes table: self-triggering loops, `AlreadyExists` from cache lag, stuck `Terminating`, backoff growth, in-memory state loss
- Metrics to watch: `controller_runtime_reconcile_total`, `reconcile_errors_total`, `workqueue_depth`

**👉 [The Reconciliation Loop, Mechanically — Full Article](https://aloknecessary.in/blogs/reconciliation-loop-mechanics/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=reconciliation-loop-mechanics)**
