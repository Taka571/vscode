#!/usr/bin/env node
const util = require('util');
const fs = require('fs');
const path = require('path');

const SCHEME = 'http';
const AUTHORITY = 'localhost:8080';
const WEB_EXTENSIONS_ROOT = path.join(__dirname, 'extensions');
const EXTENSIONS_ROOT = path.join(__dirname, '../extensions');

const WEB_EXTENSIONS = ['web-api'];
const INCLUDE_EXTENSIONS = ['theme-defaults'];

async function main() {
	const webExtensions = await Promise.all(
		WEB_EXTENSIONS.map(async extensionFolder => {
			const packageJSON = JSON.parse(
				(await util.promisify(fs.readFile)(path.join(WEB_EXTENSIONS_ROOT, extensionFolder, 'package.json'))).toString()
			);
			packageJSON.extensionKind = ['web'];
			return {
				packageJSON,
				extensionLocation: { scheme: SCHEME, authority: AUTHORITY, path: `/web-extension/${extensionFolder}` }
			};
		})
	);

	const staticExtensions = await Promise.all(
		INCLUDE_EXTENSIONS.map(async extensionFolder => {
			const packageJSON = JSON.parse(
				(await util.promisify(fs.readFile)(path.join(EXTENSIONS_ROOT, extensionFolder, 'package.json'))).toString()
			);
			packageJSON.extensionKind = ['web']; // enable for Web
			return {
				packageJSON,
				extensionLocation: { scheme: SCHEME, authority: AUTHORITY, path: `/static-extension/${extensionFolder}` }
			};
		})
	);
	console.log(JSON.stringify([...webExtensions, ...staticExtensions]));
}

main();
