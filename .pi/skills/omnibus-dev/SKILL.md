---
name: omnibus-dev
description: Setup, gates, and environment facts for working on the Omnibus repo. Use when running tests, typechecks, builds, or cargo here, when setting up a fresh checkout or Orca worktree, when a build fails with ERESOLVE or "is of type 'unknown'", or when briefing an agent to work on Omnibus.
---

# Working on Omnibus

Facts that are true of **this repository**, verified against `package.json`,
`package-lock.json`, `.github/workflows/`, and the source.

## Setup

A fresh checkout or Orca worktree has **no `node_modules` and no `.env`**.

```sh
# CI pins Node 22 (.github/workflows/*). Use the same — see "Node version" below.
npm ci --legacy-peer-deps
npx prisma generate
```

| Step | Skipping it causes |
|---|---|
| Node 22 | CI pins it; newer Node breaks the jsdom-based tests |
| `--legacy-peer-deps` | `npm ci` dies with ERESOLVE. `next-auth@4.24.15` (lockfile) declares `peerOptional nodemailer@^7`, but the repo pins `nodemailer@9.1.1`. **CI passes this flag too**, so it is the supported install, not a workaround |
| `prisma generate` | `tsc` reports bogus `db.komgaSyncState is of type 'unknown'` and `Property 'komgaLibrary' does not exist on type PrismaClient`. **These are stale-codegen errors, not real type errors** — regenerate before debugging |

`.env` is gitignored. `next build` compiles and then the build worker aborts with
`CRITICAL SECURITY ERROR: NEXTAUTH_SECRET is insecure or missing`. Supply one however
your setup normally does — copy from a working checkout or export a value inline.
**Never commit an `.env`.**

## Expected noise — not failures

- **`ECONNREFUSED 127.0.0.1:6379`** in test output. There is no Redis in CI or in a
  worktree. Redis is the BullMQ job backend only and is not a test dependency.
- **`NEXTAUTH_SECRET` / `ECONNREFUSED` lines during `next build`** when no `.env` is
  present — environmental, not a build failure.

## Gates

```sh
npm test                # vitest run --pool=forks
npm run lint            # eslint .
npm run build           # next build
npx tsc --noEmit        # not an npm script; run directly
```

Rust work additionally needs, from `omnibus-engine/`:

```sh
cargo clippy --all-targets -- -D warnings
cargo test
```

**Gotcha:** `npm run lint` walks `omnibus-engine/target`. Running it *while cargo is
building* crashes with ENOENT on a transient rmeta directory. Run cargo first, let it
finish, then lint.

**Baseline:** roughly 2400 tests passing, 0 failed. Re-measure rather than trusting a
number — it moves with every merge, and a stale baseline hides regressions.

## Briefing an agent

The setup block above must be in the brief. Do **not** write "dependencies are already
present" — that has been wrong every time and costs a failed run.

Brief agents to **stop and report after 3 consecutive failed tool calls**. A null-byte
or argument-validation error is a transport fault that will not self-heal; retrying
burns the agent's context budget without producing a file.

## Traps that cost real time

**`remote_path_mapping` is a test harness, not configuration.** The keys in
`src/app/admin/settings/tabs/system-tab.tsx` — under the card titled *"Docker Path
Mappings (Test Area)"* — feed `handleTest('mapping', …)` → `/api/admin/test`, whose
implementation is just:

```ts
`${remote}/test.cbz`.replace(remote, local)
```

They never reach the database or the resolver. The key the resolver actually reads,
`remote_path_mappings`, has **no writer anywhere in the repo** — only two readers
(`src/lib/utils/path-resolver.ts:37`, `src/scripts/test-mapping.js:21`) and no UI.

Renaming the test-area keys to match would make "Test Logic" write whatever the user
typed into the resolver's live config key. `JSON.parse` then throws, the error is
caught, and path translation silently stops working. The real gap is a **missing
global path-mapping editor**, which is feature work — not a spelling fix.

**Never run `prisma format`** — it reformats the entire schema. Do not edit
`prisma/schema.prisma` for unrelated work.

**A local dev database is not production truth.** Whatever `DATABASE_URL` points at during
development will have near-zero rows (`Request` is typically empty). Do not draw conclusions
about live behaviour from it.

## Local environment notes

Facts about one machine's setup. **Verify before relying on them elsewhere.**

- **Node version.** CI pins Node 22; `package.json` declares no `engines` field. On this
  machine the default `node` is v26, which breaks jsdom, so every command needs
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` (plus `$HOME/.cargo/bin` for Rust
  work). A machine with Node 22 as default does not need this.
- **No local Redis**, hence the `ECONNREFUSED` noise above. `docs/DEVELOPMENT.md` has
  the manual start command.
- **`curl`/`wget` are blocked by a local tool hook.** Use `node -e` with global `fetch`.
- **Orca worktrees** live under `~/orca/workspaces/omnibus/<name>` and start as bare
  checkouts, so they need the full setup block above. They are created off
  `origin/main`, not local `main`.