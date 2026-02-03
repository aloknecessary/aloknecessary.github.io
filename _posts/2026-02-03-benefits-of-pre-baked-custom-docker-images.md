---
layout: post
title: "How pre-baked Docker images can significantly reduce CI setup time and improve reliability."
description: "Speeding Up CI Pipelines with a Custom Playwright + Azure CLI Docker Image"
tags: [docker, ci-cd, playwright, github-actions, devops, automation, azure, docker-buildx, multi-architecture, software-architecture, developer-productivity]
---

## Modern CI/CD pipelines are powerful, but they are often **wasteful by default**.

If you look closely at most automation workflows, a large chunk of execution time is spent not on *actual testing*, but on repeatedly installing the same tools:
- Node.js
- Playwright dependencies
- Browser binaries
- Cloud CLIs (Azure, AWS, GCP, etc.)

<!--more-->

This setup cost is paid **on every run**, even though the tooling rarely changes.

In this post, I’ll walk through a simple but high-impact optimization:
> **Using a custom Docker image to eliminate repetitive setup work in CI pipelines.**

I’ll use my [**Playwright + Azure CLI Docker image**](https://hub.docker.com/r/aloknecessary/playwright-az-cli) as a concrete example to show how this approach improves speed, reliability, and maintainability.
[aloknecessary/playwright-az-cli](https://hub.docker.com/r/aloknecessary/playwright-az-cli)

---

## The Problem with Traditional CI Pipelines

A typical Playwright pipeline looks like this:

1. Start a fresh runner
2. Install Node.js
3. Install Playwright
4. Download browser binaries
5. Install Azure CLI
6. Install project dependencies
7. Run tests

Steps **2–5** are:
- Time-consuming
- Repeated across pipelines
- Almost identical between projects

Even with caching, these steps:
- Add variability
- Break unexpectedly
- Increase cognitive load in workflow YAML files

---

## The Idea: Pre-Bake the Toolchain

Instead of installing tooling during every run, we can **pre-bake it into a Docker image**.

The image becomes:
- A **portable execution environment**
- A **single source of truth** for tooling versions
- A **drop-in replacement** for standard runners

This shifts work from **runtime → build time**.

---

## What I Built

I created a custom Docker image based on the **official Microsoft Playwright image**, with **Azure CLI added** on top.

### What’s Inside the Image

- Microsoft Playwright
  - Chromium, Firefox, WebKit
  - All required OS dependencies
- Node.js & npm (Playwright-compatible)
- Azure CLI
- Multi-architecture support:
  - `linux/amd64`
  - `linux/arm64`

The result is a **ready-to-run automation container**.

---

## Why This Works So Well

### 1. Faster Pipeline Execution

Pipelines no longer:
- Install Playwright
- Download browsers
- Install Azure CLI

They move directly to:
- `npm ci`
- `playwright test`

This alone saves **several minutes per run**, which compounds quickly across teams and workflows.

---

### 2. Deterministic & Reproducible Runs

When tooling is baked into the image:
- Every run uses the same versions
- No surprises due to upstream changes
- Fewer “works on my machine” failures

Your pipeline environment becomes **immutable and predictable**.

---

### 3. Cleaner Workflow Definitions

Compare these two approaches:

**Before**
- Long YAML files
- Tool installation logic
- OS-specific commands

**After**
- Short, readable workflows
- Focus on business logic
- Less maintenance overhead

---

### 4. Multi-Architecture Support Out of the Box

By building the image as a **multi-platform manifest**, the same tag works for:
- GitHub-hosted runners
- ARM-based self-hosted runners
- Apple Silicon developers

Docker automatically pulls the correct architecture.

---

## Example: Consuming the Image in GitHub Actions

```yaml
jobs:
  e2e-tests:
    runs-on: ubuntu-latest

    container:
      image: aloknecessary/playwright-az-cli:latest
      options: --ipc=host --user root

    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npx playwright test
```