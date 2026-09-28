---
title: "Always Encrypt in Transit: The Gap Between TLS Everywhere and Actual Transport Security"
published: false
description: Most systems that claim TLS everywhere have TLS at the edge and plaintext everywhere else — here's where the gaps actually are and how to close them.
tags: security, kubernetes, tls, cloudnative
canonical_url: https://aloknecessary.in/blogs/always-encrypt-in-transit/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=always-encrypt-in-transit
cover_image:
---

"We have TLS everywhere." It appears in every architecture review and every compliance questionnaire. The gap is not in the intention — it is in the implementation. Most systems that claim TLS everywhere have TLS at the edge and plaintext everywhere else: the ingress controller to the pod is HTTP, pod-to-pod traffic is unencrypted, and the application-to-database connection string never had `Encrypt=True` or `sslmode=require` set. None of these gaps appear in architecture diagrams.

This post maps where TLS is actually absent, why the gaps exist, and the implementation path that closes them — without defaulting to "add a service mesh" as the answer to every transport security question.

---

## The Four Layers Where TLS Is Actually Absent

Before solutions, the precise inventory of where plaintext exists in systems claiming TLS everywhere:

```text
Scenario: "Secure" architecture
  ✅ HTTPS on the load balancer
  ✅ Private subnets, no public IPs
  ✅ Security groups restricting access
  ❌ Ingress Controller → Pod: plaintext HTTP
  ❌ Pod → Pod: plaintext HTTP/gRPC
  ❌ Application → RDS: plaintext TCP
  ❌ Cluster infrastructure certs: expire annually, no automated rotation

What "TLS everywhere" actually means in this architecture:
  TLS on the edge. Plaintext the rest of the way.
```

**Layer 1 — Ingress-to-pod:** nginx-ingress and Traefik terminate TLS at the edge and forward plain HTTP to backend pods by default. The gap is invisible in architecture diagrams.

**Layer 2 — Pod-to-pod:** Kubernetes does not encrypt data plane traffic. A compromised pod on a shared node can observe plaintext traffic from other pods on the same node — the VPC boundary is not the relevant perimeter here, the pod boundary is.

**Layer 3 — Application-to-database:** Enabling TLS on RDS makes the database *capable* of TLS connections. It does not enforce them. A connection string without `sslmode=require` or `Encrypt=True` connects over plaintext regardless.

**Layer 4 — Cluster infrastructure certs:** kubeadm cluster CA certificates expire after one year by default with no automated renewal. A missed rotation takes down the entire cluster — not an application outage, a cluster-level failure where `kubectl` stops working entirely.

---

## Termination Architecture: Where the Decision Gets Made

Where TLS terminates determines which traffic is encrypted. Three patterns:

**Edge termination only** — TLS terminates at the ingress controller, all internal traffic is plaintext. Legitimate for single-tenant clusters with no regulated data. Not legitimate to call "TLS everywhere."

**Re-encryption** — the ingress controller terminates external TLS and re-encrypts before forwarding to the pod. Closes the ingress-to-pod gap without a service mesh:

```yaml
# NGINX Ingress: re-encrypt to backend over TLS
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: secure-ingress
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
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
              number: 8443
```

**End-to-end mTLS via service mesh** — the mesh intercepts all pod-to-pod traffic and wraps it in mTLS. Strongest posture, highest operational overhead. Justified in regulated multi-tenant clusters; disproportionate for smaller service estates.

---

## cert-manager: The Implementation That Actually Automates It

cert-manager handles issuance, renewal, and storage in Kubernetes Secrets with zero manual steps in the rotation path. One ClusterIssuer and one Certificate resource per service:

```yaml
# ClusterIssuer: Let's Encrypt production
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
# Certificate: 90-day validity, auto-renewed at 60 days remaining
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-certificate
  namespace: production
spec:
  secretName: api-tls-secret
  duration: 2160h
  renewBefore: 720h
  dnsNames:
  - api.yourdomain.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

For internal service-to-service certificates, use a self-signed CA issuer with 24-hour validity — cert-manager makes short-lived internal certs operationally trivial, and a 24-hour certificate has a dramatically smaller blast radius than a one-year certificate if the key is compromised:

```yaml
# Internal service certificate — 24h validity, rotated automatically
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: order-service-cert
  namespace: production
spec:
  secretName: order-service-tls
  duration: 24h
  renewBefore: 8h
  dnsNames:
  - order-service.production.svc.cluster.local
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
```

---

## Certificate Lifecycle: Where Security Controls Become Outages

The failure mode is consistent: a certificate is issued, configured, and forgotten. The alert that was supposed to fire before expiry never got configured, or fired into a channel nobody watches. The certificate expires. The service goes down. The postmortem recommends "better monitoring" — until the same thing happens eighteen months later with a different certificate.

Alert on time-to-expiry, not on expiry. A Prometheus alert that fires at 15 days remaining gives the team time to investigate before the outage. An alert that fires when the certificate has already expired is a notification of an ongoing incident:

```yaml
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
      summary: "Certificate expiring soon"
  - alert: CertificateExpired
    expr: |
      certmanager_certificate_expiration_timestamp_seconds - time() < 0
    labels:
      severity: critical
    annotations:
      summary: "Certificate has EXPIRED"
```

Both alerts are required. Most teams have only the expired alert — which is a notification of an ongoing incident, not a prevention.

---

## mTLS Without a Service Mesh

For fewer than twenty services, cert-manager internal CA plus application-level TLS provides mutual authentication without sidecar injection or a mesh control plane. The application handles the TLS handshake directly using certificates cert-manager issues and rotates automatically:

```csharp
// .NET: present a client certificate and verify the server against the internal CA
var clientCert = X509Certificate2.CreateFromPemFile(clientCertPath, clientKeyPath);
var caCert     = new X509Certificate2(caCertPath);

var handler = new HttpClientHandler();
handler.ClientCertificates.Add(clientCert);
handler.ServerCertificateCustomValidationCallback = (_, cert, chain, _) =>
{
    chain!.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    chain.ChainPolicy.CustomTrustStore.Add(caCert);
    return chain.Build(cert!);
};
```

The certificates are mounted from Kubernetes Secrets that cert-manager manages. When cert-manager rotates the Secret, the volume mount is updated in place — no application restart required.

---

## Read the Full Article

This summary covers the core gaps, termination architecture patterns, cert-manager setup, and the mTLS-without-mesh approach. The full article includes:

- The complete database enforcement gap — `rds.force_ssl`, connection string `Encrypt=True`, and why enabling TLS on the DB is not the same as enforcing it
- The VPC isolation misconception in full — why private subnets don't substitute for encryption
- The "Kubernetes encrypts cluster traffic" misconception — what it actually encrypts vs. what it doesn't
- Full decision framework mapping every traffic path to the right termination architecture
- When regulated environments (PCI-DSS, HIPAA) make full end-to-end TLS non-negotiable
- Eight key takeaways covering every layer of the in-transit security posture

**👉 [Always Encrypt in Transit: The Gap Between TLS Everywhere and Actual Transport Security — Full Article](https://aloknecessary.in/blogs/always-encrypt-in-transit/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=always-encrypt-in-transit)**
