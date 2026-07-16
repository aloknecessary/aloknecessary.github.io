---
title: "Cloud Cost Architecture: Engineering FinOps Into the System, Not Onto It"
published: true
description: A systems-level approach to cloud cost governance — commitment tiers, cost allocation tagging, Kubernetes cost attribution, pipeline cost gates, and guardrails that block expensive changes before they deploy
tags: cloud, finops, devops, architecture
canonical_url: https://aloknecessary.github.io/blogs/cloud-cost-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=cloud-cost-architecture
cover_image: 
---

Cost is an architectural concern, not a finance concern. The decisions that determine your cloud bill are made in pull requests touching Terraform files and Kubernetes manifests — weeks before the invoice arrives. By the time finance highlights the line items, the spend has already happened.

Cloud waste consumes 30–50% of cloud budgets. The bulk is not accidental extravagance — it is the accumulated result of architectural decisions made without cost visibility at the time they were made.

---

## 1. FinOps Maturity — Where You Actually Are

Most organisations overestimate their maturity by one stage. The diagnostic: can you tell, within five minutes, which team or service generated a specific line item on last month's bill? If not, you're in Crawl regardless of how sophisticated your dashboard looks.

Most organisations see 15–20% waste reduction from showback alone — just making costs visible changes behaviour.

---

## 2. Commitment Tiers as Architecture Decisions

The commitment model constrains the operational assumptions your workload can make:

- **On-Demand** — unpredictable burst, new workloads not yet baselined
- **Savings Plans** — 20–66% discount, flexible across instance types
- **Reserved Instances** — 40–72% discount, locked to specific instance family
- **Spot/Preemptible** — up to 90% discount, two-minute eviction notice

The rule: baseline on on-demand for 2–4 weeks before committing. Savings Plans before Reserved Instances for flexibility.

---

## 3. Cost Allocation Tagging

Only 22% of companies have allocated 75%+ of their cloud costs. The gap is almost always a tagging gap.

Four mandatory tags enforced at provisioning time: `team`, `environment`, `service`, `cost-centre`. Resources without them are rejected at creation — not documented for later.

---

## 4. Showback Before Chargeback

Chargeback requires teams to trust the attribution model. That trust requires correct tags, understood allocation logic, and fair shared-cost treatment. None of that exists at the Crawl stage.

Introduce showback first, run it for a full quarter, fix attribution disputes, then move to chargeback.

---

## 5. Kubernetes Cost Attribution

When 50 services share a node pool, standard billing reports are useless. OpenCost (CNCF) and Kubecost provide per-pod and per-namespace cost breakdowns based on actual utilisation relative to node cost.

ResourceQuotas are the Kubernetes-native cost governance primitive — apply one to every tenant namespace.

---

## 6. Pipeline Cost Gates

The highest-leverage FinOps capability: a cost gate in CI/CD that shows projected cost impact before merge. Infracost analyses Terraform plans and returns a monthly dollar diff in the pull request.

If the projected increase exceeds a threshold, the check fails and the PR cannot merge without explicit override.

---

## 7. Guardrails That Block, Not Just Alert

- **Instance type restrictions** — SCPs/Azure Policy restrict GPU and large families in non-production
- **Idle resource cleanup** — unattached volumes, orphaned IPs detected and remediated by policy
- **Dev environment cost caps** — CronJobs scale non-production to zero outside business hours

---

## 8. Structural Wastes to Eliminate First

- Egress cost from co-located-on-prem services now crossing AZs
- Overprovisioned node pools with untuned autoscaler scale-down
- Cross-region data transfer not modelled before architecture decisions
- Unused reserved capacity below 70% utilisation
- Storage in standard tiers that should be in lifecycle-managed cold storage

---

## Read the Full Article

This is a summary of the fourth post in the Cloud Architecture series. The full article includes Infracost GitHub Actions workflow, Azure Policy JSON for tag enforcement, Kubernetes ResourceQuota and CronJob manifests, commitment tier decision matrix, and a comprehensive cost architecture checklist:

**👉 [Cloud Cost Architecture: Engineering FinOps Into the System, Not Onto It — Full Article](https://aloknecessary.github.io/blogs/cloud-cost-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=cloud-cost-architecture)**

The full article includes:

- FinOps Crawl/Walk/Run maturity assessment with next actions per stage
- Commitment tier decision matrix with discount ranges and risk profiles
- Azure Policy JSON for mandatory tag enforcement at provisioning
- Kubernetes ResourceQuota manifest for namespace cost governance
- Infracost GitHub Actions workflow with threshold-based cost gate
- CronJob manifest for non-production scale-to-zero outside business hours
- Structural waste audit across egress, node pools, data transfer, reservations, and storage
- Complete cloud cost architecture checklist (15 items)
