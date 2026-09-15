---
layout: blog
title: "The MCP Stateless Revolution"
date: 2026-08-31
last_modified_at: 2026-08-31T11:51:44+05:30
author: Alok Ranjan Daftuar
description: "The 2026-07-28 MCP specification removed protocol-level sessions entirely — and with it, the sticky routing, shared session stores, and affinity cookies that teams had been forced to build around a stateful transport that was never supposed to be permanent."
excerpt: "For two years, running an MCP server meant sticky routing and shared session stores just to keep a conversation coherent. The 2026-07-28 specification deleted the session entirely — and with it, an entire category of infrastructure workaround."
keywords: "mcp, model context protocol, stateless, streamable http, kubernetes, load balancing, aws alb, azure application gateway, agentic infrastructure, session affinity"
twitter_card: "summary_large_image"
categories:
  - ai-engineering
  - cloud
tags: [mcp, kubernetes, aws, azure, load-balancing, networking, platform-engineering, agents, distributed-systems, cloud-native]
series: "Agentic Infrastructure"
series_order: 2
---

> The infrastructure that was never supposed to be permanent

[Why Agent Infrastructure Is Its Own Discipline]({{ '/blogs/why-agent-infrastructure-is-its-own-discipline/' | relative_url }}) made the case that agent workloads break assumptions baked into a decade of microservice tooling — liveness, autoscaling signal, session handling, isolation, timeout budgets. Of those five, session handling has been the most expensive to get wrong, because for two years the protocol itself forced a stateful design onto infrastructure that wanted to be stateless.

Every exchange between an MCP client and server opened with an `initialize` handshake. Over HTTP, that handshake returned an `Mcp-Session-Id` header, and every subsequent request in that conversation had to carry the same ID back to the same server instance. That single requirement — a session pinned to one instance — is what forced sticky routing, shared session stores, and all the operational overhead that came with them onto teams who otherwise had no reason to build stateful infrastructure at all.

On July 28, 2026, the MCP specification removed the session entirely. This is the largest revision since the protocol launched, and it changes how you should be routing, scaling, and load-balancing MCP traffic today — not eventually, and not as an optimization, but as a direct consequence of what the transport now requires and no longer requires.

## What the old transport actually forced on you

It's worth being precise about what "sticky routing" meant in practice, because the fix only makes sense once the cost of the old design is concrete. A session ID pinned a client to whichever server instance answered the `initialize` call first. Keeping that session alive meant one of three things, and in most production deployments, some combination of all three: sticky sessions at the load balancer (routing every request from a given client to the same backend pod), a shared session store like Redis so any instance *could* theoretically serve any request if it looked up state first, or a client-side retry strategy that tolerated session loss and re-initialized when a pod restarted mid-conversation.

Each of those solutions works, but each one adds a moving part that has nothing to do with what the MCP server is actually supposed to do — expose tools and resources to a client. And each one fails in a specific, familiar way during the one event Kubernetes is designed to handle gracefully: a rolling deployment. A pod gets terminated as part of a routine rollout, its in-memory session state goes with it, and every client pinned to that pod by a stickiness cookie either gets a connection reset mid-conversation or silently starts talking to a session that no longer exists on the new pod it's routed to. Teams running MCP servers at any real scale over the last two years have generally hit this at least once — a deployment that should have been a non-event turns into a burst of client-side errors, traced eventually back to session affinity rather than anything wrong with the new code being deployed.

A Kubernetes Service fronting a sticky-session deployment looked like this:

```yaml
# Pre-2026-07-28: sticky routing required to preserve session affinity
apiVersion: v1
kind: Service
metadata:
  name: mcp-server
  annotations:
    # AWS: ALB target group stickiness
    alb.ingress.kubernetes.io/target-group-attributes: |
      stickiness.enabled=true,
      stickiness.type=lb_cookie,
      stickiness.lb_cookie.duration_seconds=3600
spec:
  selector:
    app: mcp-server
  ports:
    - port: 443
      targetPort: 8443
```

On Azure, the equivalent Application Gateway configuration required cookie-based affinity on the backend HTTP settings, plus a session-store dependency the moment any single pod restarted mid-conversation and the sticky cookie pointed at a target group member that no longer existed. Neither cloud's affinity mechanism is wrong — they do exactly what they're designed to do — the problem was that MCP's protocol design required this class of infrastructure at all, for a workload where nothing about the actual request/response pattern needed it.

## What SEP-2567 actually removes

The core change, tracked as SEP-2567, removes protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport entirely — not deprecates, removes. The `initialize`/`notifications/initialized` handshake goes with it. Every request is now self-describing: protocol version, client identity, and the capabilities a request needs travel in `_meta` on that request, rather than being negotiated once and remembered by a pinned server instance.

This does not mean MCP servers can no longer carry state across calls — it means the protocol stopped carrying that state for you. If a server genuinely needs to remember something between one tool call and the next — a shopping basket, a browser context, a partially completed multi-step task — it mints an explicit handle (a `basket_id`, a `session_token`) and returns it from the first call. The client passes that handle back as an ordinary argument on the next call, the same way any REST API has always handled state that outlives a single request. The difference is entirely about *where* that responsibility sits: previously the transport carried it invisibly; now the application carries it explicitly, as data, which means any instance can service the request as long as it can resolve the handle — typically by looking it up in a datastore the server already needed, rather than by being the one specific pod that happens to hold it in memory.

That's the part worth sitting with, because it's a smaller change to your server code than it sounds like and a much larger change to your infrastructure. The server-side logic for "remember the basket across two calls" barely changes — you're still storing basket state somewhere. What disappears is the requirement that the *same pod* be the one to look it up.

## The second half of the change: routing without reading the body

A stateless core solves scaling, but it creates a new problem: if any instance can serve any request, how does a gateway or load balancer make intelligent routing decisions — rate limiting a specific tool, routing long-running calls to a different backend pool — without parsing every JSON-RPC body to find out what's inside? The specification answers this with SEP-2243: Streamable HTTP requests must now carry `Mcp-Method` and `Mcp-Name` headers, and servers are required to reject any request where the headers and body disagree. A load balancer, API gateway, or WAF can now route, throttle, and meter MCP traffic the same way it would any ordinary HTTP API — on headers — without ever needing to be MCP-aware at the body level.

This is the piece that actually makes the infrastructure change practical rather than theoretical. Removing session affinity only helps if your routing layer can still make sensible decisions about where a request goes, and header-based routing is what lets it do that on ordinary Layer 7 rules instead of custom MCP-parsing logic.

## What disappears from the transport, not just the header

Two more removals in this revision matter specifically for how you probe and scale MCP servers, even though neither gets the same attention as the session change. The legacy `GET` stream endpoint is gone, along with `Last-Event-ID`-based stream resumability — the older transport allowed a client to reconnect an SSE stream and resume where it left off using an event ID, which meant a server had to track stream position per connection. That tracking is exactly the kind of per-connection state that made horizontal scaling awkward, and removing it is consistent with the rest of this revision: a dropped connection under Streamable HTTP is now just a dropped request, retried as a new, independent one, rather than a stream the server is expected to remember and resume.

That has a direct, practical consequence for the liveness and readiness probes discussed in the first article of this series: a probe no longer has to account for the possibility that killing a pod mid-stream destroys resumable state a client is depending on. Under the old transport, an aggressive restart during a long SSE stream could strand a client with no way to resume except starting over from `initialize` — one more reason sticky routing felt necessary, since losing the pod meant losing the stream. Under the stateless transport, a restarted pod costs a client one retried request, not an unrecoverable stream, which makes probe tuning a genuinely lower-stakes decision than it was a year ago.

## What self-describing requests mean for who's calling

Removing the session also removes the one place authentication used to get established once and then implicitly trusted for the rest of the conversation. Every request now carries its own client identity in `_meta`, which means authorization has to be evaluated per request rather than once at session start. That's a heavier lift on paper — no more "authenticate at `initialize`, trust for the next hour" — but it closes a real gap the old design had: a session hijacked or replayed mid-conversation used to carry whatever trust was established at handshake time for as long as the session lived. Per-request evaluation means a revoked credential takes effect on the very next call instead of only once the session naturally expires or is forcibly torn down. The infrastructure implication is concrete: your gateway or sidecar now needs to perform an identity check on every request rather than once per conversation, which shifts auth latency from an amortized, once-per-session cost to a per-call one — worth budgeting for explicitly when sizing the gateway layer, since it's real added work on every single request rather than a rounding error paid once at the start.

## Before and after, on both clouds

The practical payoff is that ingress configuration gets simpler, not just different. On AWS, an ALB target group for a 2026-07-28-compliant MCP server drops the stickiness block entirely and can add header-based routing rules using the new required headers:

```yaml
# AWS: ALB Ingress, post-2026-07-28 — no stickiness, header-based routing
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mcp-server
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/conditions.mcp-tasks: |
      [{"field":"http-header","httpHeaderConfig":{"httpHeaderName":"Mcp-Method","values":["tasks/*"]}}]
    alb.ingress.kubernetes.io/actions.mcp-tasks: |
      {"type":"forward","forwardConfig":{"targetGroups":[{"serviceName":"mcp-tasks-pool","servicePort":8443}]}}
spec:
  rules:
    - http:
        paths:
          - path: /mcp
            pathType: Prefix
            backend:
              service:
                name: mcp-server
                port:
                  number: 8443
```

That `mcp-tasks` action is a direct use of the new header routing: any request whose `Mcp-Method` matches the Tasks extension's methods gets forwarded to a separate pool sized and probed differently from the pool handling ordinary tool calls — without the ALB ever inspecting the JSON-RPC body to know that.

On Azure, Application Gateway's path-based and header-based routing rules do the same job without a stickiness-cookie dependency:

```yaml
# Azure: Application Gateway backend routing, post-2026-07-28
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mcp-server
  annotations:
    kubernetes.io/ingress.class: azure/application-gateway
    appgw.ingress.kubernetes.io/backend-protocol: https
    appgw.ingress.kubernetes.io/health-probe-path: /health
spec:
  rules:
    - http:
        paths:
          - path: /mcp
            pathType: Prefix
            backend:
              service:
                name: mcp-server
                port:
                  number: 8443
```

Application Gateway's routing rules can be extended with custom HTTP header conditions the same way, splitting `Mcp-Method: tasks/*` traffic to a differently-scaled backend pool — the underlying pattern is identical across both clouds, which is the point: statelessness plus header-based routing means the ingress layer configuration converges toward ordinary HTTP API practice regardless of which cloud is hosting it, rather than diverging into cloud-specific session-handling workarounds.

## Two smaller changes worth knowing about

Two more SEPs in this release affect infrastructure decisions even though neither is the headline. `ttlMs` and `cacheScope` (SEP-2549) now ride on `tools/list`, `resources/list`, and `prompts/list` responses, giving clients an explicit, HTTP-Cache-Control-like signal for how long a list is fresh and whether it's safe to cache across users — which matters directly for anyone fronting an MCP server with a CDN or edge cache, since it removes the guesswork around whether a cached list response is safe to serve to a different tenant. And W3C Trace Context propagation (SEP-414) is now a documented part of `_meta` — `traceparent`, `tracestate`, and `baggage` field names are locked down, which means distributed tracing across an MCP call chain no longer depends on a vendor-specific convention layered on top of the protocol.

## What this means for the migration window

None of this needs to happen as a single cutover. The specification's deprecation policy gives a twelve-month compatibility runway for the features it's phasing out — the legacy HTTP+SSE transport is reclassified as deprecated rather than removed, and Roots, Sampling, and Logging stay usable under the same window. What *is* removed outright, with no grace period, is the session header and the `initialize` handshake themselves — a client or server built against the old transport simply won't interoperate with one built against the new transport on that specific mechanism, which means the realistic migration path is running both transport paths side by side behind the same ingress until every client you support has moved.

That's an infrastructure decision as much as a protocol one: it means the sticky-routing configuration shown earlier doesn't disappear the day you upgrade — it stays live, serving the old path, while new traffic is routed to a stateless backend pool through the header-based rules above. Planning that dual-path routing deliberately, rather than discovering it's needed mid-migration, is the difference between a clean cutover and an outage caused by an older client hitting a pod that no longer remembers its session.

> 📌 **Key Takeaway:** The 2026-07-28 specification didn't just make MCP servers easier to scale — it removed the protocol-level justification for an entire category of infrastructure (sticky routing, shared session stores, affinity cookies) that many teams had already come to treat as an unavoidable cost of running MCP at all. If your ingress configuration still carries session-affinity logic, that's now a design choice to revisit, not a protocol requirement to work around.
