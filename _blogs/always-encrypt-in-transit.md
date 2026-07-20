---
title: "Always Encrypt in Transit: The Gap Between TLS Everywhere and Actual Transport Security"
date: 2026-07-15
last_modified_at: 2026-07-15
author: Alok Ranjan Daftuar
description: "Most systems that claim TLS everywhere have TLS at the edge and plaintext everywhere else. This post maps where encryption is actually absent — ingress-to-pod, pod-to-pod, application-to-database — and the implementation path that closes those gaps without defaulting to a service mesh."
excerpt: "'TLS everywhere' is the right posture and the wrong implementation. This post maps where plaintext actually exists in systems that claim full encryption, the termination architecture decisions that create invisible gaps, certificate lifecycle failures that turn security controls into outages, and the path to transport security that holds up under a compliance audit."
keywords: "TLS, encryption in transit, Kubernetes, cert-manager, mTLS, certificates, transport security, cloud security, ingress, pod-to-pod encryption"
twitter_card: "summary_large_image"
categories:
  - security
  - cloud-architecture
  - kubernetes
tags: [tls, security, kubernetes, cert-manager, mtls, certificates, cloud-security, architecture, production, trade-offs, cloud-native]
series: "Cloud Defaults Reconsidered"
series_order: 5
---

> "TLS everywhere" is the right security posture and the wrong implementation strategy. This post examines where TLS is actually absent in systems that claim to have it, the termination architecture decisions that create plaintext gaps nobody intended, certificate lifecycle failures that turn a security control into an outage, and the implementation path to transport security that holds up under a compliance audit.

## Introduction

"We have TLS everywhere." It appears in every architecture review, every compliance questionnaire, and every security posture document. Like "everything is private" and "Multi-AZ by default," it sounds unambiguously correct. Encryption in transit is unambiguously correct.

The gap is not in the intention. It is in the implementation. Most systems that claim TLS everywhere have TLS at the edge — the load balancer, the ingress controller, the API gateway — and plaintext everywhere else. The traffic from the internet to the cluster boundary is encrypted. The traffic from that boundary to the pod is not. The traffic between pods is not. The traffic from the application to the database within the same VPC is frequently not. The cluster infrastructure certificates that Kubernetes depends on to function expire annually by default, with no automated renewal unless someone deliberately configured it.

None of these gaps appear in architecture diagrams. They are invisible until an auditor asks whether traffic between your ingress controller and your pods is encrypted, and you realise your answer depends on what "in transit" means — a conversation nobody wants to be having at 4 PM on a Friday with a compliance reviewer on the call.

This post maps where TLS is actually absent, why the gaps exist, and the implementation path that closes them — without defaulting to "add a service mesh" as the answer to every transport security question.

<!--more-->

> **Article context:** This is the fifth and final post in the Cloud Defaults Reconsidered series. The [Private Endpoints Everywhere?](/blogs/hidden-cost-of-private-endpoints-everywhere/) post examined reflexive network privatisation. The [Multi-AZ by Default](/blogs/multi-az-by-default/) post examined reflexive availability investment. The [Service Mesh Everywhere?](/blogs/service-mesh-everywhere/) post covered mesh-based mTLS — the heaviest-weight solution to the same problem this post addresses from a lighter-weight angle. The [Microservices by Default](/blogs/microservices-by-default/) post covered distributed architecture trade-offs. This post closes the series by addressing the security layer that underpins everything else — and the specific implementation failures that make "TLS everywhere" a claim rather than a reality.

### Table of Contents

- [Introduction](#introduction)
- [The Three Layers Where TLS Is Actually Absent](#the-three-layers-where-tls-is-actually-absent)
- [The Termination Architecture Decision](#the-termination-architecture-decision)
- [The Common Misconceptions](#the-common-misconceptions)
- [Certificate Lifecycle — Where Security Controls Become Outages](#certificate-lifecycle--where-security-controls-become-outages)
- [When "TLS Everywhere" IS Implemented Correctly](#when-tls-everywhere-is-implemented-correctly)
- [cert-manager — The Implementation That Actually Automates It](#cert-manager--the-implementation-that-actually-automates-it)
- [mTLS Without a Service Mesh](#mtls-without-a-service-mesh)
- [The Decision Framework](#the-decision-framework)
- [Key Takeaways](#key-takeaways)

---

## The Three Layers Where TLS Is Actually Absent

Before the solutions, the precise inventory of where plaintext actually exists in systems claiming TLS everywhere. Most security gaps are not deliberate — they are the result of assuming that configuring TLS at one layer means the adjacent layers are also covered.

### Layer 1: Ingress-to-Pod Traffic

Most Kubernetes clusters running nginx-ingress or Traefik terminate TLS at the edge and then forward plain HTTP to backend services over the cluster network. The HTTPS traffic from the internet to the ingress controller is encrypted. The HTTP traffic from the ingress controller to the application pod is not.

```text
External client
    │  HTTPS (encrypted)
    ▼
Ingress Controller (TLS terminates here)
    │  HTTP (plaintext) ← the gap nobody drew on the architecture diagram
    ▼
Application Pod
```

Teams accept this because the pod-to-ingress traffic is "internal." But shared clusters, multi-tenant environments, and compliance frameworks with explicit in-transit encryption requirements all define "in transit" as any network path — not just the external path. The gap is real, and it is invisible in a standard architecture diagram.

### Layer 2: Pod-to-Pod Traffic

Pod-to-pod traffic is commonly sent in plaintext unless you add TLS or mTLS yourself. A frontend pod calling a backend pod, a microservice contacting a database, or one internal API invoking another — all may be moving over the network in plaintext.

Kubernetes does not encrypt pod-to-pod traffic by default. The CNI overlay network carries whatever the pods send — TCP, HTTP, or gRPC — with no encryption layer unless the application implements TLS or a mesh intercepts and wraps it. In a cluster where pods from multiple teams run on shared nodes, this is a lateral movement risk: a compromised pod on a shared node can intercept plaintext traffic from pods it was never intended to reach.

### Layer 3: Application-to-Database Traffic

The most overlooked gap. An application running over HTTPS, in a VPC with no internet access, connecting to an RDS instance in a private subnet — frequently connecting over plaintext TCP because the JDBC or ADO.NET connection string does not enforce TLS, and the database's `rds.force_ssl` parameter is not set.

```text
Scenario: "Secure" architecture
  ✅ HTTPS on the load balancer
  ✅ Private subnets, no public IPs
  ✅ Security groups restricting access
  ❌ Application → RDS: plaintext TCP
  ❌ Application → ElastiCache: plaintext TCP
  ❌ Pod → Pod: plaintext HTTP

What "TLS everywhere" actually means in this architecture:
  TLS on the edge. Plaintext the rest of the way.
```

### Layer 4: Cluster Infrastructure Certificates

Kubernetes uses certificates extensively — for securing the API server, authenticating kubelets, and encrypting etcd communication. Cluster CA certificates managed by kubeadm expire after one year by default. Missed renewal breaks the entire cluster.

This is the certificate lifecycle failure mode that produces the highest blast radius: not an application outage, but a cluster-level failure where `kubectl` stops working, pods cannot be scheduled, and every Kubernetes operation fails — until someone manually rotates the cluster certificates under time pressure. Managed Kubernetes services (EKS, AKS, GKE) handle cluster certificate rotation automatically. Self-managed clusters using kubeadm do not, and the one-year expiry is not prominently surfaced in the initial setup documentation.

---

## The Termination Architecture Decision

Where TLS terminates determines which traffic is encrypted. This is the architectural decision that most "TLS everywhere" implementations get wrong by omission — they configure the edge without explicitly deciding what happens after it.

Three patterns for handling TLS in Kubernetes:

**Pattern 1: Edge termination only**

TLS terminates at the ingress controller. All internal traffic is plaintext. This is the default configuration for nginx-ingress, Traefik, and AWS ALB Ingress. It is appropriate when: the cluster is single-tenant, compliance requirements specify only external encryption, or the operational overhead of internal TLS is not justified.

**Pattern 2: Re-encryption (ingress-to-pod TLS)**

The ingress controller terminates external TLS and re-encrypts before forwarding to the pod. The pod serves its own TLS certificate. Each application handles its own certificate management.

```yaml
# NGINX Ingress: re-encrypt to backend over TLS
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: secure-ingress
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"   # re-encrypt to pod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts: [api.yourdomain.com]
    secretName: api-tls-secret
  rules:
  - host: api.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8443   # pod serves HTTPS on 8443
```

Re-encryption closes the ingress-to-pod gap without requiring a service mesh. The operational cost: each application pod needs a certificate. cert-manager automates this — covered in detail below.

**Pattern 3: End-to-end mTLS via service mesh**

Covered in the [Service Mesh Everywhere?](/blogs/service-mesh-everywhere/) post. The mesh intercepts all pod-to-pod traffic and wraps it in mTLS using automatically managed certificates. The strongest posture, highest operational overhead. Justified in regulated multi-tenant clusters; disproportionate for smaller service estates.

The decision is not which pattern is "best" — it is which pattern matches your actual threat model and compliance requirement. Edge termination only is not a security failure if your threat model does not require internal encryption. Claiming TLS everywhere while running edge termination only is.

---

## The Common Misconceptions

### "Our Traffic Is in a Private VPC, So It's Safe"

Network isolation and encryption solve different problems. A private VPC limits which external entities can reach your network. It does not prevent a compromised workload inside the VPC from intercepting plaintext traffic on the same network segment. Lateral movement attacks — where an attacker compromises one pod and uses it to observe traffic from others — do not cross the VPC boundary. They work within it.

```text
Developer:   "All our services are in a private VPC. We don't need
              TLS between pods."
Auditor:     "If an attacker compromised your payment-processor pod,
              could they observe traffic between your order-service
              and your database?"
Developer:   "Well... they'd have to be on the same node."
Auditor:     "Are your pods guaranteed to not share nodes with other
              workloads?"
Developer:   "No, we use shared node pools."
Auditor:     "Then the VPC boundary is not the relevant perimeter
              for this threat. The pod boundary is."
Developer:   "..."
```

VPC-level isolation is a necessary control. It is not a substitute for encryption. Both are required for a complete in-transit security posture.

### "Kubernetes Encrypts Cluster Traffic by Default"

Partially true, significantly misunderstood. Kubernetes encrypts control plane communication — API server, etcd, kubelet. It does not encrypt pod-to-pod data plane traffic. The cluster infrastructure is secured; the workloads running on it are not, by default.

```text
What Kubernetes encrypts by default:
  ✅ API server ↔ etcd
  ✅ API server ↔ kubelet
  ✅ kubectl ↔ API server

What Kubernetes does NOT encrypt by default:
  ❌ Pod ↔ Pod (data plane traffic)
  ❌ Ingress Controller → Pod (backend traffic)
  ❌ Application → Database (connection strings)
```

### "We Enabled TLS on the Database — We're Done"

Enabling TLS on RDS or Azure SQL makes the database *capable* of TLS connections. It does not enforce them. A connection string without `sslmode=require` (PostgreSQL) or `Encrypt=True` (SQL Server) will connect over plaintext regardless of the database's TLS configuration.

```text
# Plaintext connection — TLS enabled on RDS but not enforced by the client
Server=rds-endpoint.amazonaws.com;Database=mydb;User=admin;Password=...

# TLS enforced by the connection string — correct
Server=rds-endpoint.amazonaws.com;Database=mydb;User=admin;Password=...;
Encrypt=True;TrustServerCertificate=False;

# PostgreSQL: enforce TLS
postgresql://user:password@rds-endpoint:5432/mydb?sslmode=require
```

The `rds.force_ssl` parameter forces TLS at the database level, rejecting plaintext connections regardless of what the client requests. This is the defence-in-depth layer that makes the database-level control meaningful even when a connection string is misconfigured. Set it. Do not rely on connection strings alone.

---

## Certificate Lifecycle — Where Security Controls Become Outages

Certificate-related outages are common in organisations managing large certificate inventories, and remediation can be costly. Automated rotation is not optional for production mTLS deployments.

The failure mode is predictable and consistent: a certificate is issued, configured, and promptly forgotten. The monitoring that was supposed to alert before expiry was never configured, or the alert fired into a channel nobody watches during the holiday period, or the renewal process requires manual intervention that never happened. The certificate expires. The service goes down. The outage postmortem lists "certificate expiry" as the root cause and recommends "better monitoring" — until the same thing happens eighteen months later with a different certificate.

Three structural changes that break this cycle:

**Short-lived certificates with automated rotation.** cert-manager issues certificates with 90-day validity by default (matching Let's Encrypt). It begins renewal at 60 days — a third of the lifetime remaining. The certificate is rotated automatically before it expires, without human intervention, every time. The window between "certificate was last rotated" and "certificate expires" is always less than 90 days; the window before renewal begins is always 60 days. There is no manual step in the critical path.

**Alert on time-to-expiry, not on expiry.** A Prometheus alert that fires when a certificate has less than 15 days remaining gives the team time to investigate and intervene before the outage. An alert that fires when the certificate has already expired is a notification of an ongoing incident, not a prevention. Most teams have the latter. The former requires one alert rule and does not require a service mesh or a complex PKI.

**Cluster infrastructure certificates on managed Kubernetes.** For EKS, AKS, and GKE, the control plane certificate lifecycle is managed by the provider. For self-managed clusters, configure `kubeadm` certificate rotation explicitly and verify it runs. The annual default expiry with no automated rotation is the single highest-blast-radius certificate failure mode in Kubernetes — not because it is subtle, but because it is invisible until it fires.

---

## When "TLS Everywhere" IS Implemented Correctly

### Single-Tenant Clusters With Low Compliance Exposure

Edge termination only is a legitimate choice when: the cluster is single-tenant, the workloads do not handle regulated data, and the compliance framework does not specify internal encryption. Implementing internal TLS for a development cluster hosting a team's tooling is disproportionate overhead. Edge termination closes the external gap that matters most.

The honest answer to "do we have TLS everywhere?" in this case is: "We have TLS on all external traffic. Internal traffic is unencrypted and we have documented that this is acceptable given our threat model." That is a defensible security posture. "We have TLS everywhere" when you have edge termination only is not.

### Regulated Environments With Explicit Requirements

PCI-DSS Requirement 4.2 requires encryption of cardholder data in transit. HIPAA requires encryption of protected health information in transit. Both frameworks interpret "in transit" as any network path, including pod-to-pod and application-to-database. For these workloads, full end-to-end TLS is not a trade-off to evaluate — it is a compliance requirement to implement.

The implementation options are: re-encryption at ingress plus application-level TLS for pod-to-pod (lighter-weight), or a service mesh that provides cluster-wide mTLS (heavier-weight). For workloads in this category, the choice between these is driven by service count and operational capacity — not by whether to implement.

### Public-Facing APIs With User Data

Any service that handles credentials, session tokens, PII, or financial data requires TLS on all paths that carry that data — not just the external path. The argument that "it's internal, it's safe" breaks down the moment the definition of "safe" includes protection against a compromised workload on a shared node.

---

## cert-manager — The Implementation That Actually Automates It

cert-manager is the standard certificate lifecycle manager for Kubernetes. It integrates with Let's Encrypt (via ACME), AWS ACM Private CA, Azure Key Vault, HashiCorp Vault, and self-signed issuers. It handles issuance, renewal, and storage in Kubernetes Secrets — with zero manual steps in the rotation path.

```yaml
# ClusterIssuer: Let's Encrypt production (ACME HTTP-01)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
---
# Certificate: issued for the API service, auto-renewed at 60 days
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-certificate
  namespace: production
spec:
  secretName: api-tls-secret
  duration: 2160h        # 90 days
  renewBefore: 720h      # renew at 60 days remaining
  subject:
    organizations: [Your Org]
  dnsNames:
  - api.yourdomain.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

For internal service-to-service certificates where Let's Encrypt is not appropriate (internal-only domains), use a self-signed CA issuer — cert-manager generates and manages the CA, issues service certificates from it, and rotates them on the same automated schedule:

```yaml
# Internal CA for service-to-service certificates
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-ca-key-pair   # CA cert and key stored as a Secret
---
# Certificate for internal service — valid 24h, rotated automatically
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: order-service-cert
  namespace: production
spec:
  secretName: order-service-tls
  duration: 24h          # short-lived — reduces blast radius of key compromise
  renewBefore: 8h        # renew with plenty of buffer
  dnsNames:
  - order-service.production.svc.cluster.local
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
```

24-hour validity for internal service certificates is the pattern cert-manager makes practical. A certificate that lives 24 hours and is rotated automatically has a dramatically smaller blast radius than a one-year certificate stored in a Secret — if the key is compromised, the window of exposure is hours, not a year.

### Monitoring Certificate Expiry

```yaml
# Prometheus alert: fire 15 days before expiry — prevention, not notification
groups:
- name: certificate-expiry
  rules:
  - alert: CertificateExpiringIn15Days
    expr: |
      certmanager_certificate_expiration_timestamp_seconds
        - time() < (15 * 24 * 3600)
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Certificate {{ $labels.name }} expires in less than 15 days"
      description: >
        Certificate {{ $labels.namespace }}/{{ $labels.name }} expires at
        {{ $value | humanizeTimestamp }}. Investigate cert-manager renewal logs.

  - alert: CertificateExpired
    expr: |
      certmanager_certificate_expiration_timestamp_seconds - time() < 0
    labels:
      severity: critical
    annotations:
      summary: "Certificate {{ $labels.name }} has EXPIRED"
```

Both alerts are required. The 15-day warning gives the team time to investigate a renewal failure before it becomes an outage. The expired alert catches the case where the warning was missed or the renewal failed silently.

---

## mTLS Without a Service Mesh

The [Service Mesh Everywhere?](/blogs/service-mesh-everywhere/) post made the case that a mesh is disproportionate for small service estates. The question it left open: how do you get mutual TLS between services without a mesh?

The answer for small-to-medium service estates: cert-manager issues service certificates, each service presents its certificate to the other, and both verify against the same internal CA. No sidecar, no mesh control plane, no DaemonSet ztunnel. The application handles the TLS handshake directly.

```csharp
// .NET: configure HttpClient to present a client certificate and verify the server
// Both sides use certificates issued by the same internal CA

var clientCertPath = "/var/run/secrets/tls/tls.crt";
var clientKeyPath  = "/var/run/secrets/tls/tls.key";
var caCertPath     = "/var/run/secrets/ca/ca.crt";

var clientCert = X509Certificate2.CreateFromPemFile(clientCertPath, clientKeyPath);
var caCert     = new X509Certificate2(caCertPath);

var handler = new HttpClientHandler();
handler.ClientCertificates.Add(clientCert);
handler.ServerCertificateCustomValidationCallback = (_, cert, chain, _) =>
{
    // Verify the server certificate was issued by our internal CA
    chain!.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    chain.ChainPolicy.CustomTrustStore.Add(caCert);
    return chain.Build(cert!);
};

var client = new HttpClient(handler)
{
    BaseAddress = new Uri("https://payments-service.production.svc.cluster.local:8443")
};
```

The certificates are mounted from Kubernetes Secrets that cert-manager manages and rotates automatically. The application reads them from the mounted path — no restart required when cert-manager rotates the Secret, because the volume mount is updated in place by Kubernetes.

This pattern applies equally to Node.js (`tls.createSecureContext`), Go (`tls.Config`), and Java (`SSLContext`). The certificate management is cert-manager's job; the TLS handshake is the application's job. A mesh is not required to make them work together.

---

## The Decision Framework

```text
Step 1: Map every traffic path in your system

For each path:
  External client → Load Balancer/Ingress → Pod
  Pod → Pod (service-to-service calls)
  Pod → Database / Cache / Message Broker
  kubectl → API Server (cluster infrastructure)

For each path, answer:
  Is this path currently encrypted?
  Does your threat model require it to be?
  Does your compliance framework require it to be?

Step 2: Choose termination architecture

Single-tenant, low compliance exposure:
  → Edge termination only
  → Force TLS on all database connections (rds.force_ssl, connection string Encrypt=True)
  → Automate cluster certificate rotation (managed K8s or kubeadm config)

Multi-tenant or compliance-in-scope (PCI, HIPAA):
  → Re-encryption at ingress (nginx backend-protocol: HTTPS)
  → cert-manager internal CA for pod-to-pod mTLS
  → Evaluate service mesh only if service count > 20 (see service mesh post)
  → Force TLS on all data store connections

Step 3: Automate certificate lifecycle — no exceptions

All environments:
  → cert-manager for application certificates
  → 90-day validity for external certs, 24h for internal service certs
  → Prometheus alert at 15-day expiry warning
  → Managed Kubernetes for cluster infrastructure certs

Step 4: Enforce at both ends

For each encrypted path:
  → Database: set rds.force_ssl=1 or Azure equivalent
  → Application: connection string must specify TLS/Encrypt=True
  → Pod-to-pod: server verifies client cert; client verifies server cert
  → Never disable certificate verification — self-signed with verification
     disabled is not encryption, it is false confidence
```

---

## Key Takeaways

1. **"TLS everywhere" is an implementation claim, not a configuration switch.** Most systems that claim it have TLS at the edge and plaintext between the ingress controller and the pod, between pods, and between the application and the database. Map every traffic path before claiming the posture.

2. **VPC-level isolation does not substitute for encryption.** A compromised pod on a shared node can observe plaintext traffic from other pods on the same node regardless of whether those pods are in a private subnet. The relevant perimeter for pod-to-pod traffic is the pod boundary, not the VPC boundary.

3. **Enabling TLS on the database does not enforce it.** `rds.force_ssl` rejects plaintext connections at the database level, regardless of what the client requests. Set it. Do not rely on connection strings alone — connection strings get misconfigured, copied without the TLS flag, or overridden by library defaults.

4. **Kubernetes encrypts the control plane, not the data plane.** API server, etcd, and kubelet communication is encrypted by default. Pod-to-pod traffic is not. Ingress-to-pod traffic is not. Treating cluster-level TLS as coverage for application-level traffic is the most common gap in "TLS everywhere" claims.

5. **Cluster certificate expiry with no automated rotation is the highest-blast-radius certificate failure.** kubeadm clusters expire cluster CA certificates annually by default. A missed renewal takes down the entire cluster. Use managed Kubernetes or configure `kubeadm` certificate rotation explicitly.

6. **cert-manager makes automated certificate rotation operationally trivial.** 24-hour internal service certificates, automatic renewal, Prometheus metrics for expiry monitoring — the entire certificate lifecycle runs without human intervention once configured. The implementation cost is one ClusterIssuer and one Certificate resource per service. There is no justification for manual certificate management in a Kubernetes environment in 2026.

7. **mTLS between services does not require a service mesh.** For fewer than twenty services, cert-manager internal CA plus application-level TLS provides mutual authentication without the operational overhead of a mesh control plane, sidecar injection, or per-node DaemonSets.

8. **Alert at 15 days before expiry, not at expiry.** An alert that fires when a certificate has expired is a notification of an ongoing incident. An alert that fires when 15 days remain is a prevention. Both are required; most teams have only the latter.

---
