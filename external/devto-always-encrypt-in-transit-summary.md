---
title: "Always Encrypt in Transit: The Gap Between TLS Everywhere and Actual Transport Security"
published: false
description: Most systems that claim TLS everywhere have TLS at the edge and plaintext everywhere else — here's where the gaps actually are and how to close them.
tags: security, kubernetes, tls, cloudnative
canonical_url: https://aloknecessary.github.io/blogs/always-encrypt-in-transit/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=always-encrypt-in-transit
cover_image:
---

"We have TLS everywhere." It appears in every architecture review and every compliance questionnaire. The gap is not in the intention — it is in the implementation. Most systems that claim TLS everywhere have TLS at the edge and plaintext everywhere else: the ingress controller to the pod is HTTP, pod-to-pod traffic is unencrypted, and the application-to-database connection string never had `Encrypt=True` or `sslmode=require` set. None of these gaps appear in architecture diagrams.

The certificate lifecycle problem compounds this. A certificate is issued, configured, and forgotten. The alert that was supposed to fire before expiry never got configured, or fired into a channel nobody watches. The certificate expires. The service goes down. The postmortem recommends "better monitoring" — until the same thing happens eighteen months later with a different certificate. For kubeadm-managed clusters, the cluster CA itself expires annually by default, and a missed renewal takes down the entire cluster.

The fix does not require a service mesh. cert-manager handles issuance, renewal, and rotation automatically — 90-day external certificates, 24-hour internal service certificates, Prometheus alerts at 15 days before expiry. For fewer than twenty services, cert-manager plus application-level TLS provides mutual authentication without sidecar injection or a mesh control plane. The implementation cost is one ClusterIssuer and one Certificate resource per service.

---

## Read the Full Article

This is a summary of the fifth and final post in the Cloud Defaults Reconsidered series. The full article includes:

- Precise inventory of the four layers where TLS is actually absent (ingress-to-pod, pod-to-pod, app-to-database, cluster infrastructure certs)
- Three termination architecture patterns with NGINX Ingress re-encryption manifest
- Common misconceptions debunked (private VPC = safe, Kubernetes encrypts everything, enabling TLS on the DB is enough)
- Full cert-manager setup: ClusterIssuer, Certificate resources, 24h internal certs, Prometheus expiry alerts
- .NET HttpClient mTLS implementation without a service mesh
- Decision framework: map every traffic path, choose termination architecture, automate lifecycle, enforce at both ends

**👉 [Always Encrypt in Transit — Full Article](https://aloknecessary.github.io/blogs/always-encrypt-in-transit/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=always-encrypt-in-transit)**
