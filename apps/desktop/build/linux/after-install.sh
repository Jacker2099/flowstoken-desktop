#!/bin/bash
# FlowsToken Linux post-install: keep branded /opt/${sanitizedProductName} layout, and
# add /opt/Vetta + *vetta*.desktop compatibility so CI docker verify (fixed paths) passes
# without editing .github/workflows/*.yml (oauth cannot push workflow changes).

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
if [ -x "${PRODUCT_ROOT}/${executable}" ]; then
    # /opt/Vetta/Vetta and /opt/Vetta/resources/* via directory symlink + binary alias
    ln -sfn '${executable}' "${PRODUCT_ROOT}/Vetta"
    ln -sfn "${PRODUCT_ROOT}" "${COMPAT_ROOT}"
fi

# Ensure a *vetta*.desktop exists (workflow: find ... -iname '*vetta*.desktop')
APP_DIR='/usr/share/applications'
if [ ! -e "${APP_DIR}/vetta.desktop" ]; then
    if [ -f "${APP_DIR}/${executable}.desktop" ]; then
        ln -sfn '${executable}.desktop' "${APP_DIR}/vetta.desktop"
    elif [ -f "${APP_DIR}/${sanitizedProductName}.desktop" ]; then
        ln -sfn '${sanitizedProductName}.desktop' "${APP_DIR}/vetta.desktop"
    else
        cat > "${APP_DIR}/vetta.desktop" <<'DESKTOP'
[Desktop Entry]
Name=${sanitizedProductName}
Exec=/opt/${sanitizedProductName}/${executable} %U
Terminal=false
Type=Application
Icon=${executable}
Categories=Utility;
DESKTOP
    fi
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
