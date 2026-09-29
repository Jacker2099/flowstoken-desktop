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
| `.github/workflows/flowstoken-upstream-sync.yml` | Daily 10:17 Beijing (or manual): if Open Vetta has a new **release** tag not in `branding/flowstoken/UPSTREAM_SYNCED`, merge it (`merge.conflictStyle=diff3`), resolve conflicts with `scripts/flowstoken/resolve-upstream-conflicts.mjs`, bump the FlowsToken patch version, write `.github/release-notes/v<ver>.md`, run the gates, push `main`, then dispatch `flowstoken-release`. **Gates** = upstream's own release checks (`bun run check`, `test:quality`, `verify:desktop:contracts`, `test:desktop:packaging`, release notes) + the brand guard + `scripts/flowstoken/test-flowstoken-related.mjs` (every Vitest test that imports a FlowsToken-changed file, deps built like `test:pkg`, 30s timeout, 2 retries). Upstream's full affected-unit-test job is **not** a gate — upstream ships while it is red. Upstream test files that are red in upstream's own CI are listed in `branding/flowstoken/tests/upstream-known-failures.json` with reason/date (only after reproducing them with all FlowsToken files reverted); remove entries once upstream fixes them. Full check logs are uploaded as the `upstream-sync-checks` artifact. Any refusal/failure: nothing ships, the attempt goes to branch `upstream-sync/<tag>`; the FlowsToken server polls failed runs of both workflows and reports them to Telegram (repo issues are disabled, so the issue is best-effort). |
| `.github/workflows/flowstoken-release.yml` | Tags `v<version>` (GITHUB_TOKEN push, so upstream's tag-triggered release does not fire), runs upstream `desktop-release` as a non-publishing dispatch (all platforms; macOS signed with the FlowsToken Developer ID and notarized, and an unsigned macOS build is refused), checks the checkpoint commit/run/platform/version and file hashes, merges macOS metadata, verifies every platform feed and the exact asset set, uploads to a draft, verifies GitHub asset SHA-256 digests, then publishes the GitHub Release and verifies its feed. Manual one-click releases also run the FlowsToken-related unit gate. A tag already pointing to another commit is refused instead of being moved automatically. |
| `branding/flowstoken/tests/*.test.mjs` | Brand guard: FlowsToken branding, self-hosted update feed, account login/key sync wiring, the four group presets, Bestoo AI identity, marketplace off, macOS signing/notarization wiring (the six `MACOS_CERTIFICATE_*` / `APPLE_*` secrets upstream's `desktop-release` must keep reading). Run `node --test branding/flowstoken/tests/*.test.mjs`. |
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
3. `packages/theme-ui/src/chat/ModelSelectorView.tsx` — optional props `tabs` / `initialTab` / `vendorBarByTab` / `highlight` / `triggerBadge` and option fields `subtitle` / `vendorId` / `vendorIcon` / `vendorMono` (FlowsToken catalog-driven picker; absent props degrade to the plain upstream list).
4. `apps/desktop/src/renderer/shared/components/ModelSelect/ModelSelect.tsx` — same props-driven tab/vendor-segment rendering via `useFlowstokenPicker` (`domains/flowstoken/`).
5. `apps/desktop/src/renderer/domains/conversation/hooks/useModelSelectorModel.ts` — feeds the picker props above into `ModelSelectorView`.
6. `.github/workflows/desktop-release.yml` — build job `timeout-minutes: 270`, packaging step 240, and macOS signature/notarization verification before a completed checkpoint is uploaded. Failed macOS packaging/verification saves best-effort `failed-macos-*` diagnostics separately; these are not publishable checkpoints. `flowstoken-release` waits only for quality and four platform build gates (360 minutes), then publishes in a separate 60-minute job. Reuse requires the same workflow commit and matching version tag; an old run cannot bypass the new gate. The gap between job and step limits also covers setup and does not guarantee diagnostics survive a hard job timeout. This does not resume Apple submissions across runs.

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

## Release retry safety

A scheduled sync that already merged the latest upstream release checks whether the current FlowsToken version actually shipped. If it is still unpublished and no release for the same commit is running, it retries only `flowstoken-release`; it does not merge or bump the version again. Dispatch includes the checked commit SHA, so a concurrent `main` update cannot silently change the released source. Only published, non-prerelease `vX.Y.Z` upstream releases are accepted. The sync token is required before starting a merge; its effective write permissions are still verified by the actual GitHub push.

Every completed build checkpoint records the source commit, run, attempt, platform, version and SHA-256 hashes of downloadable files. The final `release-manifest.json` records the complete published file set. Publication validates metadata SHA-512 and size, both Mac architectures, all required package formats and supplemental Windows ZIP, then matches the draft's uploaded asset names, sizes and GitHub SHA-256 digests. Unexpected assets may be removed only while the target release remains a draft. Published releases are refused, and a source tag must remain unchanged through upload. A failed attempt is kept on a unique branch without force-pushing earlier evidence.
