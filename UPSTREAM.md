# Upstream sync (Open Vetta → FlowsToken Desktop)

This repository is a fork of [openvetta/open-vetta](https://github.com/openvetta/open-vetta) (Apache-2.0).

## Remotes

```bash
git remote -v
# origin   → Jacker2099/flowstoken-desktop
# upstream → openvetta/open-vetta
```

## Automatic sync (2026-09-23)

Everything below is automated; the manual procedure remains as the fallback.

| Piece | What it does |
|------|---------|
| `.github/workflows/flowstoken-upstream-sync.yml` | Daily 10:17 Beijing (or manual): if Open Vetta has a new **release** tag not in `branding/flowstoken/UPSTREAM_SYNCED`, merge it (`merge.conflictStyle=diff3`), resolve conflicts with `scripts/flowstoken/resolve-upstream-conflicts.mjs`, bump the FlowsToken patch version, write `.github/release-notes/v<ver>.md`, run brand guard + release-notes check + `bun run check` + `test:quality` + `test:packaging` + `test:changed`, push `main`, then dispatch `flowstoken-release`. Any refusal/failure: nothing ships, the attempt goes to branch `upstream-sync/<tag>` and an issue labelled `upstream-sync` is opened (server forwards it to Telegram). |
| `.github/workflows/flowstoken-release.yml` | Tags `v<version>` (GITHUB_TOKEN push, so upstream's tag-triggered release does not fire), runs upstream `desktop-release` as a non-publishing dispatch (all platforms, unsigned macOS allowed), downloads the artifacts, merges macOS metadata, publishes the GitHub Release and verifies its feed. |
| `branding/flowstoken/tests/*.test.mjs` | Brand guard: FlowsToken branding, self-hosted update feed, account login/key sync wiring, the four group presets, Bestoo AI identity, marketplace off. Run `node --test branding/flowstoken/tests/*.test.mjs`. |
| Server `ft-desktop-release-sync.py` (flowstoken-deploy, every 10 min) | Mirrors a newer GitHub Release into `www.flowstoken.com/downloads/desktop` after size+sha512 checks (feeds last), keeps current+previous, updates desktop.html/install.sh versions and the Aliyun drive, Telegram. |

Conflict rules: `*.json` 3-way key merge (keys FlowsToken changed keep ours — this is how our version survives), release notes keep ours, `bun.lock` takes upstream then `bun install`, text hunks where both sides only appended keep both; everything else stops the sync.

To keep future syncs automatic, **add FlowsToken code in new files** (`branding/flowstoken/**`, `apps/desktop/src/main/flowstoken/**`, new `*.test.ts`) and keep edits to upstream files to one-line hooks. Never add FlowsToken tests to upstream test lists in `package.json`; put them under `branding/flowstoken/tests/`.

Versioning: FlowsToken has its own version line from 0.6.0 (upstream was at 0.5.59); upstream tags are fetched as `upstream/<tag>` so they never collide with ours.

## Merge procedure (manual fallback)

```bash
git fetch upstream
git checkout main   # or your release branch
git merge upstream/dev   # prefer upstream/dev when that is their integration branch
# resolve conflicts preferring:
#   - upstream for core runtime/security fixes
#   - our side for branding/flowstoken/** and documented FT patches (see below)
bun install
bun run check:quick   # or the project’s current quick check
```

## FlowsToken overlay boundary

**Keep additive when possible:**

| Path | Purpose |
|------|---------|
| `branding/flowstoken/` | Product presets, security policy, provider templates |
| `docs/flowstoken/` | Operator docs |
| `UPSTREAM.md` / root `FLOWSTOKEN.md` | Sync + product notes |

**Documented core touches (re-apply after merge if needed):**

1. `apps/desktop/src/main/abilities/open-marketplace/marketplace-source-store.ts` — empty / disabled marketplace must **not** fall back to Vetta official GitHub marketplace (supply-chain).
2. `apps/desktop/scripts/prepare-pack.js` — optional `VETTA_PRODUCT_NAME` / `VETTA_APP_ID` env overrides for packaging brand.

Do not enable `VETTA_CLOUD_ENABLED=true` (Vetta Serv). FlowsToken uses its own API.

## Preserve FlowsToken integrations (mandatory)

When merging `upstream`, **never drop** FlowsToken product layers. Prefer ours on conflict for:

- `branding/flowstoken/**`, `docs/flowstoken/**`, `FLOWSTOKEN.md`
- `apps/desktop/src/main/models/presets/flowstoken-presets.ts` and its wiring in `catalog.ts`
- Marketplace hardened off (`VETTA_DISABLE_BUILTIN_MARKETPLACE` / empty builtin source)
- Packaging brand env overrides (`VETTA_PRODUCT_NAME`, `VETTA_APP_ID`, …) in `prepare-pack.js` / build-env / vite defines
- Security bar: no baked secrets, no auto-approve in prod, HTTPS to flowstoken.com

Upstream wins for unrelated Electron/runtime/security fixes outside this list. After merge, re-run a quick smoke: presets still list 普通/智能/官方, marketplace stays off, brand env still packs as FlowsToken.

## Security sync

Always prefer upstream patches for Electron, credential vault, permission prompts, and dependency CVEs. After merge, re-verify:

- builtin marketplace stays off for FlowsToken builds
- `VETTA_DEV_AUTO_APPROVE_ACTIONS` is not set in production packaging
- no secrets in the repo or binary

## FlowsToken account overlay (preserve)

Additive modules under `apps/desktop/src/main/flowstoken/` + settings tab `flowstoken`:

- NewAPI session login (Turnstile / browser window)
- Auto create/reuse tokens for groups `default` / `smart` / `vip`
- Wire providers `flowstoken-default|smart|official` via model settings vault
- Balance + usage panel (Chinese UI)

Do not re-enable Vetta Serv (`VETTA_CLOUD_ENABLED=false`). Prefer ours on conflict for these paths and `branding/flowstoken/**`.
