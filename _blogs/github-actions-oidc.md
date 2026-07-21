---
title: "GitHub Actions OIDC: Eliminating Long-Lived Credentials from Your CI/CD Pipeline"
date: 2026-07-15
last_modified_at: 2026-07-15
author: Alok Ranjan Daftuar
description: "A production implementation guide to GitHub Actions OIDC authentication for AWS and Azure â€” trust policy design, sub claim scoping, per-job role architecture, reusable workflow federation, the migration path from static secrets, and the audit trail OIDC gives you that stored credentials never could."
excerpt: "OpenID Connect eliminates long-lived CI/CD credentials at the architectural level. This post covers the full implementation for AWS and Azure â€” OIDC provider setup, trust policy scoping, per-job role architecture, reusable workflow federation, the migration path from static secrets, and the audit trail that stored credentials structurally cannot provide."
keywords: "github actions oidc, aws oidc, azure federated credentials, ci/cd security, eliminate static credentials, sts assume role, workload identity federation"
categories:
  - architecture
  - devops
tags: [github-actions, oidc, aws, azure, security, ci-cd, devops, iam, authentication, secrets-management, production]
series: "DevOps & Platform Engineering"
series_order: 6
---

Every GitHub Actions workflow that deploys to AWS or Azure needs cloud credentials. The question is what form those credentials take.

The traditional answer: generate an IAM user access key or an Azure service principal client secret, copy it into GitHub repository secrets, and reference it in your workflow. This works. It also means you now have a long-lived credential — valid indefinitely, or until you remember to rotate it — stored in GitHub's secrets vault, referenced in every workflow that needs cloud access, and shared across every branch, every environment, and every developer who can trigger a workflow run.

When that secret leaks — and secrets in CI/CD systems leak regularly, through log output, through compromised runner environments, through supply chain attacks on third-party actions — the attacker has a credential that works until you notice and manually revoke it. You are racing a clock you don't know is running.

OpenID Connect eliminates this problem at the architectural level. Instead of storing a long-lived credential in GitHub, your workflow requests a short-lived token from GitHub's OIDC provider, presents it to AWS STS or Azure's token endpoint, and receives temporary credentials valid for the duration of the job — typically 15 minutes to one hour. No secret to store. No credential to rotate. No static value to leak. And every credential issuance is logged in CloudTrail or Azure Monitor with the exact repository, branch, workflow, and run ID that requested it — an audit trail static credentials structurally cannot provide.

The [Self-Hosted Runners on Kubernetes](/blogs/self-hosted-runners-kubernetes/) post covered OIDC-based cloud auth as a hardening layer without going into the implementation. The [Cloud Security Architecture](/blogs/cloud-security-architecture/) post outlined the pattern in the context of a broader security posture. This post is the full implementation: both providers, trust policy design, per-job role architecture, reusable workflow federation, and the migration path from static secrets you likely already have.

## Table of Contents

- [How GitHub Actions OIDC Works](#how-github-actions-oidc-works)
- [1. AWS Setup — OIDC Provider and IAM Role](#1-aws-setup--oidc-provider-and-iam-role)
- [2. Scoping the Trust Policy — The Detail Most Tutorials Skip](#2-scoping-the-trust-policy--the-detail-most-tutorials-skip)
- [3. Azure Setup — Federated Identity Credentials](#3-azure-setup--federated-identity-credentials)
- [4. Per-Job Role Architecture — One Role Per Responsibility](#4-per-job-role-architecture--one-role-per-responsibility)
- [5. Reusable Workflow Federation](#5-reusable-workflow-federation)
- [6. The Migration Path from Static Secrets](#6-the-migration-path-from-static-secrets)
- [7. The Audit Trail OIDC Gives You](#7-the-audit-trail-oidc-gives-you)
- [8. Common Failure Modes and How to Debug Them](#8-common-failure-modes-and-how-to-debug-them)
- [Production Checklist](#production-checklist)

---

## How GitHub Actions OIDC Works

Before implementation, the token exchange flow precisely — because understanding it is what lets you debug it when something goes wrong.

```text
GitHub Actions Job
    │
    │  1. Job requests OIDC token from GitHub's token endpoint
    ▼
GitHub OIDC Provider (token.actions.githubusercontent.com)
    │
    │  2. Issues a signed JWT containing claims:
    │     sub:              "repo:your-org/your-repo:ref:refs/heads/main"
    │     repository:       "your-org/your-repo"
    │     ref:              "refs/heads/main"
    │     job_workflow_ref: "your-org/your-repo/.github/workflows/deploy.yml@refs/heads/main"
    │     environment:      "production"  (if GitHub Environment is configured)
    │     aud:              "sts.amazonaws.com"
    │     exp:              <5 minutes from issue time>
    ▼
AWS STS / Azure Token Endpoint
    │
    │  3. Validates JWT signature against GitHub's public keys
    │  4. Checks claims against trust policy conditions
    │  5. Issues temporary credentials (15min–1hr, role-scoped)
    ▼
GitHub Actions Job (continues with temporary credentials)
```

Two things worth noting from this flow. First: the JWT expires in five minutes. If your workflow has a long-running step before the `configure-aws-credentials` action runs, the token may expire before it's exchanged. Always authenticate first, before any long-running setup steps. Second: the `sub` claim is the primary trust condition — it encodes the repository, ref (branch/tag/PR), and environment. Every trust policy decision you make is essentially a decision about which `sub` values you trust.

> **July 2026 change:** For repositories created after July 15, 2026, or that have opted into immutable subject claims, the `sub` claim includes the numeric owner and repository IDs rather than the mutable names. This means a repository rename no longer breaks your trust policy — the ID is stable. New repositories should opt into this immediately; existing repositories can migrate via repository settings.

---

## 1. AWS Setup — OIDC Provider and IAM Role

Two resources are required in AWS: an OIDC identity provider that tells AWS to trust tokens from GitHub, and an IAM role that workflows can assume when their token matches the trust policy.

The OIDC provider is created once per AWS account, not per repository. All your repositories share it.

```bash
# Create the GitHub OIDC identity provider in your AWS account
# This is idempotent — safe to run even if it already exists
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

# Verify it was created
aws iam list-open-id-connect-providers
```

The thumbprint is GitHub's OIDC provider certificate thumbprint. AWS uses it to verify tokens are genuinely from GitHub. GitHub rotates this certificate periodically — when they do, AWS automatically fetches the new thumbprint if the provider was created correctly, but it's worth confirming after any GitHub certificate rotation announcement.

Now create the IAM role. The trust policy is the critical part — covered in detail in the next section. The Terraform definition is the recommended approach for any production setup because it makes the trust conditions explicit, reviewable, and version-controlled:

```hcl
# Terraform: IAM role for GitHub Actions deployment to production
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions_deploy" {
  name = "github-actions-deploy-production"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
      }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Scope to specific repo AND environment — not just repo
          "token.actions.githubusercontent.com:sub" = "repo:your-org/your-repo:environment:production"
        }
      }
    }]
  })
}

# Attach only the permissions this role actually needs
resource "aws_iam_role_policy_attachment" "deploy_policy" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = aws_iam_policy.deploy_permissions.arn
}
```

---

## 2. Scoping the Trust Policy — The Detail Most Tutorials Skip

The trust policy's `sub` condition is the security boundary. Getting it wrong means either workflows that should be trusted are rejected, or workflows that should not be trusted can assume the role. Most tutorials show the broadest condition that works and leave hardening as an exercise for the reader. This section is that hardening.

The `sub` claim follows a predictable pattern based on what triggered the workflow:

```text
Branch push:     repo:ORG/REPO:ref:refs/heads/BRANCH
Tag push:        repo:ORG/REPO:ref:refs/tags/TAG
Pull request:    repo:ORG/REPO:pull_request
Environment:     repo:ORG/REPO:environment:ENVIRONMENT_NAME
Reusable wf:     repo:ORG/REPO:ref:refs/heads/BRANCH  (caller's sub)
```

**The conditions from least to most restrictive**, with when each is appropriate:

```json
// ❌ Never use this for production — any workflow in your org can assume the role
"token.actions.githubusercontent.com:sub": "repo:your-org/*"

// ⚠️  Any branch in your repo — acceptable for dev/sandbox roles only
"token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:*"

// ✅  Only main branch deploys — good for staging roles
"token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:ref:refs/heads/main"

// ✅  Only when a GitHub Environment named 'production' is used — best for production roles
// Requires the workflow to declare `environment: production` and
// for that environment to have protection rules (required reviewers, deployment gates)
"token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:environment:production"

// ✅  Multiple conditions with StringLike for tag-based releases
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:ref:refs/tags/v*"
}
```

The environment-scoped condition is the strongest for production deployments because it couples OIDC trust to GitHub's own environment protection rules — required reviewers, deployment branch restrictions, wait timers. A workflow that hasn't passed those gates cannot produce an environment-scoped token for that environment, and therefore cannot assume the production role. The two systems reinforce each other.

---

## 3. Azure Setup — Federated Identity Credentials

Azure's equivalent to the IAM trust policy is a federated identity credential attached to a managed identity or app registration. The setup requires three resources: an Entra ID app registration, a federated credential defining which GitHub tokens it trusts, and role assignments giving the identity the permissions it needs.

```bash
# Create an app registration (do this in Terraform for production — shown as CLI for clarity)
APP_ID=$(az ad app create --display-name "github-actions-deploy-production" --query appId -o tsv)
OBJECT_ID=$(az ad app show --id $APP_ID --query id -o tsv)

# Create a service principal for the app
az ad sp create --id $APP_ID

# Add a federated identity credential scoped to the production environment
az ad app federated-credential create \
  --id $OBJECT_ID \
  --parameters '{
    "name": "github-production-environment",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:your-org/your-repo:environment:production",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# Assign the role the deployment needs (scope to resource group, not subscription)
az role assignment create \
  --assignee $APP_ID \
  --role "Contributor" \
  --scope /subscriptions/YOUR_SUBSCRIPTION_ID/resourceGroups/your-rg
```

The three values that need to be stored as GitHub secrets (not credentials — these are non-sensitive identifiers):

```text
AZURE_CLIENT_ID:       the app registration's client ID
AZURE_TENANT_ID:       your Entra ID tenant ID
AZURE_SUBSCRIPTION_ID: your Azure subscription ID
```

No client secret. No certificate. Those three values tell `azure/login` which identity to request a token for — the actual authentication proof comes from the OIDC token GitHub generates, not from a stored secret.

The workflow step:

```yaml
- name: Azure Login
  uses: azure/login@v3
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
  # No client-secret field — OIDC handles the authentication
```

---

## 4. Per-Job Role Architecture — One Role Per Responsibility

The most common mistake after getting OIDC working: one role with broad permissions used across all jobs in all workflows. This is better than a single static access key, but it misses the key security improvement OIDC enables — because each job gets its own fresh token, you can scope each job to exactly the permissions it needs for its specific task.

The architecture: one role/identity per deployment responsibility, each with the minimum permissions for that task, each with a trust policy scoped to the appropriate branch or environment. The two workflow files below are complete, production-ready implementations — AWS targeting ECR + ECS, Azure targeting ACR + AKS.

### AWS — ECR + ECS Deployment

```yaml
# .github/workflows/deploy-aws.yml
name: Deploy to AWS

on:
  push:
    branches: [main]

env:
  AWS_REGION: eu-west-1
  ECR_REGISTRY: 123456789.dkr.ecr.eu-west-1.amazonaws.com
  ECR_REPOSITORY: your-app
  ECS_CLUSTER: production
  ECS_SERVICE: your-app-service
  CONTAINER_NAME: your-app

jobs:
  # Job 1: Terraform plan — read-only, no environment gate required
  plan:
    name: Terraform Plan
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # required for OIDC token request
      contents: read
    steps:
      - uses: actions/checkout@v6

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-plan
          # IAM trust policy sub: repo:your-org/your-repo:ref:refs/heads/main
          # IAM permissions: ReadOnlyAccess scoped to relevant resources only
          role-session-name: GitHubActions-Plan-${{ github.run_id }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v4

      - name: Terraform Init
        run: terraform init

      - name: Terraform Plan
        run: terraform plan -out=tfplan

      - name: Upload plan artifact
        uses: actions/upload-artifact@v6
        with:
          name: tfplan
          path: tfplan
          retention-days: 1

  # Job 2: Build and push image to ECR — scoped to ECR permissions only
  build-and-push:
    name: Build & Push to ECR
    runs-on: ubuntu-latest
    needs: plan
    permissions:
      id-token: write
      contents: read
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v6

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-ecr-push
          # IAM trust policy sub: repo:your-org/your-repo:ref:refs/heads/main
          # IAM permissions: ecr:GetAuthorizationToken, ecr:BatchCheckLayerAvailability,
          #   ecr:PutImage, ecr:InitiateLayerUpload, ecr:UploadLayerPart, ecr:CompleteLayerUpload
          role-session-name: GitHubActions-ECRPush-${{ github.run_id }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Log in to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Extract image metadata
        id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}
          tags: type=sha,prefix=,format=short

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

  # Job 3: Terraform apply + ECS deploy — production environment gate required
  deploy:
    name: Deploy to ECS
    runs-on: ubuntu-latest
    needs: [plan, build-and-push]
    environment: production           # triggers GitHub Environment protection rules
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-deploy-production
          # IAM trust policy sub: repo:your-org/your-repo:environment:production
          # Only issuable after GitHub Environment protection rules are satisfied
          # IAM permissions: ecs:UpdateService, ecs:DescribeServices,
          #   ecs:RegisterTaskDefinition, iam:PassRole (scoped to task role only)
          role-session-name: GitHubActions-Deploy-${{ github.run_id }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v4

      - name: Download plan artifact
        uses: actions/download-artifact@v7
        with:
          name: tfplan

      - name: Terraform Apply
        run: terraform apply -auto-approve tfplan

      - name: Download ECS task definition
        run: |
          aws ecs describe-task-definition \
            --task-definition ${{ env.ECS_SERVICE }} \
            --query taskDefinition \
            > task-definition.json

      - name: Update ECS task definition with new image
        id: task-def
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-definition.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ needs.build-and-push.outputs.image-tag }}

      - name: Deploy to ECS
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.task-def.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

### Azure — ACR + AKS Deployment

```yaml
# .github/workflows/deploy-azure.yml
name: Deploy to Azure

on:
  push:
    branches: [main]

env:
  AZURE_REGION: westeurope
  ACR_NAME: yourregistry               # without .azurecr.io suffix
  ACR_LOGIN_SERVER: yourregistry.azurecr.io
  IMAGE_REPOSITORY: your-app
  AKS_RESOURCE_GROUP: your-rg
  AKS_CLUSTER_NAME: your-aks-cluster
  K8S_NAMESPACE: production
  K8S_DEPLOYMENT: your-app

jobs:
  # Job 1: Terraform plan — read-only, no environment gate required
  plan:
    name: Terraform Plan
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # required for OIDC token request
      contents: read
    steps:
      - uses: actions/checkout@v6

      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID_PLAN }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          # Federated credential subject: repo:your-org/your-repo:ref:refs/heads/main
          # Role assignment: Reader on relevant resource groups only

      - uses: hashicorp/setup-terraform@v4
        with:
          backend_config: |
            resource_group_name  = "your-tfstate-rg"
            storage_account_name = "yourtfstatestore"
            container_name       = "tfstate"

      - name: Terraform Init
        run: terraform init

      - name: Terraform Plan
        run: terraform plan -out=tfplan

      - name: Upload plan artifact
        uses: actions/upload-artifact@v6
        with:
          name: tfplan
          path: tfplan
          retention-days: 1

  # Job 2: Build and push image to ACR — scoped to ACR push permissions only
  build-and-push:
    name: Build & Push to ACR
    runs-on: ubuntu-latest
    needs: plan
    permissions:
      id-token: write
      contents: read
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v6

      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID_ACR_PUSH }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          # Federated credential subject: repo:your-org/your-repo:ref:refs/heads/main
          # Role assignment: AcrPush on your ACR only — no broader permissions

      - name: Log in to Azure Container Registry
        run: az acr login --name ${{ env.ACR_NAME }}

      - name: Extract image metadata
        id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.ACR_LOGIN_SERVER }}/${{ env.IMAGE_REPOSITORY }}
          tags: type=sha,prefix=,format=short

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

  # Job 3: Terraform apply + AKS deploy — production environment gate required
  deploy:
    name: Deploy to AKS
    runs-on: ubuntu-latest
    needs: [plan, build-and-push]
    environment: production           # triggers GitHub Environment protection rules
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6

      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID_DEPLOY }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          # Federated credential subject: repo:your-org/your-repo:environment:production
          # Only issuable after GitHub Environment protection rules are satisfied
          # Role assignments: Contributor on your-rg, AcrPull on ACR (for kubelet identity),
          #   Azure Kubernetes Service Cluster User Role on AKS cluster

      - uses: hashicorp/setup-terraform@v4

      - name: Download plan artifact
        uses: actions/download-artifact@v7
        with:
          name: tfplan

      - name: Terraform Apply
        run: terraform apply -auto-approve tfplan

      - name: Get AKS credentials
        run: |
          az aks get-credentials \
            --resource-group ${{ env.AKS_RESOURCE_GROUP }} \
            --name ${{ env.AKS_CLUSTER_NAME }} \
            --overwrite-existing

      - name: Update image in AKS deployment
        run: |
          kubectl set image deployment/${{ env.K8S_DEPLOYMENT }} \
            ${{ env.K8S_DEPLOYMENT }}=${{ env.ACR_LOGIN_SERVER }}/${{ env.IMAGE_REPOSITORY }}:${{ needs.build-and-push.outputs.image-tag }} \
            --namespace ${{ env.K8S_NAMESPACE }}

      - name: Verify rollout
        run: |
          kubectl rollout status deployment/${{ env.K8S_DEPLOYMENT }} \
            --namespace ${{ env.K8S_NAMESPACE }} \
            --timeout=5m
```

The `environment: production` declaration on the deploy job is what connects OIDC trust to GitHub's approval gate. The trust policy on the production deployment role requires `environment:production` in the `sub` claim — which GitHub only includes if the job is actually running in that environment, which only happens after the environment's protection rules are satisfied. An unapproved deployment cannot produce the token needed to assume the role. The gate is enforced at the identity layer, not just at the workflow layer.

---

## 5. Reusable Workflow Federation

If your organisation centralises deployment logic in reusable workflows — a common pattern when you have multiple repositories all deploying to the same infrastructure — the trust policy needs to account for the fact that the executing workflow is not in the deploying repository.

GitHub's `job_workflow_ref` claim identifies the reusable workflow that's actually running. To trust a centralised deployment workflow without opening the role to every repository that calls it, customise the `sub` claim to include `job_workflow_ref` via the GitHub API, then scope the trust policy to that specific workflow file:

```bash
# Include job_workflow_ref in the sub claim for this repository
gh api --method PUT /repos/your-org/your-repo/actions/oidc/customization/sub \
  --field use_default=false \
  --field include_claim_keys='["repo","context","job_workflow_ref"]'
```

With this customisation, the `sub` claim includes the reusable workflow path. Your trust policy condition becomes:

```json
"StringLike": {
  "token.actions.githubusercontent.com:sub":
    "repo:your-org/*:job_workflow_ref:your-org/central-workflows/.github/workflows/deploy.yml@refs/heads/main*"
}
```

This lets any repository in your organisation use the centralised deployment workflow to assume the role — but only via that specific workflow file, not via any arbitrary workflow they write. The centralised workflow is the trust boundary, not the calling repository.

---

## 6. The Migration Path from Static Secrets

If your workflows currently use static credentials stored in GitHub secrets, the migration path is low-risk when sequenced correctly. The key is validating OIDC before removing the static credentials, not after.

```yaml
# Step 1: Add OIDC authentication alongside existing static credentials
# Both methods are present — OIDC is tested, static credentials remain as fallback
- name: Configure AWS (OIDC — testing)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789:role/github-actions-deploy
    aws-region: eu-west-1
  # If this fails, the workflow fails here — static credentials below never run
  # Comment this out and uncomment below to fall back during migration

# - name: Configure AWS (static — fallback during migration)
#   uses: aws-actions/configure-aws-credentials@v4
#   with:
#     aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
#     aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
#     aws-region: eu-west-1
```

Migration sequence per repository:

1. Create the IAM role / Azure federated credential with the correct trust policy
2. Add `id-token: write` permission to the workflow job
3. Add the OIDC `configure-aws-credentials` step — leave static credential step commented out but present
4. Run the workflow on a branch; verify it succeeds end-to-end using OIDC credentials
5. Once confirmed working on main, remove the commented static credential step
6. Delete the static credentials from the cloud provider (IAM user access key, Azure client secret)
7. Remove the corresponding GitHub secret from the repository

Step 6 is the step most teams defer indefinitely — they remove the GitHub secret but leave the IAM user or service principal active. The credential is no longer usable from GitHub, but it still exists and could be used by anyone with direct knowledge of the key. Delete it from the cloud provider.

A useful pre-migration audit to understand your scope:

```bash
# Find all workflows that reference static cloud credentials
grep -r "AWS_ACCESS_KEY_ID\|AWS_SECRET_ACCESS_KEY\|AZURE_CLIENT_SECRET" .github/workflows/
```

---

## 7. The Audit Trail OIDC Gives You

This is the capability that static credentials structurally cannot replicate, and it's undersold in most OIDC guides.

Every OIDC credential issuance produces a CloudTrail event with the full GitHub context baked into the session name. When you look at a CloudTrail event for an action taken with OIDC credentials, you see not just which role was used — you see exactly which repository, which branch, which workflow run, and which commit triggered it. The `userIdentity.arn` on every subsequent API call made with those credentials includes the role session name, which encodes the GitHub run ID. The `webIdFederationData.federatedIdentity` in the `AssumeRoleWithWebIdentity` event shows the full `sub` claim — `repo:your-org/your-repo:environment:production`.

The CloudTrail query to answer "which workflow runs deployed to production in the last 30 days":

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --start-time $(date -d '30 days ago' --iso-8601=seconds) \
  --query 'Events[?contains(CloudTrailEvent, `github-actions-deploy-production`)].{Time:EventTime,Role:Username}' \
  --output table
```

With static access keys, the equivalent query returns the IAM user name — shared across all workflows that used it, with no way to distinguish which workflow, which run, or which commit triggered each API call.

---

## 8. Common Failure Modes and How to Debug Them

**`Error: Credentials could not be loaded`**

Almost always means `id-token: write` permission is missing from the job's permissions block. Check that your workflow has:

```yaml
jobs:
  deploy:
    permissions:
      id-token: write   # Required — without this, GitHub will not issue an OIDC token
      contents: read
```

Note: if you set `permissions` at the workflow level but not the job level, the job inherits workflow-level permissions. But if you set `permissions` at the job level, the job only has what's explicitly listed. The safest practice: set permissions explicitly per job, not at the workflow level.

**`Error: Not authorized to perform sts:AssumeRoleWithWebIdentity`**

The JWT was issued successfully but the trust policy rejected it. The `sub` claim in the token doesn't match the condition in your trust policy. Add a debug step before the credential configuration to see the actual claims:

```yaml
- name: Debug OIDC token claims
  run: |
    TOKEN=$(curl -sH "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value')
    echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq .
  # Run this in a private repository — the claims themselves are not sensitive,
  # but seeing them publicly confirms your repository and branch structure
```

Compare the `sub` value in the output to your trust policy condition. The mismatch will be obvious.

**`Error: OIDC token request failed` or blank response**

The OIDC token endpoint is unreachable or the token request URL is malformed. Check that `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and `ACTIONS_ID_TOKEN_REQUEST_URL` environment variables are set — they are only injected when `id-token: write` is present. Also check if your runner has outbound HTTPS access to `token.actions.githubusercontent.com` — relevant if you are using self-hosted runners with network restrictions.

**Token expired before use**

The OIDC JWT is valid for five minutes from issue time. Always put `configure-aws-credentials` or `azure/login` as the first step in the job — before `actions/checkout`, before `npm ci`, before anything that could take time. The temporary credentials returned after the exchange are cached for the role's session duration (15 minutes to one hour) and are not time-sensitive once issued; only the initial JWT exchange races the five-minute clock.

---

## Production Checklist

Before retiring static credentials in favour of OIDC:

- [ ] **OIDC identity provider created in AWS** — once per account; thumbprint confirmed
- [ ] **Entra ID app registration and federated credentials created in Azure** — one per environment/scope combination
- [ ] **Trust policies use environment-scoped `sub` for production roles** — not branch-only; coupled to GitHub Environment protection rules
- [ ] **Trust policies use branch-scoped `sub` for staging roles** — `ref:refs/heads/main`, not wildcard
- [ ] **Trust policies never use org-wildcard `sub`** — no `repo:your-org/*` on any role with meaningful permissions
- [ ] **One IAM role per deployment responsibility** — plan role, ECR push role, deploy role are separate with separate permission scopes
- [ ] **`id-token: write` set per-job** — not at workflow level; each job declares only what it needs
- [ ] **`configure-aws-credentials` / `azure/login` runs first** — before any long-running steps; token expires in 5 minutes
- [ ] **Immutable subject claims opted in** — for repositories on or after July 15, 2026; for older repositories, opt in via repository settings
- [ ] **Migration verified end-to-end on a branch** before removing static credentials
- [ ] **Static credentials deleted from cloud provider** — not just removed from GitHub secrets; the IAM user / service principal is gone
- [ ] **CloudTrail / Azure Monitor queried** to confirm OIDC sessions appear with correct session names and GitHub context
- [ ] **Debug step removed** after trust policy is confirmed working — token claims are not sensitive but are unnecessary output in production runs
