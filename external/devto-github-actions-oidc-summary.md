---
title: "GitHub Actions OIDC: Eliminating Long-Lived Credentials from Your CI/CD Pipeline"
published: false
description: A production implementation guide to GitHub Actions OIDC for AWS and Azure — trust policy design, sub claim scoping, per-job role architecture, reusable workflow federation, and the migration path from static secrets
tags: github, devops, aws, security
canonical_url: https://aloknecessary.github.io/blogs/github-actions-oidc/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=github-actions-oidc
cover_image: 
---

Every GitHub Actions workflow that deploys to AWS or Azure needs cloud credentials. The traditional answer — generate an IAM access key or Azure client secret, store it in GitHub secrets — works, but means you have a long-lived credential that's valid until you notice it leaked and manually revoke it.

OpenID Connect eliminates this at the architectural level. Your workflow requests a short-lived token from GitHub's OIDC provider, exchanges it with AWS STS or Azure's token endpoint, and receives temporary credentials valid for the duration of the job. No secret to store. No credential to rotate. No static value to leak.

---

## How It Works

```text
GitHub Actions Job
    │  1. Requests OIDC token from GitHub
    ▼
GitHub OIDC Provider (token.actions.githubusercontent.com)
    │  2. Issues signed JWT (sub, repo, ref, environment, exp: 5min)
    ▼
AWS STS / Azure Token Endpoint
    │  3. Validates JWT, checks trust policy conditions
    │  4. Issues temporary credentials (15min–1hr)
    ▼
GitHub Actions Job (continues with scoped credentials)
```

The `sub` claim encodes the repository, branch, and environment — every trust policy decision is a decision about which `sub` values you trust.

---

## Trust Policy Scoping — The Critical Detail

Most tutorials show the broadest condition that works. Production requires precision:

- **`repo:org/repo:environment:production`** — strongest for production; coupled to GitHub Environment protection rules (required reviewers, deployment gates)
- **`repo:org/repo:ref:refs/heads/main`** — good for staging; only main branch
- **`repo:org/repo:*`** — acceptable for dev/sandbox only
- **`repo:org/*`** — never use for anything with real permissions

The environment-scoped condition means an unapproved deployment cannot produce the token needed to assume the production role. The gate is enforced at the identity layer.

---

## Per-Job Role Architecture

Because each job gets its own fresh token, you can scope each job to exactly the permissions it needs:

- **Plan job** → read-only role, branch-scoped trust
- **Build & push job** → ECR/ACR push permissions only, branch-scoped trust
- **Deploy job** → deployment permissions, environment-scoped trust with approval gate

One role per responsibility. Minimum permissions per role. The blast radius of any single compromised job is limited to its specific task.

---

## The Audit Trail Static Credentials Cannot Provide

Every OIDC credential issuance produces a CloudTrail event with the full GitHub context — repository, branch, workflow run, commit. The `role-session-name` encodes the GitHub run ID, so every subsequent API call is traceable to the exact workflow execution.

With static access keys, you see the IAM user name — shared across all workflows, with no way to distinguish which run triggered each API call.

---

## Migration Path

The sequence that eliminates risk:

1. Create the IAM role / Azure federated credential with correct trust policy
2. Add `id-token: write` permission to the workflow job
3. Add OIDC credential step — leave static credential commented but present
4. Verify end-to-end on a branch
5. Remove static credential step
6. **Delete the credential from the cloud provider** — not just from GitHub secrets

Step 6 is what most teams defer indefinitely. The credential still exists and could be used by anyone with direct knowledge of the key.

---

## Read the Full Article

This is a condensed version. The full article includes complete, production-ready implementations:

**👉 [GitHub Actions OIDC: Eliminating Long-Lived Credentials — Full Article](https://aloknecessary.github.io/blogs/github-actions-oidc/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=github-actions-oidc)**

The full article includes:

- Complete AWS setup (OIDC provider + IAM role with Terraform)
- Complete Azure setup (Entra ID app registration + federated credentials)
- Full workflow files for AWS ECR+ECS and Azure ACR+AKS deployments
- Reusable workflow federation with `job_workflow_ref` claim customisation
- Common failure modes and debug steps (token expiry, trust policy mismatches)
- Production checklist for retiring static credentials
