---
title: "Cloud Security Architecture: From Shared Responsibility to Zero Trust"
published: false
description: Shared responsibility boundaries, IAM least-privilege at scale, secrets management without credential sprawl, network segmentation, and zero-trust applied to Kubernetes workloads
tags: cloud, security, kubernetes, devops
canonical_url: https://aloknecessary.github.io/blogs/cloud-security-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=cloud-security-architecture
cover_image: 
---

Cloud security incidents that make news are rarely the result of a novel attack technique. They are the result of misconfiguration, over-permissioned identities, and static credentials left in places where attackers have learned to look automatically.

This post covers the architectural decisions that prevent those incidents — made early, before the first breach, rather than in response to one.

---

## 1. The Shared Responsibility Model — What You Actually Own

The rows that never move to the provider regardless of service model: identity and access, application configuration, secrets management, and data encryption. Treating "we use managed Kubernetes" as implying "security is largely handled" is the category error that makes managed services into false comfort.

Three items teams most commonly miscategorise as provider responsibility:

- **Encryption at rest** — provider-managed keys mean the provider could theoretically decrypt your data. You own the key management decision.
- **Network exposure** — a LoadBalancer service type provisions a public IP by default. Nothing prevents a developer from exposing an internal service.
- **IAM overprivilege** — the provider supplies IAM. What role gets attached to which workload is entirely yours.

---

## 2. IAM Least-Privilege at Scale

IAM posture degrades monotonically — it gets worse over time, never better, unless you actively intervene. Three structural controls:

- **ABAC over RBAC** — evaluate permissions dynamically based on attributes rather than maintaining named roles that accumulate permissions
- **Permission boundaries** — set the maximum permissions a role can ever have, regardless of what policies are attached
- **SCPs** — organisation-wide guardrails that cannot be overridden at the account level

---

## 3. Secrets Management — No Static Credentials

70% of leaked secrets remain active 2 years after exposure. The goal: eliminate long-lived static credentials entirely.

- **IRSA / Workload Identity** — pods assume cloud IAM roles without possessing any credential file, via OIDC federation
- **CSI driver mounts** — secrets mounted as files, refreshed on rotation without pod restart
- **The rule:** no secret should ever appear in a Docker image, Kubernetes manifest, GitHub repository, CI/CD log, or environment variable

---

## 4. Network Segmentation

Network controls reduce blast radius when an identity is compromised. A well-segmented VPC separates traffic by function and trust level:

- Public subnets (ALB/NLB only) → Private app subnets → Private data subnets
- VPC endpoints for all cloud services (S3, Secrets Manager, ECR, STS)
- No application or data tier resource has a public IP

---

## 5. Zero Trust for Kubernetes

Kubernetes ships open-by-default. Three gaps to close:

- **Default-deny NetworkPolicy** in every namespace, with explicit allow policies for required communication
- **Pod Security Admission** — `baseline` enforced on application namespaces, `restricted` warned
- **One ServiceAccount per workload** — `automountServiceAccountToken: false` at SA level, opt-in per pod

---

## 6. CI/CD Pipeline Security

- **OIDC authentication** — no long-lived credentials stored in GitHub secrets
- **Image signing at build, verification at admission** — unsigned images rejected
- **Vulnerability scanning blocking** — high/critical CVEs fail the build
- **Secret scanning on push** — any secret in source control treated as compromised

---

## 7. Detection — What to Alert On

High-signal events: root account login, IAM policy changes in production, security group rules allowing `0.0.0.0/0`, CloudTrail disabled, `kubectl exec` into production pods, secrets accessed from unexpected roles.

Enable GuardDuty / Defender for Cloud before you need them — post-incident enablement loses the historical baseline.

---

## Read the Full Article

This is a summary of the fifth and final post in the Cloud Architecture series. The full article includes detailed IAM policy examples, IRSA/Workload Identity configuration, NetworkPolicy manifests, Pod Security Admission labels, GitHub Actions OIDC setup, and a comprehensive production-readiness checklist:

**👉 [Cloud Security Architecture: From Shared Responsibility to Zero Trust — Full Article](https://aloknecessary.github.io/blogs/cloud-security-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=cloud-security-architecture)**

The full article includes:

- Shared responsibility matrix across IaaS/CaaS/PaaS
- Permission boundary and SCP JSON examples
- IRSA and Workload Identity ServiceAccount configuration
- Secrets Manager CSI driver SecretProviderClass manifest
- Default-deny NetworkPolicy with explicit allow rules
- Pod Security Admission namespace labels
- GitHub Actions OIDC workflow with scoped trust policy
- Complete cloud security architecture checklist (25+ items)
