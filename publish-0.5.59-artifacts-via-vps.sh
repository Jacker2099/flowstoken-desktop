#!/usr/bin/env bash
# Run ON Mac after CI artifacts exist. Downloads via VPS (ssh ft) using gh token curl — not local gh run download.
set -euo pipefail
unset GITHUB_TOKEN
REPO=Jacker2099/flowstoken-desktop
VER=0.5.59
RUN_ID="${1:?usage: $0 <run-id>}"
TOKEN="$(gh auth token)"
API="https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/artifacts"

echo "== artifacts =="
curl -fsSL -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" "$API" | tee /tmp/ft-arts.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(str(a.get("id")) + "\t" + str(a.get("name")) + "\t" + str(a.get("size_in_bytes")) for a in d.get("artifacts", [])))'

publish_one() {
  local name="$1" pattern="$2"
  local id
  id="$(python3 - "$name" <<'PY'
import json,sys
name=sys.argv[1]
arts=json.load(open("/tmp/ft-arts.json"))["artifacts"]
m=[a for a in arts if a["name"]==name]
print(m[0]["id"] if m else "")
PY
)"
  if [[ -z "$id" ]]; then
    echo "SKIP missing artifact $name"
    return 0
  fi
  echo "Publish $name id=$id"
  ssh -F ~/.ssh/config ft "set -euo pipefail
    TMP=\$(mktemp -d -p /var/tmp)
    cd \"\$TMP\"
    curl -fsSL -H 'Authorization: Bearer ${TOKEN}' -H 'Accept: application/vnd.github+json' \
      -L 'https://api.github.com/repos/${REPO}/actions/artifacts/${id}/zip' -o art.zip
    unzip -o art.zip
    mkdir -p /var/www/flowstoken/downloads/desktop
    # copy matching installers
    find . -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.zip' \) -print
    find . -type f \( -name '*.dmg' -o -name '*win*.exe' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name 'latest*.yml' -o -name '*.blockmap' \) \
      -exec cp -f {} /var/www/flowstoken/downloads/desktop/ \;
    rm -rf \"\$TMP\"
    ls -lah /var/www/flowstoken/downloads/desktop/ | grep ${VER} || true
  "
}

publish_one desktop-macos-arm64 "*.dmg"
publish_one desktop-macos-x64 "*.dmg"
publish_one desktop-windows "*win*.exe"
publish_one desktop-linux "*.AppImage"

# Update desktop.html
ssh -F ~/.ssh/config ft 'python3 -' <<'PY'
from pathlib import Path
import re
p = Path("/var/www/flowstoken/desktop.html")
t = p.read_text(encoding="utf-8")
t = t.replace("0.5.58", "0.5.59")
# intro
t = re.sub(
    r"(<p>)macOS、Windows、Linux 安装包已就绪.*?(</p>)",
    r"\1macOS、Windows、Linux 安装包已就绪，版本 <strong>0.5.59</strong>。\2",
    t,
    count=1,
)
t = re.sub(r"（[^）]*Open Vetta[^）]*）", "", t)
# platform links → 0.5.59 (common patterns)
t = re.sub(r"FlowsToken-0\.5\.\d+-arm64\.dmg", "FlowsToken-0.5.59-arm64.dmg", t)
t = re.sub(r"FlowsToken-0\.5\.\d+(?!-arm64)\.dmg", "FlowsToken-0.5.59.dmg", t)
t = re.sub(r"FlowsToken-0\.5\.\d+-win-x64\.exe", "FlowsToken-0.5.59-win-x64.exe", t)
t = re.sub(r"FlowsToken-0\.5\.\d+\.AppImage", "FlowsToken-0.5.59.AppImage", t)
t = re.sub(r"FlowsToken_0\.5\.\d+_amd64\.deb", "FlowsToken_0.5.59_amd64.deb", t)
t = re.sub(r"FlowsToken-0\.5\.\d+\.x86_64\.rpm", "FlowsToken-0.5.59.x86_64.rpm", t)
# footer simplify once all three present
t = re.sub(r"当前版本[^<]*", "当前版本 0.5.59", t, count=1)
p.write_text(t, encoding="utf-8")
print("updated", p)
for line in t.splitlines():
    if "安装包已就绪" in line or "当前版本" in line:
        print(line)
PY

echo "== public checks =="
for u in \
  "https://www.flowstoken.com/desktop.html" \
  "https://www.flowstoken.com/downloads/desktop/FlowsToken-${VER}-arm64.dmg" \
  "https://www.flowstoken.com/downloads/desktop/FlowsToken-${VER}.dmg" \
  "https://www.flowstoken.com/downloads/desktop/FlowsToken-${VER}-win-x64.exe" \
  "https://www.flowstoken.com/downloads/desktop/FlowsToken-${VER}.AppImage"
 do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$u" || echo ERR)
  echo "$code $u"
done
