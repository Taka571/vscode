/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//
// ############################################################################
//
//						! USED FOR RUNNING VSCODE OUT OF SOURCES FOR WEB !
//										! DO NOT REMOVE !
//
// ############################################################################
//

import * as vscode from 'vscode';
import { MemFS } from './MemFS';
import { MockRuntime, MockBreakpoint } from './MockRuntime';
import { DebugProtocol } from './DebugProtocol';

const textEncoder = new TextEncoder();
const SCHEME = 'memfs';

export async function activate(context: vscode.ExtensionContext) {
	if (typeof window !== 'undefined') {	// do not run under node.js
		const memFs = await enableFs(context);
		enableProblems(context);
		enableSearch(context, memFs);
		enableTasks();
		// enableDebug(context, memFs);
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`memfs:/sample-folder/file.txt`));
	}
}

async function enableFs(context: vscode.ExtensionContext): Promise<MemFS> {
	console.log("enable")
	const memFs = new MemFS();
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, memFs, { isCaseSensitive: true }));

	await memFs.createDirectory(vscode.Uri.parse(`memfs:/sample-folder/`));
	await memFs.writeFile(vscode.Uri.parse(`memfs:/sample-folder/file.txt`), textEncoder.encode('foo'), { create: true, overwrite: true });
	return memFs;
}

function enableProblems(context: vscode.ExtensionContext): void {
	const collection = vscode.languages.createDiagnosticCollection('test');
	if (vscode.window.activeTextEditor) {
		updateDiagnostics(vscode.window.activeTextEditor.document, collection);
	}
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			updateDiagnostics(editor.document, collection);
		}
	}));
}

function updateDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
	if (document && document.fileName === '/sample-folder/large.ts') {
		collection.set(document.uri, [{
			code: '',
			message: 'cannot assign twice to immutable variable `storeHouses`',
			range: new vscode.Range(new vscode.Position(4, 12), new vscode.Position(4, 32)),
			severity: vscode.DiagnosticSeverity.Error,
			source: '',
			relatedInformation: [
				new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, new vscode.Range(new vscode.Position(1, 8), new vscode.Position(1, 9))), 'first assignment to `x`')
			]
		}, {
			code: '',
			message: 'function does not follow naming conventions',
			range: new vscode.Range(new vscode.Position(7, 10), new vscode.Position(7, 23)),
			severity: vscode.DiagnosticSeverity.Warning,
			source: ''
		}]);
	} else {
		collection.clear();
	}
}

function enableSearch(context: vscode.ExtensionContext, memFs: MemFS): void {
	// @ts-ignore
	context.subscriptions.push(vscode.workspace.registerFileSearchProvider(SCHEME, memFs));
	// @ts-ignore
	context.subscriptions.push(vscode.workspace.registerTextSearchProvider(SCHEME, memFs));
}

function enableTasks(): void {

	interface CustomBuildTaskDefinition extends vscode.TaskDefinition {
		/**
		 * The build flavor. Should be either '32' or '64'.
		 */
		flavor: string;

		/**
		 * Additional build flags
		 */
		flags?: string[];
	}

	class CustomBuildTaskProvider implements vscode.TaskProvider {
		static CustomBuildScriptType: string = 'custombuildscript';
		private tasks: vscode.Task[] | undefined;

		// We use a CustomExecution task when state needs to be shared accross runs of the task or when
		// the task requires use of some VS Code API to run.
		// If you don't need to share state between runs and if you don't need to execute VS Code API in your task,
		// then a simple ShellExecution or ProcessExecution should be enough.
		// Since our build has this shared state, the CustomExecution is used below.
		private sharedState: string | undefined;

		constructor(private workspaceRoot: string) { }

		public async provideTasks(): Promise<vscode.Task[]> {
			return this.getTasks();
		}

		public resolveTask(_task: vscode.Task): vscode.Task | undefined {
			const flavor: string = _task.definition.flavor;
			if (flavor) {
				const definition: CustomBuildTaskDefinition = <any>_task.definition;
				return this.getTask(definition.flavor, definition.flags ? definition.flags : [], definition);
			}
			return undefined;
		}

		private getTasks(): vscode.Task[] {
			if (this.tasks !== undefined) {
				return this.tasks;
			}
			// In our fictional build, we have two build flavors
			const flavors: string[] = ['32', '64'];
			// Each flavor can have some options.
			const flags: string[][] = [['watch', 'incremental'], ['incremental'], []];

			this.tasks = [];
			flavors.forEach(flavor => {
				flags.forEach(flagGroup => {
					this.tasks!.push(this.getTask(flavor, flagGroup));
				});
			});
			return this.tasks;
		}

		private getTask(flavor: string, flags: string[], definition?: CustomBuildTaskDefinition): vscode.Task {
			if (definition === undefined) {
				definition = {
					type: CustomBuildTaskProvider.CustomBuildScriptType,
					flavor,
					flags
				};
			}
			// @ts-ignore
			return new vscode.Task2(definition, vscode.TaskScope.Workspace, `${flavor} ${flags.join(' ')}`,
				// @ts-ignore
				CustomBuildTaskProvider.CustomBuildScriptType, new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
					// When the task is executed, this callback will run. Here, we setup for running the task.
					return new CustomBuildTaskTerminal(this.workspaceRoot, flavor, flags, () => this.sharedState, (state: string) => this.sharedState = state);
				}));
		}
	}

	// @ts-ignore
	class CustomBuildTaskTerminal implements vscode.Pseudoterminal {
		private writeEmitter = new vscode.EventEmitter<string>();
		onDidWrite: vscode.Event<string> = this.writeEmitter.event;
		private closeEmitter = new vscode.EventEmitter<void>();
		onDidClose?: vscode.Event<void> = this.closeEmitter.event;

		private fileWatcher: vscode.FileSystemWatcher | undefined;

		constructor(private workspaceRoot: string, _flavor: string, private flags: string[], private getSharedState: () => string | undefined, private setSharedState: (state: string) => void) {
		}

		// @ts-ignore
		open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
			// At this point we can start using the terminal.
			if (this.flags.indexOf('watch') > -1) {
				let pattern = this.workspaceRoot + '/customBuildFile';
				this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
				this.fileWatcher.onDidChange(() => this.doBuild());
				this.fileWatcher.onDidCreate(() => this.doBuild());
				this.fileWatcher.onDidDelete(() => this.doBuild());
			}
			this.doBuild();
		}

		close(): void {
			// The terminal has been closed. Shutdown the build.
			if (this.fileWatcher) {
				this.fileWatcher.dispose();
			}
		}

		private async doBuild(): Promise<void> {
			return new Promise<void>((resolve) => {
				this.writeEmitter.fire('Starting build...\r\n');
				let isIncremental = this.flags.indexOf('incremental') > -1;
				if (isIncremental) {
					if (this.getSharedState()) {
						this.writeEmitter.fire('Using last build results: ' + this.getSharedState() + '\r\n');
					} else {
						isIncremental = false;
						this.writeEmitter.fire('No result from last build. Doing full build.\r\n');
					}
				}

				// Since we don't actually build anything in this example set a timeout instead.
				setTimeout(() => {
					const date = new Date();
					this.setSharedState(date.toTimeString() + ' ' + date.toDateString());
					this.writeEmitter.fire('Build complete.\r\n\r\n');
					if (this.flags.indexOf('watch') === -1) {
						this.closeEmitter.fire();
						resolve();
					}
				}, isIncremental ? 1000 : 4000);
			});
		}
	}

	vscode.tasks.registerTaskProvider(CustomBuildTaskProvider.CustomBuildScriptType, new CustomBuildTaskProvider(vscode.workspace.rootPath!));
}

//---------------------------------------------------------------------------
//								DEBUG
//---------------------------------------------------------------------------

function enableDebug(context: vscode.ExtensionContext, memFs: MemFS): void {
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('mock', new MockConfigurationProvider()));
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('mock', new MockDebugAdapterDescriptorFactory(memFs)));
}

//------------------------------------------------------------------------------------------------------------------------------

export class Message implements DebugProtocol.ProtocolMessage {
	seq: number;
	type: string;

	public constructor(type: string) {
		this.seq = 0;
		this.type = type;
	}
}

export class Response extends Message implements DebugProtocol.Response {
	request_seq: number;
	success: boolean;
	command: string;

	public constructor(request: DebugProtocol.Request, message?: string) {
		super('response');
		this.request_seq = request.seq;
		this.command = request.command;
		if (message) {
			this.success = false;
			(<any>this).message = message;
		} else {
			this.success = true;
		}
	}
}

export class Event extends Message implements DebugProtocol.Event {
	event: string;

	public constructor(event: string, body?: any) {
		super('event');
		this.event = event;
		if (body) {
			(<any>this).body = body;
		}
	}
}

//--------------------------------------------------------------------------------------------------------------------------------
// @ts-ignore
export class ProtocolServer implements vscode.DebugAdapter {

	private close = new vscode.EventEmitter<void>();
	onClose: vscode.Event<void> = this.close.event;

	private error = new vscode.EventEmitter<Error>();
	onError: vscode.Event<Error> = this.error.event;

	private sendMessage = new vscode.EventEmitter<DebugProtocol.ProtocolMessage>();
	readonly onDidSendMessage: vscode.Event<DebugProtocol.ProtocolMessage> = this.sendMessage.event;

	private _sequence: number = 1;
	private _pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();


	public handleMessage(message: DebugProtocol.ProtocolMessage): void {
		this.dispatch(message);
	}

	public dispose() {
	}

	public sendEvent(event: DebugProtocol.Event): void {
		this._send('event', event);
	}

	public sendResponse(response: DebugProtocol.Response): void {
		if (response.seq > 0) {
			console.error(`attempt to send more than one response for command ${response.command}`);
		} else {
			this._send('response', response);
		}
	}

	public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		this._send('request', request);

		if (cb) {
			this._pendingRequests.set(request.seq, cb);

			const timer = setTimeout(() => {
				clearTimeout(timer);
				const clb = this._pendingRequests.get(request.seq);
				if (clb) {
					this._pendingRequests.delete(request.seq);
					clb(new Response(request, 'timeout'));
				}
			}, timeout);
		}
	}

	// ---- protected ----------------------------------------------------------

	protected dispatchRequest(_request: DebugProtocol.Request): void {
	}

	// ---- private ------------------------------------------------------------

	private dispatch(msg: DebugProtocol.ProtocolMessage) {
		if (msg.type === 'request') {
			this.dispatchRequest(<DebugProtocol.Request>msg);
		} else if (msg.type === 'response') {
			const response = <DebugProtocol.Response>msg;
			const clb = this._pendingRequests.get(response.request_seq);
			if (clb) {
				this._pendingRequests.delete(response.request_seq);
				clb(response);
			}
		}
	}

	private _send(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): void {

		message.type = typ;
		message.seq = this._sequence++;

		this.sendMessage.fire(message);
	}
}

//-------------------------------------------------------------------------------------------------------------------------------

export class Source implements DebugProtocol.Source {
	name: string;
	path?: string;
	sourceReference: number;

	public constructor(name: string, path?: string, id: number = 0, origin?: string, data?: any) {
		this.name = name;
		this.path = path;
		this.sourceReference = id;
		if (origin) {
			(<any>this).origin = origin;
		}
		if (data) {
			(<any>this).adapterData = data;
		}
	}
}

export class Scope implements DebugProtocol.Scope {
	name: string;
	variablesReference: number;
	expensive: boolean;

	public constructor(name: string, reference: number, expensive: boolean = false) {
		this.name = name;
		this.variablesReference = reference;
		this.expensive = expensive;
	}
}

export class StackFrame implements DebugProtocol.StackFrame {
	id: number;
	source?: Source;
	line: number;
	column: number;
	name: string;

	public constructor(i: number, nm: string, src?: Source, ln: number = 0, col: number = 0) {
		this.id = i;
		this.source = src;
		this.line = ln;
		this.column = col;
		this.name = nm;
	}
}

export class Thread implements DebugProtocol.Thread {
	id: number;
	name: string;

	public constructor(id: number, name: string) {
		this.id = id;
		if (name) {
			this.name = name;
		} else {
			this.name = 'Thread #' + id;
		}
	}
}

export class Variable implements DebugProtocol.Variable {
	name: string;
	value: string;
	variablesReference: number;

	public constructor(name: string, value: string, ref: number = 0, indexedVariables?: number, namedVariables?: number) {
		this.name = name;
		this.value = value;
		this.variablesReference = ref;
		if (typeof namedVariables === 'number') {
			(<DebugProtocol.Variable>this).namedVariables = namedVariables;
		}
		if (typeof indexedVariables === 'number') {
			(<DebugProtocol.Variable>this).indexedVariables = indexedVariables;
		}
	}
}

export class Breakpoint implements DebugProtocol.Breakpoint {
	verified: boolean;

	public constructor(verified: boolean, line?: number, column?: number, source?: Source) {
		this.verified = verified;
		const e: DebugProtocol.Breakpoint = this;
		if (typeof line === 'number') {
			e.line = line;
		}
		if (typeof column === 'number') {
			e.column = column;
		}
		if (source) {
			e.source = source;
		}
	}
}

export class Module implements DebugProtocol.Module {
	id: number | string;
	name: string;

	public constructor(id: number | string, name: string) {
		this.id = id;
		this.name = name;
	}
}

export class CompletionItem implements DebugProtocol.CompletionItem {
	label: string;
	start: number;
	length: number;

	public constructor(label: string, start: number, length: number = 0) {
		this.label = label;
		this.start = start;
		this.length = length;
	}
}

export class StoppedEvent extends Event implements DebugProtocol.StoppedEvent {
	body: {
		reason: string;
	};

	public constructor(reason: string, threadId?: number, exceptionText?: string) {
		super('stopped');
		this.body = {
			reason: reason
		};
		if (typeof threadId === 'number') {
			(this as DebugProtocol.StoppedEvent).body.threadId = threadId;
		}
		if (typeof exceptionText === 'string') {
			(this as DebugProtocol.StoppedEvent).body.text = exceptionText;
		}
	}
}

export class ContinuedEvent extends Event implements DebugProtocol.ContinuedEvent {
	body: {
		threadId: number;
	};

	public constructor(threadId: number, allThreadsContinued?: boolean) {
		super('continued');
		this.body = {
			threadId: threadId
		};

		if (typeof allThreadsContinued === 'boolean') {
			(<DebugProtocol.ContinuedEvent>this).body.allThreadsContinued = allThreadsContinued;
		}
	}
}

export class InitializedEvent extends Event implements DebugProtocol.InitializedEvent {
	public constructor() {
		super('initialized');
	}
}

export class TerminatedEvent extends Event implements DebugProtocol.TerminatedEvent {
	public constructor(restart?: any) {
		super('terminated');
		if (typeof restart === 'boolean' || restart) {
			const e: DebugProtocol.TerminatedEvent = this;
			e.body = {
				restart: restart
			};
		}
	}
}

export class OutputEvent extends Event implements DebugProtocol.OutputEvent {
	body: {
		category: string,
		output: string,
		data?: any
	};

	public constructor(output: string, category: string = 'console', data?: any) {
		super('output');
		this.body = {
			category: category,
			output: output
		};
		if (data !== undefined) {
			this.body.data = data;
		}
	}
}

export class ThreadEvent extends Event implements DebugProtocol.ThreadEvent {
	body: {
		reason: string,
		threadId: number
	};

	public constructor(reason: string, threadId: number) {
		super('thread');
		this.body = {
			reason: reason,
			threadId: threadId
		};
	}
}

export class BreakpointEvent extends Event implements DebugProtocol.BreakpointEvent {
	body: {
		reason: string,
		breakpoint: Breakpoint
	};

	public constructor(reason: string, breakpoint: Breakpoint) {
		super('breakpoint');
		this.body = {
			reason: reason,
			breakpoint: breakpoint
		};
	}
}

export class ModuleEvent extends Event implements DebugProtocol.ModuleEvent {
	body: {
		reason: 'new' | 'changed' | 'removed',
		module: Module
	};

	public constructor(reason: 'new' | 'changed' | 'removed', module: Module) {
		super('module');
		this.body = {
			reason: reason,
			module: module
		};
	}
}

export class LoadedSourceEvent extends Event implements DebugProtocol.LoadedSourceEvent {
	body: {
		reason: 'new' | 'changed' | 'removed',
		source: Source
	};

	public constructor(reason: 'new' | 'changed' | 'removed', source: Source) {
		super('loadedSource');
		this.body = {
			reason: reason,
			source: source
		};
	}
}

export class CapabilitiesEvent extends Event implements DebugProtocol.CapabilitiesEvent {
	body: {
		capabilities: DebugProtocol.Capabilities
	};

	public constructor(capabilities: DebugProtocol.Capabilities) {
		super('capabilities');
		this.body = {
			capabilities: capabilities
		};
	}
}

export enum ErrorDestination {
	User = 1,
	Telemetry = 2
}

export class DebugSession extends ProtocolServer {

	private _debuggerLinesStartAt1: boolean;
	private _debuggerColumnsStartAt1: boolean;
	private _debuggerPathsAreURIs: boolean;

	private _clientLinesStartAt1: boolean;
	private _clientColumnsStartAt1: boolean;
	private _clientPathsAreURIs: boolean;

	protected _isServer: boolean;

	public constructor(obsolete_debuggerLinesAndColumnsStartAt1?: boolean, obsolete_isServer?: boolean) {
		super();

		const linesAndColumnsStartAt1 = typeof obsolete_debuggerLinesAndColumnsStartAt1 === 'boolean' ? obsolete_debuggerLinesAndColumnsStartAt1 : false;
		this._debuggerLinesStartAt1 = linesAndColumnsStartAt1;
		this._debuggerColumnsStartAt1 = linesAndColumnsStartAt1;
		this._debuggerPathsAreURIs = false;

		this._clientLinesStartAt1 = true;
		this._clientColumnsStartAt1 = true;
		this._clientPathsAreURIs = false;

		this._isServer = typeof obsolete_isServer === 'boolean' ? obsolete_isServer : false;

		this.onClose(() => {
			this.shutdown();
		});
		this.onError((_error) => {
			this.shutdown();
		});
	}

	public setDebuggerPathFormat(format: string) {
		this._debuggerPathsAreURIs = format !== 'path';
	}

	public setDebuggerLinesStartAt1(enable: boolean) {
		this._debuggerLinesStartAt1 = enable;
	}

	public setDebuggerColumnsStartAt1(enable: boolean) {
		this._debuggerColumnsStartAt1 = enable;
	}

	public setRunAsServer(enable: boolean) {
		this._isServer = enable;
	}

	public shutdown(): void {
		if (this._isServer) {
			// shutdown ignored in server mode
		} else {
			// TODO@AW
			/*
			// wait a bit before shutting down
			setTimeout(() => {
				process.exit(0);
			}, 100);
			*/
		}
	}

	protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest: ErrorDestination = ErrorDestination.User): void {

		let msg: DebugProtocol.Message;
		if (typeof codeOrMessage === 'number') {
			msg = <DebugProtocol.Message>{
				id: <number>codeOrMessage,
				format: format
			};
			if (variables) {
				msg.variables = variables;
			}
			if (dest & ErrorDestination.User) {
				msg.showUser = true;
			}
			if (dest & ErrorDestination.Telemetry) {
				msg.sendTelemetry = true;
			}
		} else {
			msg = codeOrMessage;
		}

		response.success = false;
		response.message = DebugSession.formatPII(msg.format, true, msg.variables);
		if (!response.body) {
			response.body = {};
		}
		response.body.error = msg;

		this.sendResponse(response);
	}

	public runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.Response) => void) {
		this.sendRequest('runInTerminal', args, timeout, cb);
	}

	protected dispatchRequest(request: DebugProtocol.Request): void {

		const response = new Response(request);

		try {
			if (request.command === 'initialize') {
				const args = <DebugProtocol.InitializeRequestArguments>request.arguments;

				if (typeof args.linesStartAt1 === 'boolean') {
					this._clientLinesStartAt1 = args.linesStartAt1;
				}
				if (typeof args.columnsStartAt1 === 'boolean') {
					this._clientColumnsStartAt1 = args.columnsStartAt1;
				}

				if (args.pathFormat !== 'path') {
					this.sendErrorResponse(response, 2018, 'debug adapter only supports native paths', null, ErrorDestination.Telemetry);
				} else {
					const initializeResponse = <DebugProtocol.InitializeResponse>response;
					initializeResponse.body = {};
					this.initializeRequest(initializeResponse, args);
				}

			} else if (request.command === 'launch') {
				this.launchRequest(<DebugProtocol.LaunchResponse>response, request.arguments, request);

			} else if (request.command === 'attach') {
				this.attachRequest(<DebugProtocol.AttachResponse>response, request.arguments, request);

			} else if (request.command === 'disconnect') {
				this.disconnectRequest(<DebugProtocol.DisconnectResponse>response, request.arguments, request);

			} else if (request.command === 'terminate') {
				this.terminateRequest(<DebugProtocol.TerminateResponse>response, request.arguments, request);

			} else if (request.command === 'restart') {
				this.restartRequest(<DebugProtocol.RestartResponse>response, request.arguments, request);

			} else if (request.command === 'setBreakpoints') {
				this.setBreakPointsRequest(<DebugProtocol.SetBreakpointsResponse>response, request.arguments, request);

			} else if (request.command === 'setFunctionBreakpoints') {
				this.setFunctionBreakPointsRequest(<DebugProtocol.SetFunctionBreakpointsResponse>response, request.arguments, request);

			} else if (request.command === 'setExceptionBreakpoints') {
				this.setExceptionBreakPointsRequest(<DebugProtocol.SetExceptionBreakpointsResponse>response, request.arguments, request);

			} else if (request.command === 'configurationDone') {
				this.configurationDoneRequest(<DebugProtocol.ConfigurationDoneResponse>response, request.arguments, request);

			} else if (request.command === 'continue') {
				this.continueRequest(<DebugProtocol.ContinueResponse>response, request.arguments, request);

			} else if (request.command === 'next') {
				this.nextRequest(<DebugProtocol.NextResponse>response, request.arguments, request);

			} else if (request.command === 'stepIn') {
				this.stepInRequest(<DebugProtocol.StepInResponse>response, request.arguments, request);

			} else if (request.command === 'stepOut') {
				this.stepOutRequest(<DebugProtocol.StepOutResponse>response, request.arguments, request);

			} else if (request.command === 'stepBack') {
				this.stepBackRequest(<DebugProtocol.StepBackResponse>response, request.arguments, request);

			} else if (request.command === 'reverseContinue') {
				this.reverseContinueRequest(<DebugProtocol.ReverseContinueResponse>response, request.arguments, request);

			} else if (request.command === 'restartFrame') {
				this.restartFrameRequest(<DebugProtocol.RestartFrameResponse>response, request.arguments, request);

			} else if (request.command === 'goto') {
				this.gotoRequest(<DebugProtocol.GotoResponse>response, request.arguments, request);

			} else if (request.command === 'pause') {
				this.pauseRequest(<DebugProtocol.PauseResponse>response, request.arguments, request);

			} else if (request.command === 'stackTrace') {
				this.stackTraceRequest(<DebugProtocol.StackTraceResponse>response, request.arguments, request);

			} else if (request.command === 'scopes') {
				this.scopesRequest(<DebugProtocol.ScopesResponse>response, request.arguments, request);

			} else if (request.command === 'variables') {
				this.variablesRequest(<DebugProtocol.VariablesResponse>response, request.arguments, request);

			} else if (request.command === 'setVariable') {
				this.setVariableRequest(<DebugProtocol.SetVariableResponse>response, request.arguments, request);

			} else if (request.command === 'setExpression') {
				this.setExpressionRequest(<DebugProtocol.SetExpressionResponse>response, request.arguments, request);

			} else if (request.command === 'source') {
				this.sourceRequest(<DebugProtocol.SourceResponse>response, request.arguments, request);

			} else if (request.command === 'threads') {
				this.threadsRequest(<DebugProtocol.ThreadsResponse>response, request);

			} else if (request.command === 'terminateThreads') {
				this.terminateThreadsRequest(<DebugProtocol.TerminateThreadsResponse>response, request.arguments, request);

			} else if (request.command === 'evaluate') {
				this.evaluateRequest(<DebugProtocol.EvaluateResponse>response, request.arguments, request);

			} else if (request.command === 'stepInTargets') {
				this.stepInTargetsRequest(<DebugProtocol.StepInTargetsResponse>response, request.arguments, request);

			} else if (request.command === 'gotoTargets') {
				this.gotoTargetsRequest(<DebugProtocol.GotoTargetsResponse>response, request.arguments, request);

			} else if (request.command === 'completions') {
				this.completionsRequest(<DebugProtocol.CompletionsResponse>response, request.arguments, request);

			} else if (request.command === 'exceptionInfo') {
				this.exceptionInfoRequest(<DebugProtocol.ExceptionInfoResponse>response, request.arguments, request);

			} else if (request.command === 'loadedSources') {
				this.loadedSourcesRequest(<DebugProtocol.LoadedSourcesResponse>response, request.arguments, request);

			} else if (request.command === 'dataBreakpointInfo') {
				this.dataBreakpointInfoRequest(<DebugProtocol.DataBreakpointInfoResponse>response, request.arguments, request);

			} else if (request.command === 'setDataBreakpoints') {
				this.setDataBreakpointsRequest(<DebugProtocol.SetDataBreakpointsResponse>response, request.arguments, request);

			} else if (request.command === 'readMemory') {
				this.readMemoryRequest(<DebugProtocol.ReadMemoryResponse>response, request.arguments, request);

			} else if (request.command === 'disassemble') {
				this.disassembleRequest(<DebugProtocol.DisassembleResponse>response, request.arguments, request);

			} else if (request.command === 'cancel') {
				this.cancelRequest(<DebugProtocol.CancelResponse>response, request.arguments, request);

			} else if (request.command === 'breakpointLocations') {
				this.breakpointLocationsRequest(<DebugProtocol.BreakpointLocationsResponse>response, request.arguments, request);

			} else {
				this.customRequest(request.command, <DebugProtocol.Response>response, request.arguments, request);
			}
		} catch (e) {
			this.sendErrorResponse(response, 1104, '{_stack}', { _exception: e.message, _stack: e.stack }, ErrorDestination.Telemetry);
		}
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void {

		response.body = response.body || {};

		// This default debug adapter does not support conditional breakpoints.
		response.body.supportsConditionalBreakpoints = false;

		// This default debug adapter does not support hit conditional breakpoints.
		response.body.supportsHitConditionalBreakpoints = false;

		// This default debug adapter does not support function breakpoints.
		response.body.supportsFunctionBreakpoints = false;

		// This default debug adapter implements the 'configurationDone' request.
		response.body.supportsConfigurationDoneRequest = true;

		// This default debug adapter does not support hovers based on the 'evaluate' request.
		response.body.supportsEvaluateForHovers = false;

		// This default debug adapter does not support the 'stepBack' request.
		response.body.supportsStepBack = false;

		// This default debug adapter does not support the 'setVariable' request.
		response.body.supportsSetVariable = false;

		// This default debug adapter does not support the 'restartFrame' request.
		response.body.supportsRestartFrame = false;

		// This default debug adapter does not support the 'stepInTargets' request.
		response.body.supportsStepInTargetsRequest = false;

		// This default debug adapter does not support the 'gotoTargets' request.
		response.body.supportsGotoTargetsRequest = false;

		// This default debug adapter does not support the 'completions' request.
		response.body.supportsCompletionsRequest = false;

		// This default debug adapter does not support the 'restart' request.
		response.body.supportsRestartRequest = false;

		// This default debug adapter does not support the 'exceptionOptions' attribute on the 'setExceptionBreakpoints' request.
		response.body.supportsExceptionOptions = false;

		// This default debug adapter does not support the 'format' attribute on the 'variables', 'evaluate', and 'stackTrace' request.
		response.body.supportsValueFormattingOptions = false;

		// This debug adapter does not support the 'exceptionInfo' request.
		response.body.supportsExceptionInfoRequest = false;

		// This debug adapter does not support the 'TerminateDebuggee' attribute on the 'disconnect' request.
		response.body.supportTerminateDebuggee = false;

		// This debug adapter does not support delayed loading of stack frames.
		response.body.supportsDelayedStackTraceLoading = false;

		// This debug adapter does not support the 'loadedSources' request.
		response.body.supportsLoadedSourcesRequest = false;

		// This debug adapter does not support the 'logMessage' attribute of the SourceBreakpoint.
		response.body.supportsLogPoints = false;

		// This debug adapter does not support the 'terminateThreads' request.
		response.body.supportsTerminateThreadsRequest = false;

		// This debug adapter does not support the 'setExpression' request.
		response.body.supportsSetExpression = false;

		// This debug adapter does not support the 'terminate' request.
		response.body.supportsTerminateRequest = false;

		// This debug adapter does not support data breakpoints.
		response.body.supportsDataBreakpoints = false;

		/** This debug adapter does not support the 'readMemory' request. */
		response.body.supportsReadMemoryRequest = false;

		/** The debug adapter does not support the 'disassemble' request. */
		response.body.supportsDisassembleRequest = false;

		/** The debug adapter does not support the 'cancel' request. */
		response.body.supportsCancelRequest = false;

		/** The debug adapter does not support the 'breakpointLocations' request. */
		response.body.supportsBreakpointLocationsRequest = false;

		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
		this.shutdown();
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, _args: DebugProtocol.LaunchRequestArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, _args: DebugProtocol.AttachRequestArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, _args: DebugProtocol.TerminateArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, _args: DebugProtocol.RestartArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, _args: DebugProtocol.SetBreakpointsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, _args: DebugProtocol.SetFunctionBreakpointsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, _args: DebugProtocol.SetExceptionBreakpointsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, _args: DebugProtocol.StepBackArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, _args: DebugProtocol.ReverseContinueArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, _args: DebugProtocol.RestartFrameArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected gotoRequest(response: DebugProtocol.GotoResponse, _args: DebugProtocol.GotoArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, _args: DebugProtocol.SourceArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, _args: DebugProtocol.TerminateThreadsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, _args: DebugProtocol.StackTraceArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, _args: DebugProtocol.ScopesArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, _args: DebugProtocol.VariablesArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, _args: DebugProtocol.SetVariableArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, _args: DebugProtocol.SetExpressionArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, _args: DebugProtocol.EvaluateArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, _args: DebugProtocol.StepInTargetsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, _args: DebugProtocol.GotoTargetsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, _args: DebugProtocol.CompletionsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, _args: DebugProtocol.ExceptionInfoArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, _args: DebugProtocol.LoadedSourcesArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, _args: DebugProtocol.DataBreakpointInfoArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, _args: DebugProtocol.SetDataBreakpointsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, _args: DebugProtocol.ReadMemoryArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, _args: DebugProtocol.DisassembleArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, _args: DebugProtocol.CancelArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, _args: DebugProtocol.BreakpointLocationsArguments, _request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	/**
	 * Override this hook to implement custom requests.
	 */
	protected customRequest(_command: string, response: DebugProtocol.Response, _args: any, _request?: DebugProtocol.Request): void {
		this.sendErrorResponse(response, 1014, 'unrecognized request', null, ErrorDestination.Telemetry);
	}

	//---- protected -------------------------------------------------------------------------------------------------

	protected convertClientLineToDebugger(line: number): number {
		if (this._debuggerLinesStartAt1) {
			return this._clientLinesStartAt1 ? line : line + 1;
		}
		return this._clientLinesStartAt1 ? line - 1 : line;
	}

	protected convertDebuggerLineToClient(line: number): number {
		if (this._debuggerLinesStartAt1) {
			return this._clientLinesStartAt1 ? line : line - 1;
		}
		return this._clientLinesStartAt1 ? line + 1 : line;
	}

	protected convertClientColumnToDebugger(column: number): number {
		if (this._debuggerColumnsStartAt1) {
			return this._clientColumnsStartAt1 ? column : column + 1;
		}
		return this._clientColumnsStartAt1 ? column - 1 : column;
	}

	protected convertDebuggerColumnToClient(column: number): number {
		if (this._debuggerColumnsStartAt1) {
			return this._clientColumnsStartAt1 ? column : column - 1;
		}
		return this._clientColumnsStartAt1 ? column + 1 : column;
	}

	protected convertClientPathToDebugger(clientPath: string): string {
		if (this._clientPathsAreURIs !== this._debuggerPathsAreURIs) {
			if (this._clientPathsAreURIs) {
				return DebugSession.uri2path(clientPath);
			} else {
				return DebugSession.path2uri(clientPath);
			}
		}
		return clientPath;
	}

	protected convertDebuggerPathToClient(debuggerPath: string): string {
		if (this._debuggerPathsAreURIs !== this._clientPathsAreURIs) {
			if (this._debuggerPathsAreURIs) {
				return DebugSession.uri2path(debuggerPath);
			} else {
				return DebugSession.path2uri(debuggerPath);
			}
		}
		return debuggerPath;
	}

	//---- private -------------------------------------------------------------------------------

	private static path2uri(path: string): string {

		path = encodeURI(path);

		let uri = new URL(`file:`);	// ignore 'path' for now
		uri.pathname = path;	// now use 'path' to get the correct percent encoding (see https://url.spec.whatwg.org)
		return uri.toString();
	}

	private static uri2path(sourceUri: string): string {

		let uri = new URL(sourceUri);
		let s = decodeURIComponent(uri.pathname);
		return s;
	}

	private static _formatPIIRegexp = /{([^}]+)}/g;

	/*
	* If argument starts with '_' it is OK to send its value to telemetry.
	*/
	private static formatPII(format: string, excludePII: boolean, args?: { [key: string]: string }): string {
		return format.replace(DebugSession._formatPIIRegexp, function (match, paramName) {
			if (excludePII && paramName.length > 0 && paramName[0] !== '_') {
				return match;
			}
			return args && args[paramName] && args.hasOwnProperty(paramName) ?
				args[paramName] :
				match;
		});
	}
}

//---------------------------------------------------------------------------

export class Handles<T> {

	private START_HANDLE = 1000;

	private _nextHandle: number;
	private _handleMap = new Map<number, T>();

	public constructor(startHandle?: number) {
		this._nextHandle = typeof startHandle === 'number' ? startHandle : this.START_HANDLE;
	}

	public reset(): void {
		this._nextHandle = this.START_HANDLE;
		this._handleMap = new Map<number, T>();
	}

	public create(value: T): number {
		const handle = this._nextHandle++;
		this._handleMap.set(handle, value);
		return handle;
	}

	public get(handle: number, dflt?: T): T | undefined {
		return this._handleMap.get(handle) || dflt;
	}
}

//---------------------------------------------------------------------------

class MockConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, _token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'markdown') {
				config.type = 'mock';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage('Cannot find a program to debug').then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

export class MockDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	constructor(private memfs: MemFS) {
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession, _executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		// @ts-ignore
		return <any>new vscode.DebugAdapterInlineImplementation(new MockDebugSession(this.memfs));
	}
}

function basename(path: string): string {
	const pos = path.lastIndexOf('/');
	if (pos >= 0) {
		return path.substring(pos + 1);
	}
	return path;
}

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class MockDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a Mock runtime (or debugger)
	private _runtime: MockRuntime;

	private _variableHandles = new Handles<string>();

	//private _configurationDone = new Subject();

	private promiseResolve?: () => void;
	private _configurationDone = new Promise<void>((r, _e) => {
		this.promiseResolve = r;
		setTimeout(r, 1000);
	});

	private _cancelationTokens = new Map<number, boolean>();
	private _isLongrunning = new Map<number, boolean>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(memfs: MemFS) {

		super();

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MockRuntime(memfs);

		// setup event handlers
		this._runtime.onStopOnEntry(() => {
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.THREAD_ID));
		});
		this._runtime.onStopOnStep(() => {
			this.sendEvent(new StoppedEvent('step', MockDebugSession.THREAD_ID));
		});
		this._runtime.onStopOnBreakpoint(() => {
			this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.THREAD_ID));
		});
		this._runtime.onStopOnDataBreakpoint(() => {
			this.sendEvent(new StoppedEvent('data breakpoint', MockDebugSession.THREAD_ID));
		});
		this._runtime.onStopOnException(() => {
			this.sendEvent(new StoppedEvent('exception', MockDebugSession.THREAD_ID));
		});
		this._runtime.onBreakpointValidated((bp: MockBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.onOutput(oe => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${oe.text}\n`);
			e.body.source = this.createSource(oe.filePath);
			e.body.line = this.convertDebuggerLineToClient(oe.line);
			e.body.column = this.convertDebuggerColumnToClient(oe.column);
			this.sendEvent(e);
		});
		this._runtime.onEnd(() => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = ['.', '['];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		//this._configurationDone.notify();
		if (this.promiseResolve) {
			this.promiseResolve();
		}
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		//logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone;

		// start the program in the runtime
		this._runtime.start(`memfs:${args.program}`, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = await Promise.all(clientLines.map(async l => {
			let { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id = id;
			return bp;
		}));

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, _request?: DebugProtocol.Request): void {

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MockDebugSession.THREAD_ID, 'thread 1')
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, _args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope('Local', this._variableHandles.create('local'), false),
				new Scope('Global', this._variableHandles.create('global'), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];

		if (this._isLongrunning.get(args.variablesReference)) {
			// long running

			if (request) {
				this._cancelationTokens.set(request.seq, false);
			}

			for (let i = 0; i < 100; i++) {
				await timeout(1000);
				variables.push({
					name: `i_${i}`,
					type: 'integer',
					value: `${i}`,
					variablesReference: 0
				});
				if (request && this._cancelationTokens.get(request.seq)) {
					break;
				}
			}

			if (request) {
				this._cancelationTokens.delete(request.seq);
			}

		} else {

			const id = this._variableHandles.get(args.variablesReference);

			if (id) {
				variables.push({
					name: id + '_i',
					type: 'integer',
					value: '123',
					variablesReference: 0
				});
				variables.push({
					name: id + '_f',
					type: 'float',
					value: '3.14',
					variablesReference: 0
				});
				variables.push({
					name: id + '_s',
					type: 'string',
					value: 'hello world',
					variablesReference: 0
				});
				variables.push({
					name: id + '_o',
					type: 'object',
					value: 'Object',
					variablesReference: this._variableHandles.create(id + '_o')
				});

				// cancelation support for long running requests
				const nm = id + '_long_running';
				const ref = this._variableHandles.create(id + '_lr');
				variables.push({
					name: nm,
					type: 'object',
					value: 'Object',
					variablesReference: ref
				});
				this._isLongrunning.set(ref, true);
			}
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, _args: DebugProtocol.ReverseContinueArguments): void {
		this._runtime.continue(true);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, _args: DebugProtocol.StepBackArguments): void {
		this._runtime.step(true);
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

		let reply: string | undefined = undefined;

		if (args.context === 'repl') {
			// 'evaluate' supports to create and delete breakpoints from the 'repl':
			const matches = /new +([0-9]+)/.exec(args.expression);
			if (matches && matches.length === 2) {
				if (this._runtime.sourceFile) {
					const mbp = await this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
					const bp = <DebugProtocol.Breakpoint>new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
					bp.id = mbp.id;
					this.sendEvent(new BreakpointEvent('new', bp));
					reply = `breakpoint created`;
				}
			} else {
				const matches = /del +([0-9]+)/.exec(args.expression);
				if (matches && matches.length === 2) {
					const mbp = this._runtime.sourceFile ? this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1]))) : undefined;
					if (mbp) {
						const bp = <DebugProtocol.Breakpoint>new Breakpoint(false);
						bp.id = mbp.id;
						this.sendEvent(new BreakpointEvent('removed', bp));
						reply = `breakpoint deleted`;
					}
				}
			}
		}

		response.body = {
			result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
			dataId: null,
			description: 'cannot break on data access',
			accessTypes: undefined,
			canPersist: false
		};

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id && id.startsWith('global_')) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ['read'];
				response.body.canPersist = false;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (let dbp of args.breakpoints) {
			// assume that id is the "address" to break on
			const ok = this._runtime.setDataBreakpoint(dbp.dataId);
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, _args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
				{
					label: 'item 10',
					sortText: '10'
				},
				{
					label: 'item 1',
					sortText: '01'
				},
				{
					label: 'item 2',
					sortText: '02'
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(_response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancelationTokens.set(args.requestId, true);
		}
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}

//------------------------------------------------------------------------------------------------------------------------------------------


/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

