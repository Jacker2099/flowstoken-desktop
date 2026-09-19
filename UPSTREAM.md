# Upstream sync (Open Vetta → FlowsToken Desktop)

This repository is a fork of [openvetta/open-vetta](https://github.com/openvetta/open-vetta) (Apache-2.0).

## Remotes

```bash
git remote -v
# origin   → Jacker2099/flowstoken-desktop
# upstream → openvetta/open-vetta
```

## Merge procedure

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
