---
name: omnibus-dev
description: Setup, gates, and environment facts for working on the Omnibus repo (/Users/thomas/repos/sbx/omnibus). Use when running tests, typechecks, builds, or cargo in this repo, when setting up a fresh Orca worktree, when a build fails with ERESOLVE or "is of type 'unknown'", or when briefing an agent to work on Omnibus.
---

# Working on Omnibus

## Fresh worktrees have nothing installed

An Orca worktree is a bare checkout. **`node_modules` does not exist** and neither does `.env`.

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH
npm ci --legacy-peer-deps
npx prisma generate
cp /Users/thomas/repos/sbx/omnibus/.env .env
```

Each line exists for a reason — see the failure modes below.

## Why each step is mandatory

| Step | Skipping it causes |
|---|---|
| `PATH=…/node@22/bin` | Node 26 is the machine default and breaks jsdom; tests fail obscurely |
| `npm ci --legacy-peer-deps` | plain `npm ci` dies with ERESOLVE (next-auth@4.24.15 peerOptional `nodemailer@^7` vs root `nodemailer@^9.1.1`) |
| `npx prisma generate` | `tsc` reports bogus `db.komgaSyncState is of type 'unknown'` and `Property 'komgaLibrary' does not exist on type PrismaClient`. **These are stale-codegen errors, not real type errors** — regenerate before debugging |
| `cp …/.env .env` | `next build` compiles, then the build worker aborts: `CRITICAL SECURITY ERROR: NEXTAUTH_SECRET is insecure or missing`. `.env` is gitignored; copy it, never commit one |

## Expected noise — not failures

- **`ECONNREFUSED 127.0.0.1:6379`** in test output. There is no Redis in a worktree. Redis is the BullMQ job backend only and is not a test dependency. `docs/DEVELOPMENT.md` covers running it locally.
- **`NEXTAUTH_SECRET` / `ECONNREFUSED` build log lines** when `next build` runs without a `.env` — environmental, not a build failure.

## Gates

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH
npx vitest run --pool=forks        # baseline: see below
npx tsc --noEmit                   # must be 0 errors
npm run lint                       # 0 errors; ~2200 warnings is the clean baseline
npx next build
```

Rust work additionally needs:

```sh
cd omnibus-engine
cargo clippy --all-targets -- -D warnings
cargo test
```

**Gotcha:** eslint walks `omnibus-engine/target`. Running it *while cargo is building* crashes with ENOENT on a transient rmeta directory. Run cargo first, let it finish, then lint.

Current `main` baseline as of `ca121ca`: **223 test files, ~2400 tests, 0 failed** — re-measure rather than trusting this number, since it moves with every merge.

## Briefing an agent

When spawning an agent into a worktree, the setup block above must be in the brief. Do **not** write "dependencies are already present" — that has been wrong every time and costs a failed run.

Also brief them to **stop and report after 3 consecutive failed tool calls**. A null-byte or argument-validation error is a transport fault that will not self-heal; retrying it burns the agent's entire context budget without producing a file.

## Traps that cost real time

**`remote_path_mapping` is a test harness, not config.** The keys in `system-tab.tsx` ("Docker Path Mappings (Test Area)") feed `handleTest('mapping', …)` → `/api/admin/test`, whose implementation is just `` `${remote}/test.cbz`.replace(remote, local) ``. They never reach the DB or the resolver. The key the resolver actually reads, `remote_path_mappings`, has **no writer in the repo at all** — there is no global path-mapping UI. Renaming the test-area keys to match would make "Test Logic" clobber live config and silently break path translation. Fixing this means building a real editor, not renaming.

**Never run `prisma format`** — it reformats the entire schema. Never edit `prisma/schema.prisma` for unrelated work.

**`curl`/`wget` are blocked by a hook.** Use `node -e` with global `fetch`.

**`dev.db` is a dev database.** It has near-zero rows (`Request` is empty). It is not a source of production truth — do not draw conclusions about live behaviour from it.