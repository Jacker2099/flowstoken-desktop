#!/bin/bash
# Mirror electron-builder default after-remove, plus FlowsToken Vetta compat cleanup.

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
fi

rm -f '/usr/bin/${executable}' || true
rm -f /usr/share/applications/vetta.desktop || true
# Only remove /opt/Vetta when it is our symlink into the product root
if [ -L /opt/Vetta ]; then
    target="$(readlink /opt/Vetta || true)"
    if [ "$target" = '/opt/${sanitizedProductName}' ] || [ "$target" = '${sanitizedProductName}' ]; then
        rm -f /opt/Vetta || true
    fi
fi
rm -f '/opt/${sanitizedProductName}/Vetta' || true

APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_TARGET" ]; then
  rm -f "$APPARMOR_PROFILE_TARGET" || true
fi
