# FlowsToken Desktop

Branded desktop client on Open Vetta **lite** (serv-less). Public site download page: https://www.flowstoken.com/desktop

## Product

- Account → API keys for **普通 / 智能 (`bestoo-auto`) / 官方** (account login wiring is staged; BYOK presets first)
- Keep: files, terminal, browser (confirm submit/payment), sessions, skills, MCP self-config
- **No plugin marketplace** by default (security)
- API base: `https://www.flowstoken.com/v1`
- 「官方」= vendor GPT/Claude only — never Vercel/Fireworks in UI copy

## Security bar

See `branding/flowstoken/SECURITY.md`.

## Dev (Mac)

```bash
cd ~/src/flowstoken-desktop
bun install
export VETTA_CLOUD_ENABLED=false
export VETTA_HOME="$HOME/.flowstoken-desktop"   # isolate from ~/.vetta
export VETTA_DISABLE_BUILTIN_MARKETPLACE=1
# never export VETTA_DEV_AUTO_APPROVE_ACTIONS=1 for anything you treat as “real”
cd apps/desktop && bun run dev
```

## Package (opensource — macOS + Windows + Linux)

Ship **all three** platforms together, same path as Open Vetta upstream.

### Local (current OS only)

```bash
export VETTA_CLOUD_ENABLED=false
export VETTA_DISABLE_BUILTIN_MARKETPLACE=1
export VETTA_PRODUCT_NAME=FlowsToken
export VETTA_APP_ID=com.flowstoken.desktop
export VETTA_EXECUTABLE_NAME=FlowsToken
export VETTA_UPDATE_PROVIDER=github
export VETTA_UPDATE_GITHUB_OWNER=Jacker2099
export VETTA_UPDATE_GITHUB_REPO=flowstoken-desktop
cd apps/desktop && bun run dist:opensource
```

### CI (recommended — mirrors upstream)

Use `.github/workflows/desktop-release.yml` (forked from Open Vetta):

1. Repo Variables (Settings → Variables): keep open-source defaults; set  
   `VETTA_UPDATE_GITHUB_OWNER=Jacker2099`  
   `VETTA_UPDATE_GITHUB_REPO=flowstoken-desktop`  
   and ensure marketplace stays off via `VETTA_DISABLE_BUILTIN_MARKETPLACE=1` in the workflow env / Environment.
2. `workflow_dispatch` builds **win + mac-arm64 + mac-x64 + linux** artifacts (no secrets in the form).
3. Tag `v*` publishes to **GitHub Releases** when `VETTA_RELEASE_TARGET=github` (upstream default for forks).

Do **not** enable `VETTA_CLOUD_ENABLED=true` / Vetta Serv. Prefer unsigned first smoke; add Apple/Windows signing later without changing product scope.

## Wire providers

See `branding/flowstoken/SETUP.md`.

## Releases

See [docs/flowstoken/RELEASE.md](docs/flowstoken/RELEASE.md) for macOS + Windows + Linux.
