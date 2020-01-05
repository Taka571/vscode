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

node gen-extensions.js > public/extensions.json
