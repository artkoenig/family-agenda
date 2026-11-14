#!/bin/sh
# Assembles the landing page into site/dist: the page in English and German (de/), the design system's stylesheets and its fonts.
set -eu
cd "$(dirname "$0")/.."

design=apps/api/src/http/design
fonts=node_modules/.pnpm/node_modules/@fontsource-variable
out=site/dist

rm -rf "$out"
mkdir -p "$out/fonts" "$out/de"
# The German page lives one folder down and reaches the shared files from there.
sed -E 's#(href|src)="(tokens\.css|design\.css|landing\.css|app-icon\.svg)"#\1="../\2"#g' site/index.de.html > "$out/de/index.html"
cp site/index.html site/landing.css docs/assets/app-icon.svg "$design/design.css" "$out/"
# The Instance serves its fonts from /static/fonts; the page keeps them next to itself, wherever it is hosted.
sed 's#/static/fonts/#fonts/#g' "$design/tokens.css" > "$out/tokens.css"
cp "$fonts"/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin*-wght-*.woff2 \
   "$fonts"/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin*-wght-normal.woff2 \
   "$out/fonts/"
echo "Landing page built in $out"
