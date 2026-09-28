---
title: "Migrating Ubuntu 24.04 from Azure to AWS: The linux-azure Kernel Trap"
published: false
description: When migrating Ubuntu servers from Azure to AWS via MGN, the linux-azure kernel ships without AWS's ena network driver — causing instances to launch healthy but completely unreachable.
tags: aws, ubuntu, devops, migration
canonical_url: https://aloknecessary.in/blogs/aws-migration-ubuntu-kernel-fix/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-migration-ubuntu-kernel-fix
cover_image:
---

You replicate a Ubuntu 24.04 server from Azure to AWS using MGN. The replication completes cleanly. The test launch succeeds. EC2 status checks pass. And then you try to SSH in and get nothing — no response, no timeout, just silence.

This is a specific failure mode that only affects Ubuntu servers that started life on Azure, and it's deceptive precisely because every layer of the migration tooling reports success. The problem is three layers down, in the kernel package itself.

---

## Why Azure Ubuntu Images Are Different

Ubuntu's official Azure images ship with `linux-azure` — a kernel package built and tuned specifically for Hyper-V. It includes Hyper-V-specific drivers and, critically, does **not** include AWS's `ena` (Elastic Network Adapter) driver.

MGN replicates the disk exactly as it is, including that kernel. When the Nitro hypervisor presents network hardware to the guest OS, the running kernel has no `ena` module to handle it. The instance comes up with no functioning network interface — not because of security groups or routing, but because the OS literally cannot talk to the hardware AWS gave it.

EC2 status checks pass because they verify the hypervisor can reach the instance at a basic level, not that the guest OS has a working network stack. "Instance healthy" and "instance reachable" are not the same claim.

---

## Confirming the Cause via EC2 Serial Console

Since SSH is unavailable, diagnosis happens through the EC2 Serial Console. Three commands confirm the root cause:

```bash
uname -r
# 6.8.0-1015-azure    <- the tell: "-azure" suffix on an AWS instance

dpkg -l | grep linux-image
# linux-image-6.8.0-1015-azure   installed
# (no linux-image-generic or linux-image-aws present)

lsmod | grep ena
# (no output — module not loaded)
```

The `-azure` suffix on `uname -r` while running as an EC2 instance is close to a definitive signal on its own. The absent `ena` entry in `lsmod` confirms the mechanism.

---

## The Fix: Kernel Swap Before Cutover

Install `linux-generic` — Ubuntu's broad-coverage kernel that includes `ena` support — alongside the existing kernel, update GRUB, and only then remove the Azure-specific one:

```bash
sudo apt update
sudo apt install -y linux-generic linux-headers-generic

# Confirm GRUB will boot the generic kernel first
grep GRUB_DEFAULT /etc/default/grub
sudo update-grub
```

The removal step comes **after** confirming the generic kernel boots successfully:

```bash
# Only after a successful boot on linux-generic:
sudo apt remove --purge linux-azure linux-image-*-azure linux-headers-*-azure
sudo update-grub
```

Removing the old kernel before confirming the new one boots is how a routine kernel swap turns into a boot-loop with no fallback entry in the GRUB menu.

The cleanest sequencing is doing this on the **source Azure VM before MGN replication begins** — so the replicated disk already has the correct kernel. If the source can't be touched, do it on a test-launched instance and validate before cutover.

---

## Baking It Into a Pre-Flight Check

For a migration wave with multiple servers, this is worth scripting into a pre-migration audit:

```bash
#!/bin/bash
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

Running this across every source server during wave planning — before agent installation — turns a per-incident debugging exercise into a one-line pre-flight check.

---

## The Second Layer: Network Interface Naming

Even after `ena` loads correctly, the network interface name the OS expects can be wrong. Azure and AWS use different predictable naming schemes, and the `netplan` config on the source server was written against Azure's naming. After the kernel swap, the `ena`-backed interface may come up under a different name than the config expects.

The robust fix is matching by driver rather than hardcoded name:

```yaml
network:
  version: 2
  ethernets:
    ena-primary:
      match:
        driver: ena
      dhcp4: true
```

This survives future re-platforming without another manual edit.

---

## Other Azure Dependencies to Audit in the Same Pass

While fixing the kernel, check for:

- **`walinuxagent`** — the Azure Linux Agent retries calls to `169.254.169.254`, the same link-local address AWS's instance metadata service uses. This collision can interfere with `cloud-init` and AWS tooling.
- **Azure-specific `udev` rules** — stale rules referencing Azure device paths, usually harmless but worth clearing.
- **`cloud-init` datasource** — if pinned to `Azure` in `/etc/cloud/cloud.cfg.d/`, it will hang or fail on AWS trying to find a datasource that doesn't exist.

---

## Don't Stay on linux-generic — Move to linux-aws

`linux-generic` is the right kernel to get unblocked during migration. It's not the right long-term kernel for a production AWS instance. Ubuntu publishes `linux-aws`, tuned specifically for Nitro, with platform-specific patches and its own update cadence separate from the generic track.

```bash
sudo apt update
sudo apt install -y linux-aws linux-headers-aws
sudo update-grub
```

Same discipline: confirm it boots and networks correctly before removing `linux-generic`.

---

## Read the Full Article

This summary covers the core diagnosis and fix. The full article includes:

- Why EC2 status checks pass even when the network is completely broken
- The exact GRUB default entry approach vs. `GRUB_DEFAULT=0` trade-offs
- The boot-loop scenario that results from removing the old kernel too early
- Validating through MGN test launch vs. serial console — why they're not equivalent
- The full audit checklist for Azure-sourced servers entering a migration wave

**👉 [Migrating Ubuntu 24.04 from Azure to AWS: The linux-azure Kernel Trap — Full Article](https://aloknecessary.in/blogs/aws-migration-ubuntu-kernel-fix/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=aws-migration-ubuntu-kernel-fix)**
