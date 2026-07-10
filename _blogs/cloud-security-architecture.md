---
title: "Cloud Security Architecture: From Shared Responsibility to Zero Trust"
date: 2026-07-17
last_modified_at: 2026-07-17
author: Alok Ranjan Daftuar
description: "The security posture that underpins a production cloud system — shared responsibility boundaries, IAM least-privilege at scale, secrets management without credential sprawl, network segmentation that doesn't recreate on-premises perimeters, and zero-trust applied to Kubernetes workloads."
excerpt: "Cloud security is not a layer you add after the architecture is designed — it is a set of architectural decisions made at the same time as resilience, cost, and modernisation. This post covers shared responsibility boundaries, IAM least-privilege at scale, secrets management, network segmentation, and zero-trust for Kubernetes workloads."
keywords: "cloud security, zero trust, IAM, least privilege, secrets management, IRSA, workload identity, network segmentation, VPC, Kubernetes security, pod security, OIDC, CI/CD security"
twitter_card: summary_large_image
categories:
  - cloud
  - architecture
  - security
tags: [cloud-security, zero-trust, iam, kubernetes, secrets-management, azure, aws, devops, architecture, production, github-actions]
series: "Cloud Architecture"
series_order: 5
---

## Introduction

The previous posts in this series have covered what breaks after migration, how to design for region-level failures, how to modernise lifted workloads, and how to engineer cost control into infrastructure. There is a dimension all four posts have treated as context rather than subject: security. Not because it's less important — IBM's Cost of a Data Breach Report puts the global average breach cost at USD 4.44 million — but because cloud security is its own architectural discipline, with its own failure modes and its own body of production-tested patterns.

> 89% of organisations experienced a Kubernetes security incident in the last year, often due to lateral movement after an initial pod compromise.

The pattern across almost every incident report is not sophisticated zero-day exploits. It is misconfiguration, over-permissioned identities, and static credentials left in places where attackers have learned to look automatically. The breach is not clever. The defence is not either. It is consistent enforcement of a small set of architectural decisions made early, before the first incident, rather than in response to one.

This post covers those decisions: where the shared responsibility model draws the line you cannot delegate, how to implement IAM least-privilege at a scale where manual review breaks down, how to eliminate static credentials from your production posture, how to segment east-west traffic without recreating on-premises perimeter thinking, and how zero-trust principles apply specifically to Kubernetes workloads in the AWS and Azure environments this series has focused on throughout.

> **Article context:** This is the fifth and final post in the Cloud Architecture series. The [Why Lift-and-Shift Fails Quietly](/blogs/lift-and-shift-fails-quietly/) post flagged secrets management in flat config files as an explicit pre-migration risk. The [Modernising the Lifted Workload](/blogs/modernising-the-lifted-workload/) post covered stateless redesign and externalising session state — the same discipline applies to credentials: they should never live in the application process. The [Cloud Cost Architecture](/blogs/cloud-cost-architecture/) post covered policy-as-code for cost guardrails; this post applies the same enforcement model to security posture.

### Table of Contents

- [Introduction](#introduction)
- [1. The Shared Responsibility Model — What You Actually Own](#1-the-shared-responsibility-model--what-you-actually-own)
- [2. IAM Least-Privilege at Scale — ABAC over RBAC, Permission Boundaries, and SCPs](#2-iam-least-privilege-at-scale--abac-over-rbac-permission-boundaries-and-scps)
- [3. Secrets Management — No Static Credentials in Production](#3-secrets-management--no-static-credentials-in-production)
- [4. Network Segmentation — VPC Design and Private Endpoints](#4-network-segmentation--vpc-design-and-private-endpoints)
- [5. Zero Trust for Kubernetes — Workload Identity, Network Policies, and Pod Security](#5-zero-trust-for-kubernetes--workload-identity-network-policies-and-pod-security)
- [6. Security in the CI/CD Pipeline](#6-security-in-the-cicd-pipeline)
- [7. Detection and Response — What to Log and What to Alert On](#7-detection-and-response--what-to-log-and-what-to-alert-on)
- [The Cloud Security Architecture Checklist](#the-cloud-security-architecture-checklist)
- [Closing: Security Is Not a Layer You Add — It Is a Property You Design For](#closing-security-is-not-a-layer-you-add--it-is-a-property-you-design-for)

---

## 1. The Shared Responsibility Model — What You Actually Own

Every cloud provider publishes a shared responsibility model. In practice, most engineering teams know the headline — "the provider secures the infrastructure, you secure what you put on it" — and treat the details as someone else's concern. That gap is where the majority of cloud security incidents originate.

The boundary is more specific than the headline implies, and it shifts depending on the service model:

| Layer | IaaS (EC2/Azure VM) | CaaS (EKS/AKS) | PaaS (Lambda/Azure Functions) |
| --- | --- | --- | --- |
| Physical infrastructure | Provider | Provider | Provider |
| Hypervisor / host OS | Provider | Provider | Provider |
| Container runtime / OS | **You** | Shared | Provider |
| Cluster control plane | **You** | Provider | Provider |
| Network controls | **You** | **You** | **You** |
| Identity and access | **You** | **You** | **You** |
| Application configuration | **You** | **You** | **You** |
| Data encryption | **You** | **You** | **You** |
| Secrets management | **You** | **You** | **You** |

The rows that never move to the provider regardless of service model: identity and access, application configuration, secrets management, and data encryption. These are architectural decisions you make; the provider supplies the services that support implementing them correctly, but the implementation, the governance, and the correctness are yours. Treating "we use managed Kubernetes" as implying "security is largely handled" is the category error that makes managed services into false comfort.

Three specific ownership items that teams most commonly miscategorise as provider responsibility:

**Encryption at rest.** Managed services (RDS, Azure SQL, Cosmos DB, S3) encrypt data at rest by default in 2026. What is not provider responsibility: key management. Provider-managed keys mean the provider could theoretically decrypt your data. For regulated data, that is unacceptable — you own the key management decision, which means choosing between customer-managed keys (CMK) in KMS or Azure Key Vault and accepting the operational overhead that comes with it.

**Network exposure.** A managed Kubernetes service does not prevent you from exposing a service to the public internet by accident. A LoadBalancer service type in Kubernetes provisions a cloud load balancer with a public IP by default. Creating an Internet-facing Application Load Balancer in AWS requires choosing the `internet-facing` scheme — but nothing prevents a developer from choosing it for a service that should only be internal.

**IAM overprivilege.** The provider supplies IAM. What role gets attached to which workload, with which permissions, is entirely yours. A Lambda function that needs to read one S3 bucket does not need `s3:*` on `*`. The provider does not prevent you from granting it.

---

## 2. IAM Least-Privilege at Scale — ABAC over RBAC, Permission Boundaries, and SCPs

IAM least-privilege is not a single decision made at system creation. It is an ongoing discipline, because IAM policies accumulate over time: permissions added to unblock a deployment, service accounts created for a project that has since ended, roles with wildcard actions granted during an incident. Without structural mechanisms to contain this drift, IAM posture degrades monotonically — it gets worse over time, never better, unless you actively intervene.

Three structural controls that prevent drift rather than just detecting it after the fact.

### Attribute-Based Access Control Over Role-Based

Traditional RBAC assigns permissions to named roles — `developer`, `admin`, `read-only` — and those roles accumulate permissions as requirements change. ABAC grants permissions based on attributes of the requester, the resource, and the request context, evaluated at access time. An ABAC policy that says "a service tagged `environment: production` may only be accessed by callers tagged `team: platform` and only between 08:00 and 20:00 UTC" requires no role management and no permission list maintenance — it evaluates dynamically.

AWS IAM's condition keys and Azure ABAC on Role Assignments both support this model. The shift from RBAC to ABAC matters most at scale — for organisations running dozens of teams with hundreds of services, maintaining named roles for every permission combination becomes unmanageable within eighteen months.

### Permission Boundaries in AWS

An IAM permission boundary is a managed policy attached to a role that sets the maximum permissions that role can ever have, regardless of what permission policies are also attached. It is a ceiling, not a grant.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::my-service-bucket/*"
    },
    {
      "Effect": "Deny",
      "Action": [
        "iam:*",
        "organizations:*",
        "account:*"
      ],
      "Resource": "*"
    }
  ]
}
```

Apply permission boundaries to all developer-created roles. This means a developer can grant a service whatever permissions they believe it needs — but cannot grant it permissions that exceed the boundary, which prevents accidental or deliberate privilege escalation. The platform team owns the boundary definition; application teams own role creation within it.

### Service Control Policies for Organisation-Wide Guardrails

AWS Service Control Policies (SCPs) and Azure Management Group policies enforce organisation-wide maximum permissions — similar to permission boundaries but applied to entire accounts or subscriptions rather than individual roles. They are the right place for security decisions that should never be overridden at the account level regardless of how the account's IAM is configured.

Practical SCPs worth applying to all non-production accounts by default:

- Deny creation of IAM users with console access (enforce federation via SSO)
- Deny regions outside your operational geography (reduces attack surface, simplifies compliance)
- Deny disabling of CloudTrail, GuardDuty, or Security Hub
- Deny large instance types (GPU, high-memory) to prevent expensive accidental provisioning — covered in the [Cloud Cost Architecture](/blogs/cloud-cost-architecture/) post, applied here for a different reason: an attacker who compromises an account and provisions GPU instances for crypto-mining is a cost incident and a security incident simultaneously

---

## 3. Secrets Management — No Static Credentials in Production

> GitHub's State of Secrets Sprawl 2025 found that 70% of leaked secrets remain active 2 years after exposure.

That persistence is the structural problem: static credentials, once leaked, remain exploitable until someone actively rotates them. In practice, that someone is usually notified by a breach notification, not by their own monitoring.

The architectural goal is to eliminate long-lived static credentials from production entirely, replacing them with short-lived, automatically rotated credentials issued on the basis of verified identity. The two mechanisms that make this practical in AWS/Azure + Kubernetes environments.

### IRSA and Workload Identity — Cloud Credentials Without Files

IAM Roles for Service Accounts (IRSA, AWS) and Workload Identity Federation (Azure) let a Kubernetes pod assume a cloud IAM role without possessing any credential file, access key, or secret. The pod's Kubernetes service account token is exchanged for a short-lived cloud credential at runtime, via OIDC federation between the Kubernetes cluster and the cloud provider's IAM.

```yaml
# Kubernetes side: annotate the ServiceAccount with the IAM role to assume
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-processor
  namespace: production
  annotations:
    # AWS IRSA
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/order-processor-role
    # Azure Workload Identity (use one, not both)
    azure.workload.identity/client-id: "your-managed-identity-client-id"
```

The result: the pod never holds an AWS access key or Azure client secret. The credential it uses is issued for the duration of a token window (typically one hour), scoped to the specific IAM role, and automatically rotated by the SDK. If the pod's image is extracted from a registry, or a memory dump is taken, there is no static credential to recover.

### Secrets Rotation Without Downtime

For secrets that cannot use federated identity — third-party API keys, database passwords, certificates — the requirement is rotation without application downtime. The anti-pattern: a secret that requires an application restart to pick up a new value, which means rotation gets deferred until a maintenance window, which means rotation almost never happens.

The correct pattern: applications read secrets from the secrets manager at startup and on a background refresh interval, not once at build or deploy time, and not via an environment variable that is baked in at container creation.

```yaml
# AWS Secrets Manager + Kubernetes: mount secrets as files, not env vars
# The CSI driver refreshes the file when the secret rotates — no restart required
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: order-service-secrets
  namespace: production
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "prod/order-service/db-password"
        objectType: "secretsmanager"
        objectAlias: "db-password"
      - objectName: "prod/order-service/payment-api-key"
        objectType: "secretsmanager"
        objectAlias: "payment-api-key"
  secretObjects:
  - secretName: order-service-secrets
    type: Opaque
    data:
    - objectName: db-password
      key: DB_PASSWORD
    - objectName: payment-api-key
      key: PAYMENT_API_KEY
```

The two things this pattern explicitly prevents: secrets stored in Kubernetes `Secret` objects backed only by etcd (which is base64-encoded, not encrypted, by default), and secrets injected as environment variables at pod creation time (which bake the secret into the pod spec, visible in `kubectl describe pod`, and not updated when the secret rotates).

> **The rule that prevents the majority of secrets incidents:** no secret should ever appear in a Docker image, a Kubernetes manifest, a GitHub repository, a CI/CD log, or an environment variable. If it does, treat it as compromised and rotate it immediately — it has been accessible to anyone with access to that artefact, now and historically.

---

## 4. Network Segmentation — VPC Design and Private Endpoints

Zero trust advocates for identity-based access over network-based access, and that framing is correct for workload-to-workload communication. But network segmentation remains a valid and necessary defence-in-depth layer — not because network-level trust is meaningful, but because network controls reduce blast radius when an identity is compromised. An attacker who compromises a pod with misconfigured RBAC and no network policy can reach every other pod in the cluster. With default-deny network policies, they can reach only what the compromised pod's policy allows.

### VPC Design Principles

A well-segmented VPC separates traffic by function and trust level, not by convenience:

```text
Public Subnets          (internet-facing only: ALB/NLB, NAT Gateway, Bastion)
    │
    ▼
Private App Subnets     (application tier: EKS nodes, Lambda, compute)
    │
    ▼
Private Data Subnets    (data tier: RDS, ElastiCache, OpenSearch — no direct internet path)
    │
    ▼
VPC Endpoints           (AWS services accessed without leaving the VPC: S3, Secrets Manager,
                         SSM, ECR — eliminates NAT Gateway cost and internet exposure)
```

The operational consequence of this layout: no application tier resource has a public IP. Load balancers front all external traffic, and the application layer is only reachable from the load balancer's security group. The data tier is only reachable from the application tier's security group. Nothing in the data tier can initiate a connection outbound to the internet.

### Private Endpoints for Cloud Services

> This section covers when to use private endpoints and the baseline services worth enabling them for. For a deeper analysis of the cost, complexity, and operational trade-offs of applying them universally, see [Private Endpoints Everywhere? The Hidden Cost of 'Secure by Default' Cloud Architectures](/blogs/hidden-cost-of-private-endpoints-everywhere/).

Every call an application makes to an AWS or Azure managed service that traverses the public internet is both an egress cost (covered in the [Cloud Cost Architecture](/blogs/cloud-cost-architecture/) post) and an unnecessary exposure vector. VPC Endpoints (AWS) and Private Endpoints (Azure) route traffic to managed services over the provider's private network, removing the public internet from the path entirely.

Services worth enabling private endpoints for as a baseline: S3 (Gateway endpoint, free), Secrets Manager, SSM Parameter Store, ECR (required for EKS nodes to pull images without NAT Gateway), STS, CloudWatch Logs. In Azure: Key Vault, Azure Container Registry, Azure Storage, Azure SQL.

The combined effect: an EKS node that needs to pull a container image, retrieve a secret, write a log, and write to S3 can do all of it without a NAT Gateway, without a public IP, and without any of that traffic leaving the AWS network. That is both cheaper and more secure than the default configuration.

---

## 5. Zero Trust for Kubernetes — Workload Identity, Network Policies, and Pod Security

Kubernetes ships with an open-by-default network model: every pod can reach every other pod in the cluster without restriction. That default is safe for a single-team development cluster. It is not safe for a multi-team production cluster where the blast radius of one compromised pod extends to everything running in the cluster.

Zero trust for Kubernetes requires closing three gaps independently.

### Default-Deny Network Policies

A Kubernetes NetworkPolicy is only enforced if your CNI plugin supports it (Calico, Cilium, and Antrea do; Flannel alone does not). The starting policy is a default deny-all in every namespace, with explicit allow policies added for the communication that is actually required.

```yaml
# Default deny-all: apply to every namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}        # matches all pods in the namespace
  policyTypes:
  - Ingress
  - Egress
---
# Explicit allow: order-service may receive traffic from api-gateway only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-from-api-gateway
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: order-service
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: api-gateway
    ports:
    - protocol: TCP
      port: 8080
```

The Monitor-then-Enforce lifecycle that prevents breaking production: start with network policies in audit mode using Cilium's policy audit mode or OPA Gatekeeper in `warn` effect, observe what traffic would be blocked, add necessary allow policies for legitimate communication paths, then switch to enforce. Applying default-deny in enforce mode without auditing first reliably breaks production traffic on the first day.

### Pod Security Admission

Pod Security Admission (PSA) replaced Pod Security Policies in Kubernetes 1.25 and is the current mechanism for restricting what pod specifications can be admitted to the cluster. Three enforcement levels:

- **Privileged** — no restrictions. Appropriate only for system namespaces (kube-system, monitoring).
- **Baseline** — prevents known privilege escalations. No hostNetwork, no hostPID, no privilege escalation flag. Appropriate for most application workloads.
- **Restricted** — requires non-root user, drops all Linux capabilities, requires seccomp profile. Appropriate for high-trust workloads; may require application changes to run under.

```yaml
# Label namespaces to enforce the appropriate security level
# Apply to all application namespaces at minimum 'baseline'
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted       # warn when pods would fail restricted
    pod-security.kubernetes.io/warn-version: latest
```

The `warn` label on `restricted` without enforcing it is the right starting point for existing workloads — it surfaces which pods would fail the stricter level without breaking them, allowing teams to plan the changes required to meet `restricted` before enforcement is turned on.

### Workload Identity with Dedicated Service Accounts

> The best practice in 2026 is to map exactly one ServiceAccount to one Deployment or StatefulSet.

Sharing service accounts across workloads means that compromising one workload inherits every permission granted to that shared identity — including permissions needed only by unrelated workloads sharing the account.

```yaml
# One ServiceAccount per workload — not the default account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-processor-sa
  namespace: production
automountServiceAccountToken: false   # explicit opt-in per pod; not inherited
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
spec:
  template:
    spec:
      serviceAccountName: order-processor-sa
      automountServiceAccountToken: true    # opt in explicitly where the token is needed
```

`automountServiceAccountToken: false` at the ServiceAccount level and opt-in at the pod level means only pods that explicitly need to call the Kubernetes API receive a service account token. The majority of application pods have no business calling the API server — and those that receive tokens without needing them are tokens that can be stolen and used to enumerate the cluster.

---

## 6. Security in the CI/CD Pipeline

The CI/CD pipeline is a high-value target: it has access to cloud credentials for deployment, secrets for configuration injection, container registries for image push, and the ability to execute arbitrary code as part of a build. A compromised pipeline can deploy backdoored images, exfiltrate secrets from the build environment, or modify infrastructure without leaving visible artefacts in application code.

The four controls worth implementing in GitHub Actions specifically, given your pipeline tooling:

**OIDC-based cloud authentication.** Replace long-lived AWS access keys or Azure service principal secrets stored in GitHub secrets with short-lived credentials issued via OIDC. GitHub Actions has a built-in OIDC token endpoint; AWS and Azure both support trusting it.

```yaml
# GitHub Actions: authenticate to AWS via OIDC — no stored credentials
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write    # required for OIDC token request
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-deploy-role
          role-session-name: GitHubActions-${% raw %}{{ github.run_id }}{% endraw %}
          aws-region: eu-west-1
          # No access key or secret — OIDC token exchanged for short-lived credentials
```

The IAM trust policy on `github-deploy-role` should restrict the `sub` claim to the specific repository and branch — `repo:your-org/your-repo:ref:refs/heads/main` — so the role cannot be assumed from any other repository or branch, even within the same GitHub organisation.

**Image signing and verification.** Container images should be signed at build time and verified at admission time. Sigstore's Cosign (now a CNCF project) provides the standard tooling; AWS Signer and Azure Container Registry both offer managed signing. Policy enforcement via Kyverno or OPA Gatekeeper can reject unsigned or unverified images at the Kubernetes admission webhook before they run.

**Dependency and vulnerability scanning.** Integrate Trivy or Grype into the build pipeline as a blocking step — builds that produce images with high or critical CVEs fail rather than pushing to the registry. The same scan should run against base images on a schedule independent of builds, because a vulnerability discovered after a build produces a non-compliant image that is currently running in production.

**Secret scanning on push.** GitHub Advanced Security's secret scanning and pre-commit hooks (using tools like `detect-secrets` or `gitleaks`) catch credentials committed to source control before they are pushed — which is when they become potentially public. The policy is simple and non-negotiable: any secret found in source control is treated as compromised regardless of repository visibility, because the git history persists after deletion.

---

## 7. Detection and Response — What to Log and What to Alert On

Security controls that are not monitored are security theatre. The question is not whether to log — everything of security relevance should be logged — but what to alert on, because alert fatigue from undifferentiated logging is the monitoring equivalent of an observability void.

The high-signal events worth alerting on immediately, across AWS and Azure:

| Event | Source | Why it matters |
| --- | --- | --- |
| Root account / Global Admin login | CloudTrail / Entra ID logs | Should never happen; any use is an incident |
| IAM policy change in production | CloudTrail | Privilege escalation attempt or misconfiguration |
| Security group rule added allowing `0.0.0.0/0` inbound | CloudTrail / Azure Monitor | Unintended internet exposure |
| CloudTrail logging disabled | CloudTrail | Attacker covering tracks |
| Kubernetes API server called from outside the cluster | API server audit logs | Credential theft or misconfiguration |
| Pod exec into a production container | API server audit logs | Direct container access, often reconnaissance |
| Secrets Manager secret accessed from an unexpected role/region | CloudTrail | Credential misuse or lateral movement |
| Image pulled from an unregistered registry in Kubernetes | Falco / runtime monitoring | Potential malware or misconfigured workload |

The Kubernetes API server audit log deserves particular attention because it is off by default in self-managed clusters and often undertriaged in managed ones. `kubectl exec` into a production pod, `kubectl port-forward` to a production database, and direct API calls from outside the cluster are all signals that warrant immediate investigation — not because they are always attacks, but because they are the exact access patterns an attacker with stolen credentials would use.

AWS GuardDuty and Microsoft Defender for Cloud automate the majority of this detection with minimal configuration, and both have specific Kubernetes runtime protection modules (GuardDuty EKS Runtime Monitoring, Defender for Containers). Enable them before you need them — post-incident enablement loses the historical baseline that makes anomaly detection meaningful.

---

## The Cloud Security Architecture Checklist

Before declaring a cloud architecture production-ready from a security perspective:

**Shared Responsibility and IAM**

- [ ] **CMK key management decision made** — provider-managed vs customer-managed keys decided for regulated data; not left at default for compliance-in-scope workloads
- [ ] **No IAM users with long-lived console access** — all human access via SSO federation; IAM users restricted to programmatic access with rotation policy
- [ ] **Permission boundaries applied to all developer-created roles** — platform team owns boundary definition; application teams create roles within it
- [ ] **SCPs enforcing organisation-wide guardrails** — region restriction, CloudTrail/GuardDuty cannot be disabled, large instance types require approval
- [ ] **ABAC evaluated as the long-term IAM model** — RBAC audited for role proliferation; ABAC transition planned if team or service count is growing

**Secrets Management**

- [ ] **No static credentials in application code, environment variables, Docker images, or CI/CD logs** — zero tolerance; any finding treated as compromised immediately
- [ ] **IRSA (AWS) or Workload Identity (Azure) configured** for all pods that access cloud services — no credential files mounted in pods
- [ ] **Secrets mounted as files via CSI driver** — not environment variables; refreshed on rotation without pod restart
- [ ] **Secret rotation schedule defined** — automated where possible (RDS, ElastiCache support native rotation); documented schedule for third-party credentials

**Network**

- [ ] **VPC design implements public/private app/private data subnet separation** — no application or data tier resources have public IPs
- [ ] **VPC endpoints / Private endpoints enabled** for all cloud services accessed by application tier
- [ ] **Security group rules audited** — no `0.0.0.0/0` ingress except on load balancers for ports 80/443; alert configured on new rules opening broad ingress

**Kubernetes**

- [ ] **Default-deny NetworkPolicy applied to all namespaces** — in Monitor mode before Enforce; CNI enforcement verified
- [ ] **Pod Security Admission labels applied** — `baseline` enforced on application namespaces; `restricted` warned
- [ ] **One ServiceAccount per workload** — default service account not used; `automountServiceAccountToken: false` at SA level
- [ ] **`restricted` PSA goal for high-trust workloads** — non-root, drop all caps, seccomp profile planned or in place

**CI/CD**

- [ ] **GitHub Actions uses OIDC** — no long-lived AWS access keys or Azure client secrets in GitHub secrets
- [ ] **OIDC role trust policy scoped to specific repo and branch** — not `repo:org/*` or `ref:refs/heads/*`
- [ ] **Image signing at build, verification at admission** — unsigned images rejected by admission webhook
- [ ] **Vulnerability scanning blocking in CI pipeline** — high/critical CVEs block merge; base image scan on schedule

**Detection**

- [ ] **CloudTrail / Azure Monitor activity logs enabled in all accounts** — including management plane events; retention ≥ 1 year
- [ ] **GuardDuty / Defender for Cloud enabled** — including Kubernetes runtime protection module
- [ ] **Kubernetes API server audit logs enabled** — `kubectl exec` and `kubectl port-forward` to production alert immediately
- [ ] **Alert on root/Global Admin login, IAM policy changes, broad security group rules, and CloudTrail disablement**

---

## Closing: Security Is Not a Layer You Add — It Is a Property You Design For

The cloud security incidents that make news are rarely the result of a novel attack technique. They are the result of a static credential left in a GitHub repository, a security group rule opened during an incident and never closed, a pod running as root because nobody enforced pod security standards, or a CloudTrail log that would have caught the breach two weeks earlier but was disabled because it felt like overhead.

These are not hard problems. They are consistency problems. The difficulty is not implementing any individual control — every control in this post has mature, well-documented tooling behind it. The difficulty is implementing all of them, before the first incident, and maintaining them as the system evolves. Permission boundaries drift. Network policies get exceptions that never get removed. Secrets rotation gets deferred past the next release and then the one after that.

This is why the controls in this post are designed to be enforced by infrastructure rather than by process. SCPs cannot be overridden by individual accounts regardless of who asks. OIDC-based pipeline authentication makes it structurally impossible to store a long-lived credential — there is no credential to store. Default-deny network policies mean the application team has to add an explicit allow policy rather than relying on the absence of a deny. Admission webhooks reject non-compliant pod specs before they run, not after a security review that happens on a different sprint.

The series started with migration — getting workloads to the cloud. It moved through resilience, modernisation, and cost. Security is not an afterthought at the end of that journey. It is the property that determines whether the workload you have built, modernised, and made cost-efficient can be trusted by the users who depend on it and the organisation that is accountable for it.

> **📌 Key Takeaway**
>
> Cloud security is not a layer you add after the architecture is designed — it is a set of architectural decisions that must be made at the same time as the decisions about resilience, cost, and modernisation covered in the rest of this series. The shared responsibility model's non-delegable rows — identity, secrets, network controls, data encryption — are yours regardless of service model. The controls that work at production scale are the ones enforced by infrastructure, not by process: OIDC replacing static credentials, IRSA and Workload Identity eliminating credential files, default-deny network policies reducing blast radius, Pod Security Admission preventing privilege escalation at admission time, and SCPs making organisation-wide guardrails impossible to override at the account level. Implement them before the first incident. Retrofitting security after a breach is the most expensive way to learn these lessons.

---

*Further Reading: NIST SP 800-207 — Zero Trust Architecture, CNCF — Kubernetes Security Whitepaper (2023), CIS Benchmarks for EKS/AKS, AWS Well-Architected Framework — Security Pillar, Microsoft Cloud Adoption Framework — Security Baseline*
