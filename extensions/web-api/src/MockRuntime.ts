import * as vscode from 'vscode';

import { MemFS } from './MemFS';
/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime {
	private stopOnEntry = new vscode.EventEmitter<void>();
	onStopOnEntry: vscode.Event<void> = this.stopOnEntry.event;
	private stopOnStep = new vscode.EventEmitter<void>();
	onStopOnStep: vscode.Event<void> = this.stopOnStep.event;
	private stopOnBreakpoint = new vscode.EventEmitter<void>();
	onStopOnBreakpoint: vscode.Event<void> = this.stopOnBreakpoint.event;
	private stopOnDataBreakpoint = new vscode.EventEmitter<void>();
	onStopOnDataBreakpoint: vscode.Event<void> = this.stopOnDataBreakpoint.event;
	private stopOnException = new vscode.EventEmitter<void>();
	onStopOnException: vscode.Event<void> = this.stopOnException.event;
	private breakpointValidated = new vscode.EventEmitter<MockBreakpoint>();
	onBreakpointValidated: vscode.Event<MockBreakpoint> = this.breakpointValidated.event;
	private output = new vscode.EventEmitter<MockOutputEvent>();
	onOutput: vscode.Event<MockOutputEvent> = this.output.event;
	private end = new vscode.EventEmitter<void>();
	onEnd: vscode.Event<void> = this.end.event;
	// the initial (and one and only) file we are 'debugging'
	private _sourceFile?: string;
	public get sourceFile() {
		return this._sourceFile;
	}
	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];
	// This is the next line that will be 'executed'
	private _currentLine = 0;
	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, MockBreakpoint[]>();
	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;
	private _breakAddresses = new Set<string>();
	constructor(private memfs: MemFS) {
	}
	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean) {
		await this.loadSource(program);
		this._currentLine = -1;
		if (this._sourceFile) {
			this.verifyBreakpoints(this._sourceFile);
		}
		if (stopOnEntry) {
			// we step once
			this.step(false, this.stopOnEntry);
		}
		else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		}
	}
	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		this.run(reverse, undefined);
	}
	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, event = this.stopOnStep) {
		this.run(reverse, event);
	}
	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): {
		frames: any[];
		count: number;
	} {
		const words = this._sourceLines[this._currentLine].trim().split(/\s+/);
		const frames = new Array<any>();
		// every word of the current line becomes a stack frame.
		for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			const name = words[i]; // use a word of the line as the stackframe name
			frames.push({
				index: i,
				name: `${name}(${i})`,
				file: this._sourceFile,
				line: this._currentLine
			});
		}
		return {
			frames: frames,
			count: words.length
		};
	}
	public getBreakpoints(_path: string, line: number): number[] {
		const l = this._sourceLines[line];
		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			}
			else {
				sawSpace = true;
			}
		}
		return bps;
	}
	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<MockBreakpoint> {
		const bp = <MockBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);
		await this.verifyBreakpoints(path);
		return bp;
	}
	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): MockBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}
	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
	}
	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}
	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}
	// private methods
	private async loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			const _textDecoder = new TextDecoder();
			const uri = vscode.Uri.parse(file);
			const content = _textDecoder.decode(await this.memfs.readFile(uri));
			this._sourceLines = content.split('\n');
			//this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}
	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: vscode.EventEmitter<void>): void {
		if (reverse) {
			for (let ln = this._currentLine - 1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
			}
			// no more lines: stop at first line
			this._currentLine = 0;
			this.stopOnEntry.fire();
		}
		else {
			for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
			}
			// no more lines: run to end
			this.end.fire();
		}
	}
	private async verifyBreakpoints(path: string): Promise<void> {
		let bps = this._breakPoints.get(path);
		if (bps) {
			await this.loadSource(path);
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();
					// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// don't set 'verified' to true if the line contains the word 'lazy'
					// in this case the breakpoint will be verified 'lazy' after hitting it once.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.breakpointValidated.fire(bp);
					}
				}
			});
		}
	}
	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, stepEvent?: vscode.EventEmitter<void>): boolean {
		const line = this._sourceLines[ln].trim();
		// if 'log(...)' found in source -> send argument to debug console
		const matches = /log\((.*)\)/.exec(line);
		if (matches && matches.length === 2) {
			if (this._sourceFile) {
				this.output.fire({ text: matches[1], filePath: this._sourceFile, line: ln, column: matches.index });
			}
		}
		// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
		const words = line.split(' ');
		for (let word of words) {
			if (this._breakAddresses.has(word)) {
				this.stopOnDataBreakpoint.fire();
				return true;
			}
		}
		// if word 'exception' found in source -> throw exception
		if (line.indexOf('exception') >= 0) {
			this.stopOnException.fire();
			return true;
		}
		// is there a breakpoint?
		const breakpoints = this._sourceFile ? this._breakPoints.get(this._sourceFile) : undefined;
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {
				// send 'stopped' event
				this.stopOnBreakpoint.fire();
				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.breakpointValidated.fire(bps[0]);
				}
				return true;
			}
		}
		// non-empty line
		if (stepEvent && line.length > 0) {
			stepEvent.fire();
			return true;
		}
		// nothing interesting found -> continue
		return false;
	}
}

export interface MockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export interface MockOutputEvent {
	text: string;
	filePath: string;
	line: number;
	column: number;
}


