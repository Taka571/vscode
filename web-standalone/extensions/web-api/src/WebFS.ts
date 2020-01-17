import { getUid, getDB } from './firebase';
import * as vscode from 'vscode';

export class WebFS
	implements
		vscode.FileSystemProvider,
		// @ts-ignore
		vscode.FileSearchProvider,
		// @ts-ignore
		vscode.TextSearchProvider {
	private _backend = new WebStorage();
	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: NodeJS.Timer;
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
	private _textDecoder = new TextDecoder();

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return await this._lookup(uri, false);
	}
	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const entry = await this._lookupAsDirectory(uri, false);
		const ret = entry.getEntries();
		console.log('readdir', ret);
		debugger;
		return ret;
	}
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const data = (await this._lookupAsFile(uri, false)).data;
		if (data) {
			return data;
		}
		throw vscode.FileSystemError.FileNotFound();
	}
	async writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		options: {
			create: boolean;
			overwrite: boolean;
		}
	): Promise<void> {
		let basename = _basename(uri.path);
		let parent = await this._lookupParentDirectory(uri);

		let entry = await this._lookup(uri, true);
		if (entry instanceof Directory) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (!entry && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (entry && options.create && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!entry) {
			entry = new File(uri);
			parent.addEntry(basename, entry.uri, entry.type);
			await this._backend.write(parent);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		}
		entry.updateContent(content);
		entry.data = content;
		await this._backend.write(entry);
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
	}
	async rename(
		oldUri: vscode.Uri,
		newUri: vscode.Uri,
		options: {
			overwrite: boolean;
		}
	): Promise<void> {
		if (!options.overwrite && (await this._lookup(newUri, true))) {
			throw vscode.FileSystemError.FileExists(newUri);
		}
		let entry = await this._lookup(oldUri, false);
		let oldParent = await this._lookupParentDirectory(oldUri);
		let newParent = await this._lookupParentDirectory(newUri);

		let newName = _basename(newUri.path);
		entry.uri = newUri;
		oldParent.deleteEntry(entry.name);
		newParent.addEntry(newName, entry.uri, entry.type);
		await this._backend.write(entry);
		await this._backend.write(oldParent);
		await this._backend.write(newParent);
		this._fireSoon(
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri }
		);
	}
	async delete(uri: vscode.Uri): Promise<void> {
		let dirname = uri.with({ path: _dirname(uri.path) });
		let basename = _basename(uri.path);
		let parent = await this._lookupAsDirectory(dirname, false);
		if (!parent.hasEntry(basename)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		parent.deleteEntry(basename);
		await this._backend.write(parent);
		await this._backend.delete(uri);
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		let entry = new Directory(uri);

		// on root
		if (uri.path === '/') {
			await this._backend.write(entry);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		} else {
			uri = this._normalizeDirectoryUri(uri);
			const dirname = uri.with({ path: _dirname(uri.path) });
			const parent = await this._lookupAsDirectory(dirname, false);
			parent.addEntry(entry.name, entry.uri, entry.type);
			await this._backend.write(parent);
			await this._backend.write(entry);
			this._fireSoon(
				{ type: vscode.FileChangeType.Changed, uri: dirname },
				{ type: vscode.FileChangeType.Created, uri }
			);
		}
	}

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => {});
	}

	// utils
	private _normalizeDirectoryUri(uri: vscode.Uri): vscode.Uri {
		// root is root
		if (uri.path === '/') {
			return uri;
		}
		// strip last /
		if (uri.path.endsWith('/')) {
			return uri.with({ path: uri.toString().replace(/\/$/, '') });
		}
		return uri;
	}

	// --- search provider
	// @ts-ignore
	async provideFileSearchResults(
		// @ts-ignore
		query: vscode.FileSearchQuery,
		// @ts-ignore
		_options: vscode.FileSearchOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.ProviderResult<vscode.Uri[]>> {
		const pattern = query ? new RegExp(_convertSimple2RegExpPattern(query.pattern)) : null;

		const result: Array<vscode.Uri> = [];
		const db = getDB();
		const snapshot = await db
			.collection(COLLECTION)
			.doc(getUid())
			.collection('fs')
			.get();

		snapshot.forEach(doc => {
			const key = _decodeKey(doc.id);
			if (!pattern || pattern.exec(key)) {
				result.push(vscode.Uri.parse(key));
			}
		});
		return result;
	}

	async provideTextSearchResults(
		// @ts-ignore
		query: vscode.TextSearchQuery,
		// @ts-ignore
		options: vscode.TextSearchOptions,
		// @ts-ignore
		progress: vscode.Progress<vscode.TextSearchResult>,
		_token: vscode.CancellationToken
	) {
		// @ts-ignore
		const result: vscode.TextSearchComplete = { limitHit: false };
		const db = getDB();
		const uid = getUid();
		const snapshot = await db
			.collection(COLLECTION)
			.doc(uid)
			.collection('fs')
			.get();

		snapshot.forEach(doc => {
			const key = _decodeKey(doc.id);
			const entry = doc.data();
			if (entry.type === vscode.FileType.Directory) {
				return;
			}
			// TODO: See Options
			const content = this._textDecoder.decode(entry.data);
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const index = line.indexOf(query.pattern);
				if (index !== -1) {
					progress.report({
						uri: vscode.Uri.parse(key),
						ranges: new vscode.Range(
							new vscode.Position(i, index),
							new vscode.Position(i, index + query.pattern.length)
						),
						preview: {
							text: line,
							matches: new vscode.Range(
								new vscode.Position(0, index),
								new vscode.Position(0, index + query.pattern.length)
							)
						}
					});
				}
			}
		});
		return result;
	}

	public async exists(uri: vscode.Uri): Promise<boolean> {
		return !!(await this._lookup(uri, true));
	}

	// --- lookup
	private async _lookup(uri: vscode.Uri, silent: false): Promise<Entry>;
	private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | void>;
	private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | void> {
		// handle root
		if (uri.path === '') {
			uri = uri.with({ path: '/' });
		}

		const ret = await this._backend.read(uri);

		// normalize vscode path
		if (!ret) {
			const str = uri.toString();

			let next;
			if (str.endsWith('/')) {
				next = vscode.Uri.parse(str.substr(0, str.length - 1));
			} else {
				next = vscode.Uri.parse(str + '/');
			}
			await this._backend.read(next);
		}

		if (!ret) {
			if (!silent) {
				throw vscode.FileSystemError.FileNotFound(uri);
			} else {
				return undefined;
			}
		}
		return ret;
	}
	private async _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Promise<Directory> {
		let entry = await this._lookup(uri, silent);
		if (entry instanceof Directory) {
			return entry;
		}
		throw vscode.FileSystemError.FileNotADirectory(uri);
	}
	private async _lookupAsFile(uri: vscode.Uri, silent: boolean): Promise<File> {
		let entry = await this._lookup(uri, silent);
		if (entry instanceof File) {
			return entry;
		}
		throw vscode.FileSystemError.FileIsADirectory(uri);
	}
	private async _lookupParentDirectory(uri: vscode.Uri): Promise<Directory> {
		const dirname = uri.with({ path: _dirname(uri.path) });
		return await this._lookupAsDirectory(dirname, false);
	}
	private _fireSoon(...events: vscode.FileChangeEvent[]): void {
		this._bufferedEvents.push(...events);
		if (this._fireSoonHandle) {
			clearTimeout(this._fireSoonHandle);
		}
		this._fireSoonHandle = setTimeout(() => {
			this._emitter.fire(this._bufferedEvents);
			this._bufferedEvents.length = 0;
		}, 5);
	}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export class File implements vscode.FileStat {
	type: vscode.FileType.File = vscode.FileType.File;
	ctime: number;
	mtime: number;
	data: Uint8Array = new Uint8Array();

	get size(): number {
		return this.data.byteLength;
	}

	get name(): string {
		return _basename(this.uri.path);
	}

	public static fromJSON(serializedFile: SerializedFile): File {
		const uri = vscode.Uri.parse(serializedFile.uri);
		const file = new File(uri);
		file.ctime = serializedFile.ctime;
		file.mtime = serializedFile.mtime;
		file.data = textEncoder.encode(serializedFile.data);
		return file;
	}

	constructor(public uri: vscode.Uri) {
		this.ctime = Date.now();
		this.mtime = Date.now();
	}

	public updateContent(data: Uint8Array) {
		this.data = data;
		this.mtime = Date.now();
	}

	public toJSON(): SerializedFile {
		const { uri, data, ...rest } = this;
		return {
			...rest,
			data: textDecoder.decode(data),
			uri: uri.toString()
		};
	}
}

interface EntryRef {
	uri: vscode.Uri;
	type: vscode.FileType;
}

export class Directory implements vscode.FileStat {
	type: vscode.FileType.Directory = vscode.FileType.Directory;
	ctime: number;
	mtime: number;
	private entries: Map<string, EntryRef> = new Map();

	get size(): number {
		return this.entries.size;
	}

	get name(): string {
		return _basename(this.uri.path);
	}

	public static fromJSON(serializedDirectory: SerializedDirectory): Directory {
		const uri = vscode.Uri.parse(serializedDirectory.uri);
		const directory = new Directory(uri);
		directory.ctime = serializedDirectory.ctime;
		directory.mtime = serializedDirectory.mtime;
		const newEntries = new Map<string, EntryRef>();
		Object.entries(serializedDirectory.entries).forEach(([k, v]) => {
			newEntries.set(k, { uri: vscode.Uri.parse(v.uri), type: v.type });
		});
		directory.entries = newEntries;
		return directory;
	}

	constructor(public uri: vscode.Uri) {
		this.ctime = Date.now();
		this.mtime = Date.now();
	}

	getEntries(): Array<[string, vscode.FileType]> {
		let result: [string, vscode.FileType][] = [];
		for (const [name, child] of this.entries) {
			result.push([name, child.type]);
		}
		return result;
	}

	deleteEntry(name: string) {
		this.entries.delete(name);
		this.mtime = Date.now();
	}

	hasEntry(name: string) {
		return this.entries.has(name);
	}

	addEntry(name: string, uri: vscode.Uri, type: vscode.FileType) {
		this.entries.set(name, { uri, type });
		this.mtime = Date.now();
	}

	toJSON(): SerializedDirectory {
		const { uri, entries, ...rest } = this;

		const newEntries: {
			[key: string]: {
				uri: string;
				type: vscode.FileType;
			};
		} = Array.from(entries.entries()).reduce((acc, [k, v]) => {
			return {
				...acc,
				[k]: {
					uri: v.uri.toString(),
					type: v.type
				}
			};
		}, {});
		return {
			...rest,
			uri: uri.toString(),
			entries: newEntries
		};
	}
}

export type Entry = File | Directory;

export interface SerializedFile extends vscode.FileStat {
	uri: string; // vscode.Uri.toJSON
	type: vscode.FileType.File;
	ctime: number;
	mtime: number;
	data: string;
}

export interface SerializedDirectory extends vscode.FileStat {
	uri: string; // vscode.Uri.toJSON
	type: vscode.FileType.Directory;
	ctime: number;
	mtime: number;
	entries: {
		[key: string]: {
			uri: string;
			type: vscode.FileType;
		};
	};
}

export type SerializedEntry = SerializedDirectory | SerializedFile;

const COLLECTION = 'user';
class WebStorage {
	async read(uri: vscode.Uri): Promise<Entry | void> {
		// console.log('read', uri);
		const uid = getUid();
		const db = getDB();
		const key = _encodeKey(uri.toString());
		const snapshot = await db
			.collection(COLLECTION)
			.doc(uid)
			.collection('fs')
			.doc(key)
			.get();
		const serializedEntry = snapshot.data() as SerializedEntry;
		if (!serializedEntry) {
			return;
		}
		if (serializedEntry.type === vscode.FileType.File) {
			return File.fromJSON(serializedEntry);
		} else {
			return Directory.fromJSON(serializedEntry);
		}
	}

	async write(entry: Entry) {
		console.log('write', entry.uri);
		const uid = getUid();
		const db = getDB();
		const key = _encodeKey(entry.uri.toString());
		await db
			.collection(COLLECTION)
			.doc(uid)
			.collection('fs')
			.doc(key)
			.set(entry.toJSON());
	}

	async delete(uri: vscode.Uri) {
		console.log('delete', uri);

		const uid = getUid();
		const db = getDB();
		const key = _encodeKey(uri.toString());
		await db
			.collection(COLLECTION)
			.doc(uid)
			.collection('fs')
			.doc(key)
			.delete();
	}
}

function _encodeKey(key: string): string {
	return btoa(key);
}

function _decodeKey(key: string): string {
	return atob(key);
}

// --- path utils
function _basename(path: string): string {
	path = _rtrim(path, '/');
	if (!path) {
		return '';
	}
	return path.substr(path.lastIndexOf('/') + 1);
}
function _dirname(path: string): string {
	path = _rtrim(path, '/');
	if (!path) {
		return '/';
	}
	return path.substr(0, path.lastIndexOf('/'));
}
function _rtrim(haystack: string, needle: string): string {
	if (!haystack || !needle) {
		return haystack;
	}
	const needleLen = needle.length,
		haystackLen = haystack.length;
	if (needleLen === 0 || haystackLen === 0) {
		return haystack;
	}
	let offset = haystackLen,
		idx = -1;
	while (true) {
		idx = haystack.lastIndexOf(needle, offset - 1);
		if (idx === -1 || idx + needleLen !== offset) {
			break;
		}
		if (idx === 0) {
			return '';
		}
		offset = idx;
	}
	return haystack.substring(0, offset);
}
function _convertSimple2RegExpPattern(pattern: string): string {
	return pattern.replace(/[\-\\\{\}\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&').replace(/[\*]/g, '.*');
}
