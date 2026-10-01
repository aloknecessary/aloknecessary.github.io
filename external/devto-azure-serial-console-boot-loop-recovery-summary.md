---
title: "Recovering an Azure VM Boot Loop with Serial Console, Mid-Migration"
published: false
description: How Azure Serial Console recovers a VM stuck in a boot loop after a kernel swap gone wrong — GRUB command-line recovery, initramfs regeneration, and the depmod root cause.
tags: azure, linux, devops, migration
canonical_url: https://aloknecessary.in/blogs/azure-serial-console-boot-loop-recovery/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=azure-serial-console-boot-loop-recovery
cover_image:
---

Installing a new kernel, running `update-grub`, and purging the old kernel in the same maintenance window — before rebooting to confirm the new one actually boots — is a sequence that feels safe right up until the VM never comes back up. With no fallback GRUB entry left and no SSH, no RDP, nothing reachable, the only path back is something that doesn't depend on the OS network stack at all. This is what that recovery looks like in practice, and what the root cause turned out to be.

---

## What Azure Serial Console actually is

Azure Serial Console gives direct access to the VM's serial port (COM1) through the Azure portal, completely independent of the guest OS's network stack. This is the critical property: it works when SSH, RDP, and every other normal access path are unreachable — including when the VM is stuck in a boot loop and never finishes booting at all.

Two prerequisites worth confirming *before* doing any kernel-level work, not during an incident:

- **Boot diagnostics must be enabled** on the VM — verify this explicitly on any VM you're about to do kernel work on, not assumed
- **The portal account needs `Virtual Machine Contributor` or equivalent** — read-only VM visibility is not enough for serial console access

---

## How the boot loop happened

The kernel swap sequence was: install `linux-generic`, run `update-grub`, purge `linux-azure` — all in the same session, without an intervening reboot. The assumption was that a successful package install and a clean `update-grub` run meant the new kernel would boot. That assumption was wrong: the `linux-generic` kernel had a dependency on an initramfs configuration that hadn't regenerated correctly for the Azure Hyper-V environment, and the VM never came back after the reboot.

With `linux-azure` already purged, there was no fallback GRUB entry. The VM sat in a continuous restart loop — visible in the Azure portal, but with no SSH, no RDP, nothing reachable.

---

## The recovery sequence

Connecting via serial console and pressing **Esc** during boot interrupts GRUB's countdown and lands on the menu:

```text
GNU GRUB  version 2.06

*Ubuntu
 Advanced options for Ubuntu
```

With a fallback kernel still present, selecting it directly is the fastest path back. In this case, `linux-azure` had already been purged, so only `linux-generic` entries remained — including a recovery mode option that also failed, since the problem was in the initramfs itself.

The next step: drop to the GRUB command line and confirm what's actually on disk:

```text
grub> ls
(hd0) (hd0,gpt2) (hd0,gpt1) (hd0,gpt15)

grub> ls (hd0,gpt2)/boot
grub.cfg  vmlinuz-6.8.0-1015-generic  initrd.img-6.8.0-1015-generic  ...
```

The kernel and initramfs files were both present — ruling out a missing-file problem and pointing toward a boot configuration or initramfs content issue. From the GRUB command line, booting manually:

```text
grub> linux (hd0,gpt2)/boot/vmlinuz-6.8.0-1015-generic root=/dev/sda2 ro
grub> initrd (hd0,gpt2)/boot/initrd.img-6.8.0-1015-generic
grub> boot
```

This got the system far enough to reach a root shell — not a fully working boot, but enough to diagnose and fix the actual cause from inside the VM.

---

## The actual root cause: missing modules.dep

Once at a shell, regenerating the initramfs surfaced the real problem:

```bash
update-initramfs -c -k 6.8.0-1015-generic
# W: missing /lib/modules/6.8.0-1015-generic/modules.dep!
```

The `linux-generic` package had installed, but `depmod` — which builds the module dependency map the initramfs generation relies on — hadn't run correctly. Doing the install-and-purge in the same session, without an intervening reboot, left `dpkg`'s package configuration hooks in an inconsistent state where this dependency step silently didn't complete.

The fix:

```bash
depmod -a 6.8.0-1015-generic
update-initramfs -c -k 6.8.0-1015-generic
update-grub
```

`-c` (create) rather than `-u` (update) was the deliberate choice — the existing initramfs was the suspected malformed artifact, so regenerating from scratch was safer than patching it in place.

After this, a normal reboot from the Azure portal came up cleanly on `linux-generic` with SSH reachable again.

---

## Why the reboot between install and purge matters

The general advice — reboot and confirm before purging the old kernel — is usually framed as "keep a fallback GRUB entry available." The `depmod` root cause adds a second, more specific reason: a reboot between installing the new kernel and removing the old one forces a clean package configuration state. The same-session install-then-purge sequence can skip past the `depmod` step that `update-initramfs` depends on, producing a malformed initramfs that only surfaces as a boot failure after the reboot you skipped.

---

## Troubleshooting checklist for serial-console-reachable boot failures

In order of how often each turns out to be the actual cause:

1. **Confirm kernel and initramfs files exist on disk** — `ls` from the GRUB command line before assuming anything about *why* boot is failing
2. **Check `modules.dep` and run `depmod -a` explicitly** if initramfs generation logs mention missing module dependencies — a plain `update-initramfs` re-run won't fix it without `depmod` first
3. **Inspect `/etc/default/grub` and `/boot/grub/grub.cfg`** for a default entry pointing at a kernel version that no longer exists
4. **Check disk space on `/boot`** — a full `/boot` partition can silently truncate `update-initramfs` or `update-grub` without a clear error, only surfacing as a boot failure afterward
5. **Consider a snapshot restore** if manual recovery isn't converging — sometimes the right first move rather than the last resort, depending on time pressure

---

## Pre-flight check for the next server in the wave

Two changes folded back into the migration runbook after this incident:

- Never purge the old kernel in the same session as installing the new one — always reboot and confirm first
- Confirm boot diagnostics is enabled and serial console access is usable — role permissions included — on every source VM *before* starting kernel-level work

```bash
az vm boot-diagnostics get-boot-log --name <vm-name> --resource-group <rg-name> \
  > /dev/null 2>&1 && echo "OK: boot diagnostics reachable" \
  || echo "WARNING: boot diagnostics not enabled or not reachable — enable before kernel changes"
```

---

## Read the Full Article

The full article covers:

- Why this boot loop failure is structurally different from the AWS-side `ena` driver issue in the previous article — same symptom ("server unreachable after kernel change"), completely different cause and recovery tool
- The full GRUB command-line recovery walkthrough with exact commands
- Why `update-initramfs -c` rather than `-u` was the right choice once at a shell
- The decision to do manual recovery rather than snapshot restore — and when snapshot restore is actually the better first move
- The pre-migration pre-flight script extended to confirm serial console access before kernel work begins

**👉 [Recovering an Azure VM Boot Loop with Serial Console, Mid-Migration — Full Article](https://aloknecessary.in/blogs/azure-serial-console-boot-loop-recovery/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=azure-serial-console-boot-loop-recovery)**
