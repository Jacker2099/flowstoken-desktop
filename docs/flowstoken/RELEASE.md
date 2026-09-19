# FlowsToken Desktop — multi-platform release

Align with upstream Open Vetta `desktop-release` workflow.

## Platforms (ship together)

| OS | Upstream command (matrix) | Typical artifacts |
|----|---------------------------|-------------------|
| Windows | `dist:win` | Inno / MSI / zip / portable |
| macOS | `dist:mac:arm64`, `dist:mac:x64` | dmg / zip |
| Linux | `dist:linux` | AppImage / deb / rpm / tar.gz |

## Edition

Always **opensource / lite**: `VETTA_CLOUD_ENABLED=false`.  
Disable builtin marketplace: `VETTA_DISABLE_BUILTIN_MARKETPLACE=1`.  
Brand: `VETTA_PRODUCT_NAME=FlowsToken`, `VETTA_APP_ID=com.flowstoken.desktop`.

## How to run

1. Push overlay branch / merge to `main`.
2. GitHub → Actions → **desktop-release** → Run workflow  
   - `cloud_enabled` = `false`  
   - `release_target` = `github`  
   - leave marketplace empty  
3. Download artifacts from the run (dispatch) or from the GitHub Release (after tagging `v*`).
4. Wire public URLs on https://www.flowstoken.com/desktop when ready.

## Upstream sync

After `git merge upstream/dev`, re-check this workflow still exists and that FlowsToken env overrides still apply. Prefer upstream fixes for Electron packaging/security.
