# FlowsToken Desktop — security requirements

## Non-negotiables

1. **No baked-in secrets** — never commit API keys, tokens, or cookies. Keys live in the OS credential store / Electron `safeStorage` path Vetta already uses.
2. **No plugin marketplace by default** — do not register `openvetta/vetta-official-marketplace` or any auto-updating GitHub ability source in FlowsToken builds. MCP/skills may be added manually by the user with eyes open.
3. **No auto-approve in production** — `VETTA_DEV_AUTO_APPROVE_ACTIONS` is for local iteration only; shipping builds must require tool/browser confirmations.
4. **Browser / payment** — destructive or money-moving actions require explicit confirmation.
5. **Transport** — default API base is HTTPS `https://www.flowstoken.com/v1` only.
6. **Data isolation** — prefer `VETTA_HOME=~/.flowstoken-desktop` so FlowsToken data is not mixed with a stock Vetta profile.
7. **Upstream patches** — merge Open Vetta security fixes promptly (`UPSTREAM.md`).
8. **macOS shipping** — unsigned builds are OK for internal smoke; public download should move to Developer ID + notarization.

## Threat notes

- Marketplace auto-update is a supply-chain surface; disabling builtin marketplace is intentional.
- A compromised API key only affects the user’s FlowsToken balance/quota — still treat vault access as sensitive.
- Do not proxy arbitrary URLs through the desktop main process without allowlisting.
