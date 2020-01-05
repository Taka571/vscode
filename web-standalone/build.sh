#!/usr/bin/env sh

mkdir -p public/static/out public/static-extension

# copy out
cp -r ../out/ public/static/out/

# copy extensions
for ext in theme-defaults
do
	cp -r ../extensions/$ext/ public/static-extension/$ext/
	echo "Copy $ext"
done

# copy remote packages
mkdir -p public/remote
for pkg in onigasm-umd semver-umd vscode-textmate xterm xterm-addon-search xterm-addon-web-links xterm-addon-webgl
do
	cp -r ../node_modules/$pkg/ public/remote/$pkg/
	echo "Copy $pkg"
done

# build web extensions
(
	cd extensions/web-api
	yarn install
	yarn compile
)
WEB_API_DIST=public/web-extension/web-api
mkdir -p $WEB_API_DIST
cp extensions/web-api/package.json $WEB_API_DIST
cp -r extensions/web-api/out/ $WEB_API_DIST/out

# Gen extenions.json
node gen-extensions.js > public/extensions.json
