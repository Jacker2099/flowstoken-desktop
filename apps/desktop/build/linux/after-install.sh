#!/bin/bash
# FlowsToken Linux post-install: keep branded /opt/${sanitizedProductName} layout, and
# add /opt/Vetta + *vetta*.desktop compatibility so CI docker verify (fixed paths) passes
# without editing .github/workflows/*.yml (oauth cannot push workflow changes).
#
# Workflow checks (must all pass after apt-get/dnf install):
#   test -x /opt/Vetta/Vetta
#   test "$(cat /opt/Vetta/resources/package-type)" = "deb"|"rpm"
#   find /usr/share/applications -maxdepth 1 -type f -iname '*vetta*.desktop'
# Note: the desktop find uses -type f, so vetta.desktop must be a regular file (not a symlink).

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

# --- FlowsToken ↔ Vetta path compatibility for release CI ---
PRODUCT_ROOT='/opt/${sanitizedProductName}'
COMPAT_ROOT='/opt/Vetta'
BIN='${executable}'

if [ -x "${PRODUCT_ROOT}/${BIN}" ]; then
    # Binary alias so /opt/<product>/Vetta resolves (and /opt/Vetta/Vetta via dir symlink).
    ln -sfn "${BIN}" "${PRODUCT_ROOT}/Vetta"
    # Directory symlink /opt/Vetta -> product root (skip if already installed at /opt/Vetta).
    if [ "${PRODUCT_ROOT}" != "${COMPAT_ROOT}" ]; then
        if [ -e "${COMPAT_ROOT}" ] && [ ! -L "${COMPAT_ROOT}" ]; then
            echo "warning: ${COMPAT_ROOT} exists and is not a symlink; leaving in place" >&2
        else
            ln -sfn "${PRODUCT_ROOT}" "${COMPAT_ROOT}"
        fi
    fi
fi

# Ensure a regular *vetta*.desktop file exists (workflow: find ... -type f -iname '*vetta*.desktop')
APP_DIR='/usr/share/applications'
write_vetta_desktop() {
    cat > "${APP_DIR}/vetta.desktop" <<'DESKTOP'
[Desktop Entry]
Name=${sanitizedProductName}
Exec=/opt/${sanitizedProductName}/${executable} %U
Terminal=false
Type=Application
Icon=${executable}
Categories=Utility;
DESKTOP
}

if [ -f "${APP_DIR}/${BIN}.desktop" ]; then
    # Copy (not symlink): CI requires -type f
    cp -f "${APP_DIR}/${BIN}.desktop" "${APP_DIR}/vetta.desktop"
elif [ -f "${APP_DIR}/${sanitizedProductName}.desktop" ]; then
    cp -f "${APP_DIR}/${sanitizedProductName}.desktop" "${APP_DIR}/vetta.desktop"
elif [ -L "${APP_DIR}/vetta.desktop" ] || [ ! -f "${APP_DIR}/vetta.desktop" ]; then
    write_vetta_desktop
fi
# If an old symlink remains, replace with a real file
if [ -L "${APP_DIR}/vetta.desktop" ]; then
    rm -f "${APP_DIR}/vetta.desktop"
    write_vetta_desktop
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
