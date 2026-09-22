---
title: "Recovering an Azure VM Boot Loop with Serial Console, Mid-Migration"
date: 2026-09-05
last_modified_at: 2026-09-09T13:55:15+05:30
author: Alok Ranjan Daftuar
description: "How Azure Serial Console recovers a VM stuck in a boot loop after a kernel swap gone wrong — GRUB command-line recovery, initramfs regeneration, and the depmod root cause."
excerpt: "Removing the old kernel before confirming the new one boots is exactly how a routine swap becomes a VM with no bootable entry left. This is how Azure Serial Console got it back."
keywords: "azure serial console, boot loop, grub recovery, linux-azure, initramfs, depmod, kernel swap, azure vm, migration"
twitter_card: "summary_large_image"
categories:
  - migration
  - cloud
tags: [azure-serial-console, boot-loop, grub, linux-azure, kernel, recovery]
series: "AWS Migration Playbook"
series_order: 3
---

The [previous article in this series](/blogs/aws-migration-ubuntu-kernel-fix/) walked through the fix for the `linux-azure` to `linux-generic` kernel swap needed before migrating an Ubuntu 24.04 server to AWS, and flagged one specific risk in passing: removing the old kernel before confirming the new one boots successfully. This article is what happened when I made exactly that mistake on the source Azure VM, and the recovery — Azure Serial Console — which turned an apparently bricked VM back into a working migration source without a rebuild.

## How the boot loop actually happened

Working through the kernel swap described in the previous article, I installed `linux-generic`, ran `update-grub`, and — moving faster than I should have — purged the `linux-azure` packages in the same maintenance window, before actually rebooting to confirm `linux-generic` came up cleanly. The assumption was that a successful package install and a clean `update-grub` run meant the new kernel would boot fine. That assumption was wrong in a way that had nothing to do with the `ena` driver work from the previous article — it was a separate, more basic problem: the `linux-generic` kernel that got installed had a dependency on an initramfs configuration that hadn't regenerated correctly for the Azure Hyper-V environment specifically, and the VM never came back up after the reboot.

With `linux-azure` already purged, there was no fallback GRUB entry to select on next boot. The VM sat in a loop — visible in the Azure portal as continuous restarts, no successful boot completing, and critically, **no SSH, no RDP, nothing reachable**, because none of those services start until the OS has actually finished booting, which it never did.

## Why this is a genuinely different failure from the AWS kernel issue

It's worth being precise about the distinction, because the two articles' symptoms can look superficially similar — "server unreachable after a kernel change" — but the causes and the recovery tools are completely different. The AWS-side `ena` driver issue in the previous article produces a server that **boots successfully** and reports healthy at the instance level, but has no network stack. This Azure-side boot loop is a server that **never completes booting at all** — nothing above the kernel and initramfs layer ever runs, so there's no OS-level anything to reach, healthy or otherwise. The AWS case needed EC2 Serial Console to confirm a hypothesis about a loaded kernel module. This case needed Azure Serial Console to interact with a boot process that wasn't completing — a lower-level, more urgent kind of access.

## What Azure Serial Console actually is

Azure Serial Console gives direct access to the VM's serial port (COM1) through the Azure portal, independent of the VM's network stack entirely. This is the critical property: because it doesn't depend on the guest OS's network being up, it works even when — especially when — the VM is in a state where SSH, RDP, and every other normal access path are unreachable. It's the equivalent tool to the EC2 Serial Console referenced in the previous article, and functions similarly: a text console into whatever the VM's boot process is outputting, including GRUB itself, before any OS services or network stack are involved at all.

Two prerequisites matter here, both worth confirming *before* you're in an incident, not during one: boot diagnostics needs to be enabled on the VM (it usually is by default on recent VM creations, but it's worth verifying explicitly on any VM you're about to do kernel-level work on), and the account accessing the portal needs the `Virtual Machine Contributor` role or equivalent — serial console access requires more than read-only VM visibility.

## The recovery sequence

Connecting to serial console from the Azure portal drops you into whatever the VM's serial output is showing. The first thing worth trying — simpler than anything below, and the right first move in almost every boot-loop scenario reachable via serial console — is pressing **Esc** during the boot sequence to interrupt GRUB's countdown and land on its menu, rather than letting it auto-select whatever default entry is failing:

```text
GNU GRUB  version 2.06

*Ubuntu
 Advanced options for Ubuntu
```

From here, selecting **Advanced options for Ubuntu** expands into the individual installed kernel entries. This is the step that would have saved considerable time if `linux-azure` hadn't already been purged in the same session — with a fallback kernel entry still present, selecting it directly and booting is by far the fastest path back to a reachable system, and it immediately tells you whether the problem is specific to the new kernel or something broader in the boot chain. That's the whole reason the previous article's guidance is to reboot and confirm before purging: it keeps exactly this option available if the new kernel turns out not to boot cleanly.

In this incident, though, the purge had already run before the failed reboot, so the Esc menu offered only the `linux-generic` entries — including a recovery mode option, which also failed to reach a usable shell in this case, since the underlying problem was in the initramfs itself rather than something recovery mode's minimal boot path would bypass. With no working fallback kernel left to select, the only remaining path was dropping to the GRUB command line directly and inspecting what actually existed on disk:

```text
# At the GRUB menu, press 'e' to edit the boot entry, or 'c' for a GRUB command line
# From the GRUB command line:
grub> ls
(hd0) (hd0,gpt2) (hd0,gpt1) (hd0,gpt15)

grub> ls (hd0,gpt2)/boot
grub.cfg  vmlinuz-6.8.0-1015-generic  initrd.img-6.8.0-1015-generic  ...
```

The `linux-generic` kernel and its initramfs were both actually present on disk — this ruled out a missing-file problem and pointed toward a boot configuration or initramfs content problem specifically, not a "the kernel isn't there" problem.

From the GRUB command line, booting the kernel manually, bypassing whatever the auto-generated `grub.cfg` entry was doing incorrectly:

```text
grub> linux (hd0,gpt2)/boot/vmlinuz-6.8.0-1015-generic root=/dev/sda2 ro
grub> initrd (hd0,gpt2)/boot/initrd.img-6.8.0-1015-generic
grub> boot
```

This got the system far enough to reach a root shell — not a fully working boot, but enough access to actually diagnose and fix the underlying initramfs problem from inside the VM, which was the real goal. Reaching this point is the actual value of the serial console: it turns "no boot, no idea why" into "booted just far enough to fix the real cause," using the console's ability to intervene at the bootloader level, before any OS-level access path would normally exist.

Once at a shell, the fix was regenerating the initramfs correctly for the actual running kernel:

```bash
# Confirm which kernel is actually running in this manually-booted state
uname -r

# Regenerate initramfs explicitly for the installed generic kernel
update-initramfs -c -k 6.8.0-1015-generic

# Regenerate GRUB's configuration to reflect a correctly built initramfs
update-grub
```

`update-initramfs -c` (create, rather than update an existing one) was the deliberate choice here rather than `-u` — the existing initramfs was the thing suspected of being malformed, so regenerating it from scratch rather than attempting to patch it in place was the safer move, given I already had a working shell and nothing left to lose by starting clean.

After regenerating both the initramfs and the GRUB configuration, a normal reboot from the Azure portal (not another manual GRUB intervention) came up cleanly on `linux-generic`, with SSH reachable again through the normal network path — confirming the fix wasn't just a serial-console-accessible half-state but an actual, complete, working boot.

## Digging into why the initramfs was actually malformed

Getting to a working shell via the manual GRUB boot was the recovery step, but it's worth documenting what the actual root cause turned out to be, since "regenerate initramfs and hope" isn't a satisfying enough explanation to trust the fix for the rest of the migration wave. Checking `update-initramfs`'s own output during the manual regeneration surfaced the actual issue:

```bash
update-initramfs -c -k 6.8.0-1015-generic
# update-initramfs: Generating /boot/initrd.img-6.8.0-1015-generic
# W: missing /lib/modules/6.8.0-1015-generic/modules.dep!
```

The `linux-generic` package installation had completed, but `depmod` — the step that builds the module dependency map (`modules.dep`) the initramfs generation process relies on — hadn't run correctly during the earlier `apt install`, likely because a prior step in that same session (installing `linux-generic`, then almost immediately purging `linux-azure` before a reboot) left `dpkg`'s package configuration hooks in an inconsistent state. Running `depmod` explicitly before regenerating the initramfs was the actual missing piece:

```bash
depmod -a 6.8.0-1015-generic
update-initramfs -c -k 6.8.0-1015-generic
update-grub
```

This is worth calling out specifically because it reframes the lesson slightly: the failure wasn't purely "purged the fallback kernel too early" in the abstract — it was that doing the install-and-purge in the same session, without an intervening reboot, left package configuration scripts in a state where a dependency step silently didn't complete. A reboot between installing the new kernel and removing the old one wouldn't just have preserved a fallback GRUB entry — it would very likely have avoided the broken `modules.dep` state entirely, since the reboot forces exactly the kind of clean state that a same-session install-then-purge sequence can skip past.

## A general troubleshooting checklist for serial-console-reachable boot failures

Beyond this specific initramfs cause, a short, ordered list of what to check once you're at a GRUB or shell prompt via serial console on a VM that won't boot normally, roughly in order of how often each one turns out to be the actual cause:

1. **Confirm the kernel and initramfs files actually exist on disk** (`ls` from the GRUB command line, as shown above) before assuming anything about *why* boot is failing — a missing file changes the diagnosis entirely from a misconfiguration to something that deleted or never installed a required file.
2. **Check `modules.dep` and run `depmod -a` explicitly** if the initramfs generation logs mention missing module dependencies, rather than assuming a plain `update-initramfs` re-run will fix it — as shown above, it often won't without `depmod` run first.
3. **Inspect `/etc/default/grub` and the generated `/boot/grub/grub.cfg`** for a default entry pointing at a kernel version that no longer exists, which produces a different symptom (GRUB auto-selecting a stale, non-existent entry and failing immediately) from the initramfs case here, but is common enough after any kernel swap to check early.
4. **Check disk space on `/boot`** specifically — a full `/boot` partition can silently truncate a `update-initramfs` or `update-grub` run without a clear error at the time, only surfacing as a boot failure afterward. This wasn't the cause here, but it's common enough on VMs with a small, fixed `/boot` partition size to check as a quick early elimination step.
5. **Only after the above, consider a snapshot restore** as the fallback if manual recovery isn't converging — as discussed below, this is sometimes the right first move rather than the last resort, depending on the situation.

## Why I didn't just restore from a snapshot

The faster option in the moment would have been restoring a pre-change disk snapshot if one existed, and it's worth being honest that this is often the *better* first move in a genuine production incident — serial console recovery is a deeper, slower diagnostic path than "restore and retry," and it's not always the right call to reach for it first. In this specific case, I chose the manual recovery path deliberately, because this was a migration source server mid-replication under MGN, and I wanted to understand exactly what had gone wrong in the initramfs generation before repeating the same kernel swap procedure across the rest of the migration wave — a snapshot restore would have gotten the one VM back but taught me nothing about why it happened, and I'd have hit the same failure on the next server in the wave. For a true production outage with no time pressure to understand root cause immediately, restoring from a snapshot first and doing the root-cause analysis afterward, on a non-production copy, is usually the more defensible sequencing.

## Documenting this before the next server in the wave

The last practical step, easy to skip when you're relieved a VM is finally back, was writing this incident down before moving to the next source server in the wave — specifically the `depmod` root cause, not just "reboot between install and purge," since the general advice alone wouldn't have explained *why* skipping the reboot mattered if the same symptom showed up again under slightly different circumstances. A one-paragraph incident note added directly to the migration wave's runbook, cross-referenced against this exact recovery sequence, meant the next engineer working through the same kernel swap on a different source server had the actual GRUB commands and the `depmod` fix on hand immediately, rather than needing to rediscover the same root cause from scratch under the same time pressure.

## What changed in the runbook after this incident

Two changes came out of this directly, both folded back into the kernel article's guidance. First, never purge the old kernel package in the same session as installing the new one — always reboot and confirm the new kernel boots successfully first, with the old kernel still present and selectable in GRUB as a fallback, exactly as the previous article's fix section describes. Second, and specific to Azure sources: confirm boot diagnostics is enabled and serial console access is actually usable — role permissions included — on every source VM *before* starting any kernel-level work on it, not after something's already gone wrong and you're discovering for the first time whether you have the access you need.

```bash
# pre-migration-kernel-check.sh, extended from the previous article,
# now also confirming boot diagnostics is enabled before kernel work begins
az vm boot-diagnostics get-boot-log --name <vm-name> --resource-group <rg-name> \
  > /dev/null 2>&1 && echo "OK: boot diagnostics reachable" \
  || echo "WARNING: boot diagnostics not enabled or not reachable — enable before kernel changes"
```

Adding this as a pre-flight check, alongside the kernel-version check from the previous article, means the tooling needed for exactly this recovery scenario is confirmed working *before* a kernel swap starts on any given source server, not discovered to be missing in the middle of an actual incident.

> 📌 **Key Takeaway**: A kernel swap that removes the old kernel before confirming the new one boots leaves no fallback entry in GRUB if something goes wrong — and initramfs regeneration issues are a real, separate failure mode from driver problems, not covered by the driver fix alone. Azure Serial Console recovers from this because it operates below the OS network stack, giving GRUB-level and shell-level access to a VM that's otherwise completely unreachable. The lasting fix isn't just the recovery procedure — it's never purging a fallback kernel until the replacement has actually been confirmed to boot.

This closes out the two-part detour into the kernel migration incident. The next article in this series moves on to CIDR planning for Azure-to-AWS migrations — specifically, how to reconcile source Azure VNet ranges against the target AWS CIDR allocation plan covered earlier in the AWS Network Architecture series, before the next migration wave's network design is locked in.
