---
title: "I Almost Lost an Entire Blog with git reset --hard (And Git Saved Me)"
date: 2025-07-14
last_modified_at: 2025-07-14
author: Alok Ranjan Daftuar
description: "A real incident turned into a complete guide to Git recovery — reflog, reset modes, merge vs rebase, and the mental model every developer should internalize."
excerpt: "I ran git reset --hard on autopilot and watched my blog post vanish. Fortunately, Git is far more resilient than most developers realize. This post covers the recovery, the mental model behind commits and references, and the commands every developer should know before they need them."
keywords: "git, reflog, reset, rebase, merge, cherry-pick, interactive rebase, git recovery, version control, developer tools"
categories:
  - developer-experience
tags: [git, recovery, reflog, reset, rebase, merge, developer-tools, version-control, best-practices]
---

> **What started as a routine cleanup became a lesson in Git's resilience — and a reminder that understanding the model matters more than memorizing commands.**

---

## The Moment Everything Disappeared

Every developer has a Git horror story. Mine happened while writing *another* technical article.

I had a feature branch with a freshly committed blog post. I was tidying up my local repository — something I'd done a hundred times before. Then, almost on autopilot:

```bash
git checkout blogs/microservices-by-def
git reset --hard 65515962bc35fe08514f0b1dcad58cb89773bd2d
```

The terminal didn't flinch. No warning. No confirmation prompt.

My article was gone. The branch looked identical to `main`. Hours of writing — vanished in under a second.

For a brief, stomach-dropping moment, I thought it was over.

It wasn't.

---

## What Actually Happened

Before the reset, my branch looked like this:

```text
main:     A ── B ── C
feature:  A ── B ── C ── D  ← my blog commit
```

After `git reset --hard <commit-on-main>`:

```text
feature:  A ── B ── C  ← pointer moved here
                        (D still exists, just orphaned)
```

The files vanished from my working directory. But the critical question was:

> Did Git *delete* my commit?

**No.** It just moved the pointer. The commit was still there — floating, unreachable, but alive.

---

## Git Doesn't Think in Files

This is the mental model shift that changes everything.

Git doesn't store files. It stores **snapshots**. A branch is nothing more than a pointer to the latest commit in a chain. When you run `git reset`, you're not deleting history — you're relocating a label.

The commit itself persists until garbage collection eventually prunes unreachable objects (which doesn't happen immediately). Once this clicks, Git stops feeling dangerous and starts feeling predictable.

---

## The Recovery: `git reflog`

The first thing I ran:

```bash
git reflog show blogs/microservices-by-def
```

Output:

```text
6551596 reset: moving to 65515962bc35...
0434e98 commit: added blog on Microservices by Default
```

There it was. My commit, recorded in the reflog — Git's silent flight recorder that tracks every HEAD movement.

Recovery took one command:

```bash
git reset --hard 0434e98
```

Everything came back. Every word, every code block, every carefully crafted paragraph.

---

## Understanding Git's Three Areas

Most Git confusion dissolves once you internalize these three zones:

| Area | What Lives Here |
| ---- | --------------- |
| Working Directory | Files on disk (what you see in your editor) |
| Index (Staging Area) | Files staged for the next commit |
| Repository (HEAD) | The committed history |

### What each reset mode touches

| Command | Working Tree | Index | HEAD |
| ------- | :---: | :---: | :---: |
| `git reset --soft` | ✗ | ✗ | ✓ |
| `git reset --mixed` (default) | ✗ | ✓ | ✓ |
| `git reset --hard` | ✓ | ✓ | ✓ |

`--hard` is the nuclear option. It rewrites all three areas. That's why my files disappeared — not because the commit was destroyed, but because my working directory was forcibly synced to a different snapshot.

---

## Reset vs Restore vs Revert

These three commands sound similar but serve fundamentally different purposes:

**`git reset`** — Moves branch history backward. Use for local cleanup before pushing.

**`git restore`** — Discards file changes without touching history. Ideal for "I accidentally edited the wrong file."

**`git revert`** — Creates a *new* commit that undoes a previous one. The only safe option for shared branches because it preserves history for everyone else.

---

## Merge vs Rebase: The Eternal Debate

### Merge

```text
A──B──C────M
    \     /
     D──E
```

Preserves the full branching context. Never rewrites history. Safe for shared branches. The trade-off: merge commits accumulate and history gets noisy.

### Rebase

```text
A──B──C──D'──E'
```

Replays your commits on top of the target branch. Clean, linear history. Better `git blame`, better `git bisect`, easier code reviews. The trade-off: it rewrites commit hashes.

> **The rule**: Rebase what's yours. Never rebase commits others have already pulled.

---

## Interactive Rebase: Git's Power Tool

```bash
git rebase -i HEAD~5
```

This opens an editor where you can:

- **pick** — keep as-is
- **squash** — combine with previous commit
- **fixup** — squash but discard the message
- **reword** — change the commit message
- **edit** — pause to amend
- **drop** — remove entirely

A polished commit history isn't vanity — it's a gift to your future self debugging at 2 AM.

### Reword: Fixing Commit Messages After the Fact

One of the most underrated interactive rebase operations. Typo in a commit message? Vague description you wrote at midnight? You don't need to live with it:

```bash
git rebase -i HEAD~3
# Change 'pick' to 'reword' on the target commit
# Save, and Git opens your editor to rewrite the message
```

Unlike `git commit --amend` (which only fixes the *latest* commit), `reword` lets you fix any commit in your local history. It's the difference between a commit log that tells a story and one that reads like a stream of consciousness.

---

## Other Recovery Tools Worth Knowing

### Cherry-pick

Need exactly one commit from another branch?

```bash
git cherry-pick <commit-hash>
```

Especially useful for backporting hotfixes across release branches.

### Stash

Interrupted mid-task?

```bash
git stash          # shelve current changes
git stash pop      # restore them later
git stash -u       # include untracked files
```

### Recovering Deleted Branches

```bash
git reflog                          # find the last commit
git checkout -b revived <commit>    # recreate the branch
```

### When Reflog Isn't Enough

```bash
git fsck --lost-found    # find dangling/orphaned objects
git show <hash>          # inspect what you found
```

This has rescued repositories that seemed beyond saving.

---

## Git Command Decision Matrix

| I want to... | Use |
| --- | --- |
| Undo a local commit | `git reset` |
| Undo a pushed commit | `git revert` |
| Recover lost work | `git reflog` |
| Save work temporarily | `git stash` |
| Restore a single file | `git restore` |
| Move specific commits | `git cherry-pick` |
| Clean up commit history | `git rebase -i` |
| Find orphaned objects | `git fsck` |

---

## Why Linear History Matters

Modern CI/CD pipelines and engineering teams increasingly favor linear commit graphs. The benefits compound:

- Simpler release management and rollbacks
- Faster root-cause analysis with `git bisect`
- Cleaner pull requests and code reviews
- Better automation and changelog generation

This is why many teams adopt squash-merge or rebase workflows as a standard.

---

## Lessons Learned

1. **Commit early, commit often.** Small commits are cheap insurance.
2. **Push important milestones.** Remote refs survive local disasters.
3. **Learn `reflog` before you need it.** In a panic, you won't have time to read docs.
4. **Understand the model, not just the commands.** Knowing *why* something works beats memorizing *what* to type.
5. **Never panic after a bad Git command.** Most mistakes are recoverable if you don't compound them with more commands.

---

## Final Thought

My article was never actually lost. Only the branch pointer moved. That single realization changed how I think about Git entirely.

The more you understand commits, references, and snapshots, the more Git transforms from something that feels unpredictable into something that feels *remarkably* forgiving.

If there's one command worth remembering from this entire post:

```bash
git reflog
```

It saved my work. Someday, it'll save yours too.

---

## Coming Next

This article is the foundation of a broader Git mastery series. Upcoming:

1. Interactive Rebase Masterclass
2. Git Internals — Objects, Trees, and Blobs
3. Advanced Recovery Techniques
4. Branching Strategies for Professional Teams
5. Git for CI/CD and Release Engineering
6. Power User Features — Bisect, Worktree, and Hooks
