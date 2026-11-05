#!/bin/sh
# The Desktop Node kernel resolves relative imports only one directory deep, so the
# smoke harness runs against flat/ - a mechanical copy of functions/ where every
# import specifier is rewritten to ./<basename>. Behaviour is unchanged.
set -e
cd "$(dirname "$0")/.."
rm -rf dev-tools/flat
mkdir -p dev-tools/flat
for f in functions/*.mjs functions/lib/*.mjs functions/lib/dom/*.mjs; do
  cp "$f" dev-tools/flat/
done
perl -0pi -e "s{from '\.{1,2}/(?:lib/(?:dom/)?)?([^']+)'}{from './\$1'}g" dev-tools/flat/*.mjs
grep -c "from '\./" dev-tools/flat/routes.mjs
