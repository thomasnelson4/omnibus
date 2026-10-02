# Local development

Omnibus runs as three processes: the Next.js web app, a Rust HTTP engine, and Redis.
The web app and engine share one database and the same filesystem paths. SQLite is
the simplest development option; PostgreSQL is optional.

## Codebase map

| Location | Responsibility |
| --- | --- |
| `src/app/` | Next.js App Router pages and API routes, including setup, library, reader, requests, and administration |
| `src/components/`, `src/hooks/` | React UI, shared controls, and client hooks; styling uses Tailwind 4 |
| `src/lib/` | Authentication helpers, permissions, metadata providers, integrations, and application services |
| `src/instrumentation.ts` | Startup initialization: database data migrations, cron tasks, and the BullMQ worker |
| `src/lib/queue.ts`, `src/lib/engine.ts` | Redis job scheduling and authenticated requests to the Rust engine |
| `prisma/schema.prisma` | Shared data model: users, libraries, series, issues, reading activity, settings, and job logs |
| `omnibus-engine/src/` | Axum routes and Rust services for scanning, archives, covers, downloads, matching, metadata, and backups |
| `__tests__/` | Vitest API, library, and component tests; Rust tests live alongside engine modules |

The database initializer migrates application data; it does **not** create the
database schema. Run Prisma's schema synchronization before starting either app.
Most integrations are configured in database settings through the UI, rather than
environment variables.

## Prerequisites

- Node 22, matching CI.
- Rust 1.96.0, matching CI, with a C/C++ compiler and `pkg-config`.
- Redis.
- `unrar` for native CBR reading and `unar` as an extraction fallback.

On macOS, Xcode Command Line Tools provide the compiler. Homebrew can install
`node@22`, `redis`, `pkgconf`, and `unar`. Install Rust using
[rustup](https://rust-lang.org/tools/install/).

For this Mac, Node 22 is installed alongside the existing Node version. In each
development terminal, select it and expose Cargo's binaries:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
source "$HOME/.cargo/env"
```

`unrar` was built from [RARLAB's official source](https://www.rarlab.com/rar_add.htm)
and installed at `/Users/thomas/.local/bin/unrar`, which is already on this Mac's
PATH. Check `command -v unrar unar` before working with CBR files. Homebrew's `rar`
cask was disabled when this environment was prepared.

## Initial setup

Run commands from the repository root unless indicated otherwise:

```sh
npm ci --legacy-peer-deps
```

Create a root `.env`. Both Next.js and the engine load it; the engine also finds it
when launched from `omnibus-engine/`. Replace `/ABSOLUTE/REPO` below with the absolute
checkout path and use `openssl rand -hex 32` to generate the secret. Absolute paths
ensure Prisma and the engine open the same SQLite file despite their different
working directories.

```dotenv
DATABASE_URL=file:/ABSOLUTE/REPO/config/omnibus.db
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=REPLACE_WITH_A_RANDOM_SECRET
OMNIBUS_REDIS_URL=redis://127.0.0.1:6379/0
OMNIBUS_ENGINE_URL=http://127.0.0.1:8000
OMNIBUS_ENGINE_BIND=127.0.0.1:8000
OMNIBUS_NODE_URL=http://localhost:3000
OMNIBUS_CONFIG_DIR=/ABSOLUTE/REPO/config
OMNIBUS_CACHE_DIR=/ABSOLUTE/REPO/config/cache
OMNIBUS_LOGS_DIR=/ABSOLUTE/REPO/config/logs
OMNIBUS_BACKUPS_DIR=/ABSOLUTE/REPO/config/backups
OMNIBUS_WATCHED_DIR=/ABSOLUTE/REPO/watched
OMNIBUS_AWAITING_MATCH_DIR=/ABSOLUTE/REPO/unmatched
RUST_LOG=info
```

A private `.env` has already been created for this checkout. Keep the same
`NEXTAUTH_SECRET` in both processes; engine API calls authenticate with it. The
default paths assume Docker directories such as `/config`, so the overrides above
are needed for native development. `.env` and the local data directories are
ignored by Git.

```sh
mkdir -p config/{cache,logs,backups,redis,downloads,library/comics,library/manga} watched unmatched
npx prisma generate
npx prisma db push --skip-generate
cd omnibus-engine
cargo +1.96.0 build --locked
```

## Start the stack

Use three terminals. Begin each at the repository root and select Node/Cargo as
shown above. These commands run in the foreground; Ctrl-C stops each process.

Redis:

```sh
redis-server --bind 127.0.0.1 --port 6379 --dir "$PWD/config/redis" --appendonly yes
```

Rust engine:

```sh
cd omnibus-engine
cargo +1.96.0 run --locked
```

Web app:

```sh
npm run dev -- --hostname 127.0.0.1
```

Open <http://localhost:3000/setup> to create your admin account. For this checkout,
use `/Users/thomas/repos/sbx/omnibus/config/library/comics` for the comics library,
`/Users/thomas/repos/sbx/omnibus/config/library/manga` for an optional manga library,
and `/Users/thomas/repos/sbx/omnibus/config/downloads` for downloads. Choose your
own admin credentials. Provider keys and download integrations can be left blank
for basic UI and local-library development, then configured in Settings.

Next.js reloads web changes automatically. Restart `cargo run` after Rust changes.
After editing `prisma/schema.prisma`, stop both apps, regenerate the client, and
run `prisma db push` against your development database before restarting.

The supplied Docker Compose files use published images and host-specific volume
placeholders. They are deployment examples; the native commands above run this
checkout's source with Next.js development reloads.

## Verification

```sh
redis-cli -h 127.0.0.1 ping
curl http://127.0.0.1:8000/health
curl http://localhost:3000/api/setup/check
npm test
npx tsc --noEmit
cd omnibus-engine
cargo +1.96.0 test --locked
```

Redis should return `PONG`; the engine should report `status: "ok"`. A source build
reports its crate version (`0.1.0`) with `release: false`. Before creating an admin,
the setup check should return `requiresSetup: true`. The engine's
`/api/health/auth` endpoint requires `X-Internal-Secret` with the shared secret;
an unauthenticated request should return 401.

Further contributor checks are `npm run lint`, `npm run build`, and
`cargo clippy --all-targets -- -D warnings`. The Next.js build configuration skips
type and lint enforcement, so a successful build alone does not establish that
those checks pass. Live qBittorrent tests require explicit `QBIT_LIVE_*` variables
and are otherwise skipped.
