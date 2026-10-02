# MediaFire and MEGA download credentials

Initial implementation plan, researched on 2026-10-02. MEGA authenticated downloads
have since been implemented; MediaFire authentication is deferred. No provider
accounts were used for live tests. See the README for MEGA account configuration.

The recommendation is to implement MEGA account downloads with the existing
`megajs` dependency, and implement MediaFire account downloads after verifying its
current authentication and public-file permissions. Both belong in Omnibus's
hoster layer, after GetComics discovers a link.

## What Kapowarr actually does

Reviewed Kapowarr `main` at commit
[`c191dda6617929c81292483a8cc07f631111dae2`](https://github.com/Casvt/Kapowarr/tree/c191dda6617929c81292483a8cc07f631111dae2).

- Its credential sources are **MEGA and Pixeldrain**. MediaFire is not registered
  as a credential source. See its [credential definitions](https://github.com/Casvt/Kapowarr/blob/c191dda6617929c81292483a8cc07f631111dae2/backend/base/definitions.py#L452).
- MEGA validates email/password credentials, tries configured accounts before
  anonymous login, and caches session IDs in memory for one hour. Both file and
  folder downloaders use the authenticated API client. See
  [MEGA authentication](https://github.com/Casvt/Kapowarr/blob/c191dda6617929c81292483a8cc07f631111dae2/backend/implementations/download_clients/Mega.py#L644).
- MediaFire resolves public download pages using a JavaScript redirect, the
  download button, or its base64-encoded URL. It does not log into a MediaFire
  account. See the [MediaFire downloader](https://github.com/Casvt/Kapowarr/blob/c191dda6617929c81292483a8cc07f631111dae2/backend/implementations/download_clients/MediaFire.py).
- GetComics preparation identifies the hoster and dispatches to the matching
  downloader; credentials are handled by the downloader. See
  [GetComics dispatch](https://github.com/Casvt/Kapowarr/blob/c191dda6617929c81292483a8cc07f631111dae2/backend/implementations/download_preppers/ddl/GetComics.py#L363).

The useful precedent is provider-specific authentication, reusable sessions, and
anonymous fallback. MediaFire authentication needs its own implementation.

## Omnibus behavior before implementation

| Area | Existing behavior | Consequence |
| --- | --- | --- |
| [HosterAccount](../prisma/schema.prisma) | Stores username, password, API key, active flag, and timestamps | MEGA email/password needs no schema change; use `username` for the email |
| [Admin config API](../src/app/api/admin/config/route.ts) | Encrypts passwords/API keys and masks them on read; preserves `********` on save | Reuse the credential storage and masking conventions |
| [HosterEngine](../src/lib/hosters/index.ts) | Loads the first active account, decrypts secrets, passes it to the resolver | Account loading already exists; selection order is unspecified |
| [MEGA resolver](../src/lib/hosters/mega.ts) | Accepts an account but ignores it; uses anonymous `File.fromURL` | Saved MEGA credentials have no effect |
| [MediaFire resolver](../src/lib/hosters/mediafire.ts) | Treats `apiKey` as a `session` cookie; never uses username/password | There is no supported login or token renewal flow |
| [DownloadService](../src/lib/download-clients.ts) | Resolves hosters in Node; streams MEGA in Node and HTTP downloads in Rust | Authentication can fit the existing split |
| [Settings](../src/app/admin/settings/page.tsx) and [Setup](../src/app/setup/page.tsx) | Settings exposes only an API key; Setup exposes username/password/API key | The forms disagree and Settings cannot configure MEGA login |
| [Cron](../src/lib/cron.ts) and [manual retry](../src/app/api/request/retry/route.ts) | Some retry calls omit the hoster argument | Retried MEGA/MediaFire links bypass the resolver |

`package-lock.json` locks `megajs` to **1.3.10**. Its published code and types were
inspected separately because dependencies are not installed in this checkout.

## Proposed implementation

### 1. Verify MediaFire's supported account-download path

Before committing its credential form, prove the following against the current
service using a small public test file **outside the downloading account**:

1. Authenticate through the official API and confirm the account identity.
2. Request a direct URL for the public file and download it successfully.
3. Compare free and premium behavior, including permission failures and expired
   sessions. Record which account features actually affect these downloads.

The documented route uses `user/get_session_token.php`, an application ID, and a
login signature; the application's configuration determines whether a developer
API key is required. The official documentation is partly historical: the 1.5
getting-started page links to 1.1 method pages. Verify current 1.5 behavior rather
than assuming every old detail still applies.
[Authentication documentation](https://www.mediafire.com/developers/core_api/1.1/user/#get_session_token),
[application setup](https://www.mediafire.com/developers/core_api/1.5/getting_started/).

`file/get_links.php` with `link_type=direct_download` accepts a session token but
can return bandwidth or permission errors for individual files. Successful login
alone does not establish that GetComics links can use account benefits.
[File link documentation](https://www.mediafire.com/developers/core_api/1.1/file/#get_links).

Prefer this API route if the experiment succeeds. If a website login is needed,
first verify its supported login flow and cookie behavior; use a proper cookie
jar. Do not reinterpret an arbitrary API key as a browser cookie. If neither
route supports the required public downloads, document the limitation and keep
MediaFire anonymous while delivering MEGA support.

### 2. Add shared account and session handling

Add typed account helpers under `src/lib/hosters/` and replace the touched `any`
account parameters with a shared type.

- Select active accounts deterministically using `createdAt`, then `id`. The
  current UI creates one account per hoster; retain that scope and document which
  account wins if legacy data contains duplicates. Account rotation can follow
  separately.
- Decrypt into a local copy. Put lookup/decryption inside the resolver's error
  boundary so an unreadable secret produces a controlled failure.
- Cache provider sessions in process memory by account ID and `updatedAt`.
  Share one pending login promise across simultaneous requests for that account.
  Bound cache lifetime and discard failed promises.
- Re-read the account on each resolution so edits, deletion, or disabling apply
  to the next download. Retire replaced sessions safely after their active
  streams finish. Never put session IDs in Redis job payloads or browser config.
- Add error categories for invalid credentials, expired session, quota/rate
  limit, broken link, and temporary provider failure. Do not infer premium status
  simply from the presence of an account.

With no active account, retain anonymous downloads. For rejected credentials,
report the account problem and allow one anonymous fallback. For an expired
session, renew/re-login once. For exhausted bandwidth, try the next configured
hoster without looping through repeated logins. Account tests must report failed
authentication even if anonymous access would work.

### 3. Implement authenticated MEGA resolution

Use `Storage` from `megajs` with email/password, `autoload: false`, and
`keepalive: false`. Await `storage.ready`, then create the shared file with
`File.fromURL(url, { api: storage.api })`. This is a supported way to apply account
limits to a public link; it does not require importing the file into Cloud Drive.
[MEGAJS API reference](https://mega.js.org/docs/1.0/api).

Preserve the public link's decryption key and the existing Node streaming path.
Keep the current largest-archive selection for folder links in this feature.

Two details need explicit coverage:

- In 1.3.10, children created by `loadAttributes()` do not automatically inherit
  the root's API object. Attach the authenticated API to the selected child before
  downloading. Cover a URL that points directly to a file within a shared folder
  and use the node returned by `loadAttributes()` when appropriate.
- Classify failures at stream time as well as during resolution. The SDK reports
  expired sessions and quota errors through its API, and HTTP 509 through the
  download stream. Preserve cleanup, progress, the stall watchdog, and import
  behavior when adding bounded retries.

Initially return a clear message for accounts requiring MFA; do not store a
short-lived MFA code as a permanent password or API key. Interactive MFA/session
enrollment is a separate extension.

### 4. Implement MediaFire resolution from the verified route

After step 1 succeeds, replace the `Cookie: session=<apiKey>` shortcut with the
verified login/token flow. Extract the public file's quick key, request its direct
URL with the authenticated session, and return the result through the existing
HTTP streaming contract.

If the API route requires administrator-supplied application credentials, add
`applicationId String?` to `HosterAccount` and use `apiKey` explicitly as the
developer application key. Update Prisma synchronization, config types, backup
and restore coverage, and forms together. Existing MediaFire `apiKey` values must
not be silently treated as valid application keys or sessions.

Honor the verified token lifetime and renewal behavior. If choosing a token
format with mutable signing state, serialize calls that update that state.
Parse per-file errors even when the top-level API response reports success.

Keep anonymous resolution as a fallback and handle the page variants observed in
Kapowarr: redirect script, normal button URL, and `data-scrambled-url`. Validate
resolved URLs. Pass only headers genuinely needed by the download endpoint; keep
login secrets/tokens away from unrelated redirect destinations. If cookies are
required for streaming, constrain their host scope across the Node/Rust boundary.

### 5. Align forms, account tests, and retry routing

Use a shared hoster credential form in Setup and Settings:

- MEGA: **Email** and **Password**, mapped to existing fields.
- MediaFire: fields required by the verified authentication route.
- Pixeldrain and Anna's Archive: retain API-key configuration.

Add edit, enable/disable, and **Test Account** actions. Tests go through the
existing admin-test authorization pattern, with saved masked secrets resolved by
account ID **and** hoster. Test unsaved values without persisting them, reject
partial credentials, and distinguish authentication success from premium status
or public-file download eligibility. Keep network validation outside database
transactions and bound its timeout.

Replace claims about bypassing limits with provider-specific descriptions of
using the account's available allowance. Preserve user-configured hoster order.

At `downloadDirectFile`, infer a missing hoster from a parsed, recognized hostname
so both cron retries and manual direct-link retries use the same resolver as the
initial download. Distinguish provider landing pages from already resolved CDN
URLs. Honor hoster enablement on retries; use exact domains/subdomains rather than
substring matching. Keep the original public URL for retrying expired download
URLs and preserve existing candidate fallback and request-status behavior.

## Verification and delivery

Implement in three reviewable changes: shared account handling plus retry routing;
MEGA authentication plus forms/account tests; then verified MediaFire support.

Meaningful automated coverage should establish:

1. No account and disabled accounts retain anonymous behavior; encrypted saved
   secrets decrypt correctly; masked edits preserve secrets and explicit clearing
   removes them. Login errors and logs never expose secrets or MEGA URL keys.
2. MEGA file and folder streams use the authenticated API; simultaneous requests
   share one login; edited credentials invalidate reuse; expired sessions retry
   once; quota/MFA errors have the expected fallback behavior.
3. MediaFire login, expiry, per-file permission/quota errors, and anonymous page
   variants work using captured fixtures from the verified integration.
4. Settings and Setup render the same fields; account testing enforces the
   existing authorization rules and never mistakes anonymous access for valid
   credentials.
5. Initial, manual, and cron downloads all resolve the provider and respect its
   enabled state. Stream failures remove partial files and leave requests in a
   recoverable state; a failed hoster still permits the next candidate.

Run targeted Vitest suites, TypeScript checks, and lint for implementation changes.
Run engine tests if header/redirect handling changes in Rust. Finish with opt-in
live checks against small public files using free/premium accounts, including a
file outside the MediaFire downloading account. Verify identity/session use, file
integrity, and a complete request-to-import cycle; speed alone is not evidence
that account authentication worked.

MEGA is ready for implementation based on the existing SDK. MediaFire's public
download eligibility and application-registration requirements remain the main
open integration questions. Session caching is per process; a multi-instance
deployment may log in separately on each Node instance.
