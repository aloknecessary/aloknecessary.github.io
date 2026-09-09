---
title: "Migrating Ubuntu 24.04 from Azure to AWS: The linux-azure Kernel Trap"
date: 2026-09-07
last_modified_at: 2026-09-07T12:23:09+05:30
author: Alok Ranjan Daftuar
description: "When migrating Ubuntu servers from Azure to AWS via MGN, the linux-azure kernel ships without AWS's ena network driver — causing instances to launch healthy but unreachable. Here's the diagnosis and fix."
excerpt: "The source server replicated cleanly, the test launch looked fine, and the instance still came up with no network connectivity. The cause was three layers down, in the kernel package itself."
keywords: "aws mgn, ubuntu migration, linux-azure kernel, ena driver, azure to aws, kernel swap, linux-generic, linux-aws"
twitter_card: "summary_large_image"
categories:
  - cloud
  - migration
tags: [aws-mgn, ubuntu, kernel, ena-driver, azure-to-aws, linux-azure, linux-generic, cloud-init, walinuxagent, nitro]
series: "AWS Migration Playbook"
series_order: 2
---

> This article is what happens when MGN's post-launch conversion step fails, why it fails specifically for Ubuntu servers that started life on Azure, and the fix — one that's a single package swap once you know what's actually wrong, and a genuinely confusing debugging session if you don't. I described in the [previous article in this series](/blogs/aws-mgn-architecture-continuous-replication/) how that conversion process works under normal conditions.

## The symptom

A test launch from MGN came up as a running EC2 instance, passed status checks in the console, and had no network connectivity at all. No SSH, no ping, nothing — the instance existed, was marked healthy by EC2's own instance status checks, and was completely unreachable. This is a specific and slightly deceptive failure mode: EC2 status checks verify the instance is running and the hypervisor can reach it at a basic level, not that the guest OS has a working network stack, so "instance healthy" and "instance reachable" are not the same claim, and the console gives you no reason to suspect the gap between them.

## Why this happens specifically for Azure-sourced Ubuntu servers

Ubuntu's official images for Azure ship a kernel package called `linux-azure` — not the generic `linux-generic` (or `linux-virtual`, depending on the flavor) kernel used on bare metal or most other hypervisors. `linux-azure` is a real, deliberate Canonical package: it's tuned and patched specifically for the Hyper-V environment Azure runs on, with Hyper-V-specific drivers built in and, critically, **without** AWS's own network driver — `ena` (Elastic Network Adapter) — built in or even present as an available module.

This is the root cause, stated plainly: a server that's been running on Azure has a kernel that was never built with AWS's network hardware in mind, because it never needed to be. MGN replicates the disk exactly as it is — including that kernel — and launches an instance from it. The Nitro hypervisor presents network hardware to the guest OS that expects the `ena` driver to be available. If the running kernel has no `ena` module at all, or has it available but not correctly referenced in the boot configuration, the instance comes up with no functioning network interface.

## Confirming this is actually the cause before you touch anything

Before assuming this is the issue, it's worth actually confirming it rather than jumping straight to the fix — the same "instance running, no network" symptom can have other causes (security group misconfiguration, subnet routing, or a DHCP issue), and treating the kernel as the cause when it isn't wastes a maintenance window.

Since you can't SSH into an instance with no network, confirmation has to happen through the **EC2 Serial Console** (a prerequisite for this diagnosis, and the same tool the next article in this series covers in more depth for a related but distinct recovery scenario). From the serial console, check the running kernel and installed packages:

```bash
uname -r
# 6.8.0-1015-azure    <- the tell: "-azure" suffix on an AWS instance

dpkg -l | grep linux-image
# linux-image-6.8.0-1015-azure   installed
# (no linux-image-generic or linux-image-aws present)

lsmod | grep ena
# (no output — module not loaded, and likely not present at all)
```

The `-azure` suffix on `uname -r` while running as an EC2 instance is close to a definitive signal on its own. The absent `ena` entry in `lsmod` confirms the specific mechanism — no driver loaded means no functioning network interface for Nitro's presented hardware, regardless of what security groups or subnet routing say.

## The fix: swapping the kernel package

The fix is switching from the Azure-specific kernel to Ubuntu's generic kernel, which does include `ena` support (Ubuntu's generic kernel has broad hardware driver coverage across common hypervisors and hardware, AWS's included, precisely because it isn't tuned to one platform). This has to happen **before** cutover — ideally on the source server, or at minimum on a test-launched instance you're using to validate the migration, never for the first time during the actual cutover window.

On the source server (or a test-launched target instance reachable via serial console):

```bash
# Install the generic kernel and its headers
sudo apt update
sudo apt install -y linux-generic linux-headers-generic

# Confirm it's installed alongside the current kernel
dpkg -l | grep linux-image
```

Installing `linux-generic` doesn't remove the current `-azure` kernel automatically — both are present after this step, and GRUB needs to be told which one to boot by default:

```bash
# Check current GRUB default
grep GRUB_DEFAULT /etc/default/grub

# Update GRUB to boot the newest generic kernel by default
sudo sed -i 's/GRUB_DEFAULT=.*/GRUB_DEFAULT="Advanced options for Ubuntu>Ubuntu, with Linux <generic kernel version>"/' /etc/default/grub
sudo update-grub
```

In practice, rather than hand-editing GRUB's default entry string (which is version-specific and easy to get wrong), the more reliable approach is setting `GRUB_DEFAULT=0` combined with confirming the generic kernel is the top entry in the GRUB menu — `update-grub` regenerates the menu ordering based on installed kernel versions, and the newest installed kernel is typically ordered first unless something else in the GRUB config overrides it.

Once GRUB is updated, remove the Azure-specific kernel package to avoid any ambiguity on next boot — but only after confirming the generic kernel boots successfully first, not before:

```bash
# Only after confirming successful boot on linux-generic:
sudo apt remove --purge linux-azure linux-image-*-azure linux-headers-*-azure
sudo update-grub
```

Removing the old kernel before confirming the new one boots is how a routine kernel swap turns into the boot-loop scenario the next article covers — if `linux-generic` has its own problem and you've already purged the only other bootable kernel, there's no fallback entry in the GRUB menu at all.

## Doing this before replication, not after

The cleanest sequencing is doing this kernel swap **on the source Azure VM, before MGN replication even begins**, if that's operationally feasible. This means the replicated disk MGN copies to AWS already has the correct kernel, and the target instance's post-launch conversion has nothing unusual to reconcile — no different from launching from any other correctly-configured Ubuntu disk.

If the source server can't be touched pre-migration — a common constraint when the source is a production system you can't risk destabilizing before the migration window — the alternative is performing this swap on the **test-launched** target instance in AWS, validating it boots and has network connectivity, and then repeating the same steps against the real cutover instance immediately after cutover, before it's exposed to production traffic. This is slower and adds a manual step to every cutover, but it keeps the source server completely untouched until the migration is actually committed.

## Baking the fix into a repeatable pre-flight check

For a migration wave with more than a handful of servers, doing this kernel check manually per server doesn't scale, and it's exactly the kind of thing worth scripting into a pre-migration audit run against every source server before it enters the MGN replication queue:

```bash
#!/bin/bash
# pre-migration-kernel-check.sh
KERNEL=$(uname -r)
if [[ "$KERNEL" == *azure* ]]; then
  echo "WARNING: $(hostname) is running $KERNEL — Azure-specific kernel detected."
  echo "This server needs linux-generic installed and GRUB updated before MGN cutover."
  exit 1
else
  echo "OK: $(hostname) running $KERNEL — no Azure-specific kernel detected."
  exit 0
fi
```

Running this across every source server as part of wave planning — before agent installation, not after — turns this from a per-incident debugging exercise into a one-line check on a pre-flight list, and it's cheap enough to run against every server regardless of how confident you are that a given one needs it.

## A second layer under the first: network interface naming

Fixing the missing `ena` module is sometimes only half the problem. Even after the correct driver loads, the network interface name the OS expects can be wrong, because Azure and AWS use different predictable network interface naming schemes, and `netplan` or `/etc/network/interfaces` configuration on the source server was written against Azure's naming (`eth0`, or a `systemd`-predictable name derived from Azure's virtual hardware path). After the kernel swap, the `ena`-backed interface can come up under a different name than the network configuration file expects, which produces a different but related symptom: the driver is correctly loaded, `ip link` shows the interface, but the OS never brings it up with an address, because the configuration is still looking for the old interface name.

Confirming this from the serial console, once the `ena` module itself is loaded:

```bash
ip link show
# Shows the actual interface name present, e.g. enX0 or eth0

cat /etc/netplan/*.yaml
# Check whether the configured interface name matches what ip link actually shows
```

If they don't match, the netplan configuration needs updating to match the actual interface name, or — the more robust fix for anything you expect to migrate again in the future — set the interface matching rule in netplan to match by driver rather than by hardcoded name:

```yaml
network:
  version: 2
  ethernets:
    ena-primary:
      match:
        driver: ena
      dhcp4: true
```

Matching by driver rather than interface name means this configuration survives a future re-platforming without needing another manual edit — worth doing as part of this fix rather than just hardcoding whatever name happens to be current.

## Other Azure-specific dependencies worth auditing while you're in there

The kernel package is the most consequential Azure-specific dependency, but it's rarely the only one on a server that's spent its life on Azure. Worth checking for, and removing or disabling before cutover, in the same pass as the kernel fix:

- **`walinuxagent` (the Azure Linux Agent)** — handles Azure-specific provisioning, metadata service calls, and extension handling. It's not just unnecessary on AWS, it actively wastes cycles retrying calls to an Azure metadata endpoint (`169.254.169.254` — the same link-local address AWS's own instance metadata service uses, which is a genuine collision worth being aware of) that doesn't exist in the AWS environment, and can interfere with `cloud-init` or AWS's own tooling trying to use that same address for legitimate instance metadata calls.
- **Azure-specific `udev` rules**, occasionally left behind by the Azure agent or extensions, that reference Azure-specific device paths and can produce boot-time warnings (usually harmless, but worth clearing for a clean migration rather than leaving stale rules referencing hardware that no longer exists).
- **`cloud-init` datasource configuration** — if explicitly pinned to `Azure` rather than left on `auto` detection, `cloud-init` will fail to find the Azure datasource on AWS and either hang during boot waiting for it or fail provisioning steps that depend on it. This is worth checking in `/etc/cloud/cloud.cfg.d/` before cutover — it's a separate, unrelated cause of a slow or stuck boot from the kernel/driver issue, but produces a similarly confusing "why won't this boot properly" experience if it's not caught in the same audit pass.

## Don't stop at linux-generic — move to linux-aws once the instance is live

`linux-generic` is the right kernel to get an instance booting and networked during the migration itself — it's broad, safe, and gets you unstuck without needing to know anything AWS-specific yet. But it's not where you want to leave a production instance long-term. Ubuntu also publishes `linux-aws`, a kernel package built and tuned specifically for AWS's Nitro platform, the same way `linux-azure` was tuned for Hyper-V. Staying on `linux-generic` after cutover means running a kernel that works everywhere but is optimized for nowhere in particular, and — just as importantly — it means missing the update cadence and platform-specific patches (Nitro driver improvements, AWS-specific security fixes) that ship through the `linux-aws` package track, on its own schedule, separate from the generic kernel's.

This is a step worth doing deliberately, either as part of the post-launch setup automation (a script or `cloud-init` step that runs once the instance is confirmed stable on AWS) or manually before the instance goes into real production use — not something to leave for "later," since "later" is exactly how instances end up running years-old generic kernels missing security updates a platform-specific track would have delivered on time:

```bash
sudo apt update
sudo apt install -y linux-aws linux-headers-aws
sudo update-grub
```

Same discipline applies here as with the original swap: confirm the instance boots and networks correctly on `linux-aws` — ideally by rebooting it in a controlled maintenance window rather than assuming it'll be fine — before removing `linux-generic`, so there's always a known-working fallback kernel available in the GRUB menu until the new one is actually proven.

## Validating the fix through MGN's test launch, not the real cutover

Whichever approach you take — fixing the source pre-replication, or fixing a test-launched target — the validation step is the same, and it's worth being disciplined about it: launch a **test instance** through MGN (not a cutover instance, which ends replication), boot it, reach it over SSH through its actual network path rather than only the serial console, and confirm `ena` is loaded and the interface is correctly configured end to end. Only after that succeeds cleanly should the same fix be considered validated for the real cutover. A fix confirmed only via serial console access isn't fully confirmed — serial console gives you a way into the instance regardless of whether the network stack works at all, so it can mask a still-broken `ena`/interface configuration that would fail the moment something actually depends on real network reachability, like a load balancer health check or an application dependency.

## What actually made this hard to diagnose the first time

The reason this took longer to root-cause than it should have wasn't the fix — the fix, once you know the cause, is a five-minute package swap. It was that every layer of the stack reported success right up until the network layer: the MGN replication completed and reported healthy, the test launch succeeded and the instance reached "running" state, EC2 status checks passed. Nothing in the migration tooling itself flags "this kernel is missing the target platform's network driver," because MGN's job is faithful replication, not validation of the source OS's suitability for the target hypervisor — that's a gap between what the tool guarantees and what a successful migration actually requires, and it's on the person running the migration to close it.

> 📌 **Key Takeaway**: An Azure-sourced Ubuntu kernel (`linux-azure`) doesn't include AWS's `ena` network driver, so a server migrated via MGN without a kernel swap can launch as a healthy-looking EC2 instance with no actual network connectivity. Fix it by installing `linux-generic`, confirming it boots successfully, and only then removing the old kernel — ideally on the source server before replication even starts, and always validated through a test launch before it's ever the real cutover. Treat `linux-generic` as the safe landing spot to get unblocked, not the final state — move to the AWS-tuned `linux-aws` kernel once the instance is stable, so it gets platform-specific updates on schedule going forward.
