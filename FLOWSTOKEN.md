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

## Package (opensource / macOS)

```bash
export VETTA_CLOUD_ENABLED=false
export VETTA_DISABLE_BUILTIN_MARKETPLACE=1
export VETTA_PRODUCT_NAME=FlowsToken
export VETTA_APP_ID=com.flowstoken.desktop
export VETTA_UPDATE_GITHUB_OWNER=Jacker2099
export VETTA_UPDATE_GITHUB_REPO=flowstoken-desktop
# leave VETTA_OPEN_MARKETPLACE_REPOSITORY unset/empty with disable flag
cd apps/desktop && bun run dist:opensource
```

## Wire providers

See `branding/flowstoken/SETUP.md`.
