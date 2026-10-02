#!/bin/sh
set -eu

[ "$#" -eq 2 ] || { echo "Expected a source catalog and plugin output directory" >&2; exit 1; }
source_catalog=$1
compiled_catalog=$2
[ -f "$source_catalog" ] || { echo "String catalog is missing: $source_catalog" >&2; exit 1; }
case "$compiled_catalog" in
  */CompiledCatalog) ;;
  *) echo "Expected the plugin's CompiledCatalog directory" >&2; exit 1 ;;
esac
# Remove only the generated plugin directory so removed locales/plural tables cannot linger.
/bin/rm -rf "$compiled_catalog"
/bin/mkdir -p "$compiled_catalog"
/usr/bin/xcrun xcstringstool compile "$source_catalog" --output-directory "$compiled_catalog"
