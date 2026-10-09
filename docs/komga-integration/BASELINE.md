# Phase 0 baselines (komga-integration @ 240d920 = main@2ce1fb6 + plan), 2026-10-02

Toolchain: node v22.23.3 (/opt/homebrew/opt/node@22), cargo 1.96.0, prisma 5.22.0, OpenJDK 21.0.12.1.

- npm ci: plain `npm ci` fails ERESOLVE (next-auth@4.24.15 peerOptional nodemailer@^7 vs root nodemailer@^9.1.1) -> `npm ci --legacy-peer-deps` OK.
- npx prisma generate: OK.
- npx prisma validate: fails without DATABASE_URL (P1012); OK after copying the main checkout's .env (gitignored).
- npx vitest run --pool=forks: 171 files passed | 1 skipped (172); 1095 tests passed | 2 skipped (1097).
  - First run under concurrent cargo load: 2 failures in __tests__/app/library/library-page.test.tsx (5 s timeouts:
    "adds a series by ID from the library toolbar…", "hides Add by ID…"). File passes alone and the full suite passes
    when run without load -> load-sensitive flake, pre-existing.
- npx tsc --noEmit: clean (exit 0, no output).
- npm run lint: exit 1 — 2 errors, 2004 warnings (pre-existing):
  - src/app/api/library/cover/route.ts:198:7 prefer-const (`filePath`)
  - src/lib/pages/page-sweep.ts:95:11 prefer-const (`items`)
  - NOTE: eslint walks omnibus-engine/target; running it while cargo builds crashes with ENOENT on a transient rmeta dir.
- omnibus-engine: cargo clippy --all-targets -- -D warnings: clean. cargo test: 292 passed, 0 failed.
