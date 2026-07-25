# PostHog Desktop

An Electron app that runs the PostHog frontend natively, straight from this repo's build output, against PostHog Cloud (US or EU) or any self-hosted instance.

## How it works

```text
┌────────────────────────── Electron ───────────────────────────┐
│                                                                │
│  Renderer (sandboxed)                Main process              │
│  ┌──────────────────────┐            ┌──────────────────────┐  │
│  │ PostHog frontend SPA │  /static ▶ │ Local loopback server│  │
│  │ (frontend/dist,      │  /api    ▶ │  · serves dist       │  │
│  │  loaded from         │            │  · proxies API to    │──┼──▶ us/eu.posthog.com
│  │  http://127.0.0.1:*) │            │    cloud + bearer key│  │    (or custom host)
│  └──────────────────────┘            │  · offline cache     │  │
│  ┌──────────────────────┐            └──────────────────────┘  │
│  │ Shell UI (sign-in,   │  IPC ────▶ settings, sign-in,        │
│  │ region, settings)    │            safeStorage secrets       │
│  └──────────────────────┘                                      │
└────────────────────────────────────────────────────────────────┘
```

- The main process runs a loopback HTTP server that plays Django's role locally: it serves the built frontend (`frontend/dist`) and a generated `index.html` without `POSTHOG_APP_CONTEXT`, so the app bootstraps itself from `/_preflight/` and `/api/users/@me/`.
- Backend paths (`/api/`, `/_preflight`, `/uploaded_media/`, ...) are proxied to the configured cloud region with the stored credentials attached. Credentials are encrypted at rest with Electron `safeStorage` and never reach the renderer.
- The app shell, all static assets, and the settings UI work with no internet connection. Key bootstrap responses are cached on disk and served stale when the cloud is unreachable.

## Signing in

Three methods exist, and only the first reaches the whole product.

**Session sign-in (default).** "Sign in" opens a window on `{host}/login` in its own persisted partition, and the user signs in normally: password, Google, SAML and 2FA all work, because it is a real Chromium hitting the real site. Once a session cookie is present that `/api/users/@me/` accepts, the cookies are read out of the partition ([`browser-login.ts`](./src/main/browser-login.ts)) and the proxy replays them upstream from then on, exactly as a browser would. That means it also sends `X-CSRFToken` and an `Origin` matching the upstream host on unsafe methods, captures `Set-Cookie` so a rotated session key is not lost, and reuses the user agent the session was created under so the requests do not look like a different device to PostHog's session-risk scoring. A redirect to `/login` is treated as an expired session and drops back to this shell. Signing out, from this shell or from inside the app, revokes the session upstream and clears the partition.

This reaches everything the website reaches, which is everything the app needs. It is not literally every endpoint: scopes in `INTERNAL_API_SCOPE_OBJECTS` are denied to session auth too (`posthog/permissions.py`), by design, since those are programmatic-only.

Two limits are worth knowing. Credentials go only to the Django-backed prefixes (`needsCredentials` in [`server/backend.ts`](./src/main/server/backend.ts)); the capture and static paths authenticate with the project token in the payload and never see the cookie. And the loopback server rejects requests carrying a foreign `Origin` or `Sec-Fetch-Site: cross-site`, because it cannot otherwise tell the app's own requests from a page open in the user's ordinary browser, and it answers by minting a first-party request upstream. That closes the browser vector; a local process running as the same user is outside the threat model either way, since it can already read the app's storage.

Google is the exception. Google refuses to complete a sign-in in a browser window embedded in an app, and that check is deliberate: an embedding app can read what you type. The app does not try to defeat it, so a Google-only account has to set a password (via "Forgot password?") or use another provider. The sign-in screen says so.

**Bearer sign-in (OAuth browser flow, or a pasted personal API key).** Both authenticate with a bearer token, and tokens cannot reach all of the API no matter how broad their scopes are. `APIScopePermission` denies any request whose required scope it cannot derive, and `*` does not override that. Two cases produce it:

- viewsets marked `scope_object = "INTERNAL"` (billing, search, tags, notifications, Max's core memory, the SQL editor's tab state, and others), and
- custom DRF `@action` methods whose name is not listed in the viewset's `scope_object_read_actions` / `scope_object_write_actions`.

The second case includes `QueryViewSet.create_with_kind`, which is where the frontend sends every query, so a bearer-authenticated app would lose insights, replay, web analytics and error tracking wholesale. The proxy works around that one specific case by dropping the query-kind path segment (`rewriteBearerPath` in [`server/backend.ts`](./src/main/server/backend.ts)); the kind-less endpoint runs identical code. The rest have no client-side workaround, so bearer sign-in stays a fallback and the shell says what will not load.

## Running it

```bash
# 1. Build the PostHog frontend (once, and after frontend changes)
pnpm turbo build --filter=@posthog/frontend

# 2. Start the desktop app (downloads the Electron binary on first run)
pnpm --filter=@posthog/desktop start
```

Choose a region (US Cloud, EU Cloud, or a custom host) and click "Sign in". See [Signing in](#signing-in) above for what that does and why the alternatives under "Other ways to sign in" are limited.

Both bearer options remain available: the OAuth browser flow opens PostHog's consent screen in your system browser and stores the refresh token encrypted with `safeStorage`, refreshing access tokens before they expire; or paste a personal API key created under Settings › Personal API keys. The OAuth flow registers this install as its own public PKCE client on first use (RFC 7591 dynamic client registration at `/oauth/register`), caching the returned client id per host, so it works against any instance including self-hosted. `POSTHOG_DESKTOP_OAUTH_CLIENT_ID` overrides that with a hand-registered app.

## Access control

PostHog's frontend gates scenes, buttons and panels on `resource_access_control`, and it fails closed: with no level for a resource it treats you as having none. Those maps only ever come from Django's server-rendered app context, and no API serves them, so an app that bootstraps from the API alone had every gated surface denied. The local server therefore synthesizes just that part of `POSTHOG_APP_CONTEXT` from the organization membership level captured at sign-in ([`server/access-context.ts`](./src/main/server/access-context.ts)); everything else stays absent so the API bootstrap is unchanged. It is UI-only, since the server re-checks each of these, and it is optimistic for RBAC-restricted members, who may see a control whose request is then refused.

## Development

```bash
pnpm --filter=@posthog/desktop typecheck
pnpm --filter=@posthog/desktop test        # node:test, no Electron needed
pnpm --filter=@posthog/desktop build       # bundle main/preload/shell with esbuild
```

`POSTHOG_DESKTOP_FRONTEND_DIST=/path/to/dist` overrides where the frontend build is loaded from.

## Packaging

```bash
# Build the frontend first (see above), then:
pnpm --filter=@posthog/desktop package
```

This bundles the app with [electron-builder](https://www.electron.build/) (config in `electron-builder.yml`) into `release/`:
the built frontend is embedded as the `frontend-dist` resource (sourcemaps stripped), so the packaged app is fully self-contained.

Local and PR builds are unsigned: `scripts/after-pack.cjs` applies an ad-hoc signature, which is required for the app to launch on Apple Silicon at all.
Because of that, macOS quarantines a downloaded unsigned app.
To open it: right-click the app › Open, or run `xattr -d com.apple.quarantine /Applications/PostHog.app`.

CI builds installers for every PR that touches `products/desktop/` (`.github/workflows/build-desktop-app.yml`):
the frontend is built once on Linux and shared as an artifact, then per-OS jobs package it and upload the macOS DMG (`posthog-desktop-macos-arm64`) and the Windows NSIS installer (`posthog-desktop-windows-x64`) as workflow-run artifacts.
On master pushes and manual dispatches, the macOS build is signed with the PostHog Inc. Developer ID certificate and notarized — the same org secrets PostHog Code releases with (`APPLE_CODESIGN_CERT_BASE64`, `APPLE_CODESIGN_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) — so that DMG opens without any quarantine workarounds.
If the secrets are absent the non-PR build degrades to unsigned rather than failing.
The Windows installer is always unsigned for now (no Windows code-signing cert), so SmartScreen warns on first run: "More info" › "Run anyway".

## Fork: daily sync and releases

Actual desktop releases are published from the fork `mariusandra/posthog`, where the `desktop` branch (the fork's default branch) is upstream master plus the desktop work.
The upstream PostHog/posthog repo intentionally carries no desktop release secrets and publishes nothing; the two workflows below are gated to the fork (`if: github.repository == 'mariusandra/posthog'`) and are inert upstream.

- `desktop-sync.yml` merges two upstream sources into `desktop` daily — PostHog master (keeps the app current) and the open desktop PR branch `posthog-code/desktop-electron-app` (ongoing desktop dev, skipped once that PR merges) — with the OpenAI Codex CLI resolving conflicts and merge fallout following the `syncing-desktop-fork` skill (`.agents/skills/syncing-desktop-fork/SKILL.md`). Sync is one-directional (PR branch and master flow into the fork, not back). Only desktop tests (and frontend typecheck when relevant) gate the sync — backend and e2e suites are deliberately not run on the fork.
- `desktop-release.yml` runs after each sync (and on pushes to `desktop`): if `version` in `products/desktop/package.json` has no `desktop-v<version>` release yet, it builds the signed + notarized macOS DMG and the Windows installer on GitHub-hosted runners and publishes them as a GitHub release on the fork. Bumping the version field is the release trigger.

Fork setup (one-time): enable Actions on the fork, enable the two workflows (scheduled workflows in forks start disabled), and add the repository secrets `OPENAI_API_KEY` (sync), `APPLE_CODESIGN_CERT_BASE64`, `APPLE_CODESIGN_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (release signing + notarization).

Each release publishes its assets under stable, version-less names (`PostHog-Desktop-macos-arm64.dmg`, `PostHog-Desktop-windows-x64-setup.exe`) so `https://github.com/mariusandra/posthog/releases/latest/download/<name>` always points at the newest build.

## Auto-updates

Installed apps update themselves via `electron-updater` (`src/main/updates.ts`).
The feed is the latest release's assets: the `publish` config in `electron-builder.yml` points at `releases/latest/download` as a generic provider (electron-updater's github provider only understands `v<version>` tags, not `desktop-v<version>`), and `desktop-release.yml` uploads `latest-mac.yml` / `latest.yml`, the macOS update zip (Squirrel.Mac cannot update from a dmg), and the blockmaps alongside the installers.
The app checks shortly after launch and every four hours, downloads in the background, and installs on quit; a downloaded update also offers a one-time "Restart now" prompt, and Help → "Check for updates…" runs a check on demand.
Updates only run in the packaged app (dev builds have no `app-update.yml`, and macOS requires the running app and the update to be Developer ID signed); set `POSTHOG_DESKTOP_DISABLE_UPDATES=1` to turn them off in a packaged build.

## Landing page

[`website/`](./website) is the static landing page for `posthogondesktop.com` — a single `index.html` plus a screenshot and icon, no build step. Its download buttons use the stable latest-release links above. See [website/README.md](./website/README.md) for the Cloudflare Pages setup (output directory `products/desktop/website`).

See [TODO.md](./TODO.md) for what's done and what's next.
