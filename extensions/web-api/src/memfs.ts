import * as vscode from 'vscode';

// @ts-ignore
import { StorageArea } from 'kv-storage-polyfill';

// @ts-ignore
export class MemFS implements vscode.FileSystemProvider, vscode.FileSearchProvider, vscode.TextSearchProvider {
	root = new Directory(vscode.Uri.parse('memfs:/'), '');
	fileStorage = new FileStorage();
	async restore() {
		// TODO: Sort by filepath
		for await (const [_key, entry] of this.fileStorage.fileStorage.entries()) {
			try {
				const _entry = entry as SerializedEntry;
				if (_entry.type === vscode.FileType.File) {
					const restored = File.fromJSON(_entry);
					await this.writeFile(restored.uri, restored.data || new Uint8Array(0), {
						create: true,
						overwrite: false
					});
				} else {
					const restored = Directory.fromJSON(_entry);
					await this.createDirectory(restored.uri);
				}
			} catch(err) {
				console.log(err);
			}
		}
	}

	// --- manage file metadata
	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return await this._lookup(uri, false);
	}
	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const entry = await this._lookupAsDirectory(uri, false);
		let result: [string, vscode.FileType][] = [];
		for (const [name, child] of entry.entries) {
			result.push([name, child.type]);
		}
		return result;
	}
	// --- manage file contents
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const data = (await this._lookupAsFile(uri, false)).data;
		if (data) {
			return data;
		}
		throw vscode.FileSystemError.FileNotFound();
	}
	async writeFile(uri: vscode.Uri, content: Uint8Array, options: {
		create: boolean;
		overwrite: boolean;
	}): Promise<void> {
		let basename = this._basename(uri.path);
		let parent = await this._lookupParentDirectory(uri);
		let entry = parent.entries.get(basename);
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
			entry = new File(uri, basename);
			parent.entries.set(basename, entry);
			await this.fileStorage.write(parent);
			this._fireSoon({ type: vscode.FileChangeType.Created, uri });
		}
		entry.mtime = Date.now();
		entry.size = content.byteLength;
		entry.data = content;

		await this.fileStorage.write(entry);
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
	}
	// --- manage files/folders
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: {
		overwrite: boolean;
	}): Promise<void> {
		if (!options.overwrite && await this._lookup(newUri, true)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}
		let entry = await this._lookup(oldUri, false);
		let oldParent = await this._lookupParentDirectory(oldUri);
		let newParent = await this._lookupParentDirectory(newUri);

		let newName = this._basename(newUri.path);
		oldParent.entries.delete(entry.name);
		entry.name = newName;
		newParent.entries.set(newName, entry);
		await this.fileStorage.write(entry);
		await this.fileStorage.write(oldParent);
		await this.fileStorage.write(newParent);
		this._fireSoon({ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri });
	}
	async delete(uri: vscode.Uri): Promise<void> {
		let dirname = uri.with({ path: this._dirname(uri.path) });
		let basename = this._basename(uri.path);
		let parent = await this._lookupAsDirectory(dirname, false);
		if (!parent.entries.has(basename)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		parent.entries.delete(basename);
		parent.mtime = Date.now();
		parent.size -= 1;
		await this.fileStorage.write(parent);
		await this.fileStorage.delete(uri);

		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
	}
	async createDirectory(uri: vscode.Uri): Promise<void> {
		let basename = this._basename(uri.path);
		let dirname = uri.with({ path: this._dirname(uri.path) });
		let parent = await this._lookupAsDirectory(dirname, false);
		let entry = new Directory(uri, basename);
		parent.entries.set(entry.name, entry);
		parent.mtime = Date.now();
		parent.size += 1;

		await this.fileStorage.write(entry);
		await this.fileStorage.write(parent);
		this._fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { type: vscode.FileChangeType.Created, uri });
	}
	// --- lookup
	private async _lookup(uri: vscode.Uri, silent: false): Promise<Entry>;
	private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | undefined>;
	private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | undefined> {
		let parts = uri.path.split('/');
		let entry: Entry = this.root;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			let child: Entry | undefined;
			if (entry instanceof Directory) {
				child = entry.entries.get(part);
			}
			if (!child) {
				if (!silent) {
					throw vscode.FileSystemError.FileNotFound(uri);
				}
				else {
					return undefined;
				}
			}
			entry = child;
		}
		return entry;
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
		const dirname = uri.with({ path: this._dirname(uri.path) });
		return await this._lookupAsDirectory(dirname, false);
	}
	// --- manage file events
	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private _bufferedEvents: vscode.FileChangeEvent[] = [];
	private _fireSoonHandle?: NodeJS.Timer;
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
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
	// --- path utils
	private _basename(path: string): string {
		path = this._rtrim(path, '/');
		if (!path) {
			return '';
		}
		return path.substr(path.lastIndexOf('/') + 1);
	}
	private _dirname(path: string): string {
		path = this._rtrim(path, '/');
		if (!path) {
			return '/';
		}
		return path.substr(0, path.lastIndexOf('/'));
	}
	private _rtrim(haystack: string, needle: string): string {
		if (!haystack || !needle) {
			return haystack;
		}
		const needleLen = needle.length, haystackLen = haystack.length;
		if (needleLen === 0 || haystackLen === 0) {
			return haystack;
		}
		let offset = haystackLen, idx = -1;
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
	private async _getFiles(): Promise<Set<File>> {
		const files = new Set<File>();
		await this._doGetFiles(this.root, files);
		return files;
	}
	private async _doGetFiles(dir: Directory, files: Set<File>): Promise<void> {
		dir.entries.forEach(entry => {
			if (entry instanceof File) {
				files.add(entry);
			}
			else {
				this._doGetFiles(entry, files);
			}
		});
	}
	private _convertSimple2RegExpPattern(pattern: string): string {
		return pattern.replace(/[\-\\\{\}\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&').replace(/[\*]/g, '.*');
	}
	// --- search provider
	// @ts-ignore
	async provideFileSearchResults(query: vscode.FileSearchQuery, _options: vscode.FileSearchOptions, _token: vscode.CancellationToken): Promise<vscode.ProviderResult<vscode.Uri[]>> {
		return await this._findFiles(query.pattern);
	}
	private async _findFiles(query: string | undefined): Promise<vscode.Uri[]> {
		const files = await this._getFiles();
		const result: vscode.Uri[] = [];
		const pattern = query ? new RegExp(this._convertSimple2RegExpPattern(query)) : null;
		for (const file of files) {
			if (!pattern || pattern.exec(file.name)) {
				result.push(file.uri);
			}
		}
		return result;
	}
	private _textDecoder = new TextDecoder();
	// @ts-ignore
	async provideTextSearchResults(query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>, _token: vscode.CancellationToken) {
		// @ts-ignore
		const result: vscode.TextSearchComplete = { limitHit: false };
		const files = await this._findFiles(options.includes[0]);
		if (files) {
			for (const file of files) {
				const content = this._textDecoder.decode(await this.readFile(file));
				const lines = content.split('\n');
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const index = line.indexOf(query.pattern);
					if (index !== -1) {
						progress.report({
							uri: file,
							ranges: new vscode.Range(new vscode.Position(i, index), new vscode.Position(i, index + query.pattern.length)),
							preview: {
								text: line,
								matches: new vscode.Range(new vscode.Position(0, index), new vscode.Position(0, index + query.pattern.length))
							}
						});
					}
				}
			}
		}
		return result;
	}
}


export class File implements vscode.FileStat {
	type: vscode.FileType.File = vscode.FileType.File;
	ctime: number;
	mtime: number;
	size: number;
	name: string;
	data?: Uint8Array;

	public static fromJSON(serializedFile: SerializedFile): File {
		const uri = vscode.Uri.parse(serializedFile.uri);
		const file = new File(uri, serializedFile.name);
		file.ctime = serializedFile.ctime;
		file.mtime = serializedFile.mtime;
		file.size = serializedFile.size;
		file.data = serializedFile.data;
		return file;
	}

	constructor(public uri: vscode.Uri, name: string) {
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
	}

	public toJSON(): SerializedFile {
		const { uri, ...rest } = this;
		return {
			...rest,
			uri: uri.toString()
		};
	}

}

export class Directory implements vscode.FileStat {
	type: vscode.FileType.Directory = vscode.FileType.Directory;

	ctime: number;
	mtime: number;
	size: number;

	name: string;
	entries: Map<string, File | Directory>;

	public static fromJSON(serializedDirectory: SerializedDirectory): Directory {
		const uri = vscode.Uri.parse(serializedDirectory.uri);
		const directory = new Directory(uri, serializedDirectory.name);
		directory.ctime = serializedDirectory.ctime;
		directory.mtime = serializedDirectory.mtime;
		directory.size = serializedDirectory.size;
		const newEntries: Array<[string, File | Directory]> = serializedDirectory.entries.map(([k, v]) => {
			if (v.type === vscode.FileType.File) {
				return [k, File.fromJSON(v) ];
			} else {
				return [k, Directory.fromJSON(v)];
			}
		});
		directory.entries = new Map(newEntries);
		return directory;
	}


	constructor(public uri: vscode.Uri, name: string) {
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
	}

	toJSON(): SerializedDirectory {
		const { uri, entries, ...rest } = this;

		const newEntries: Array<[string, SerializedEntry]> = Array.from(entries.entries()).map(([k, e]) => {
			return [k, e.toJSON()];
		});
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
	size: number;
	name: string;
	data?: Uint8Array;
}

export interface SerializedDirectory extends vscode.FileStat {
	uri: string;  // vscode.Uri.toJSON
	type: vscode.FileType.Directory;
	ctime: number;
	mtime: number;
	size: number;
	name: string;
	entries: Array<[string, SerializedEntry]>;
}

export type SerializedEntry = SerializedDirectory | SerializedFile;

class FileStorage {
	fileStorage = new StorageArea('fs') as {
		get(key: string): Promise<SerializedEntry>;
		set(key:string, serialized: SerializedEntry): Promise<void>;
		delete(key: string): Promise<void>;
		entries(): any;
	};

	async read(uri: vscode.Uri): Promise<Entry> {
		const serializedEntry = await this.fileStorage.get(uri.toString());
		if (serializedEntry.type === vscode.FileType.File) {
			return File.fromJSON(serializedEntry);
		} else {
			return Directory.fromJSON(serializedEntry);
		}
	}

	async write(entry: Entry) {
		// console.log('write', entry.uri.toString(), entry.toJSON());
		await this.fileStorage.set(entry.uri.toString(), entry.toJSON());
	}

	async delete(uri: vscode.Uri) {
		await this.fileStorage.delete(uri.toString());
	}

	entries() {
		return this.fileStorage.entries();
	}
}
