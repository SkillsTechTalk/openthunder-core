// A minimal stand-in for the VS Code API, enough to run activate() in tests and observe what it registers and shows.
export const state = {
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  tools: new Map<string, { invoke: (...a: unknown[]) => Promise<unknown>; prepareInvocation?: () => unknown }>(),
  providers: new Map<string, { resolveWebviewView: (v: unknown) => void }>(),
  clipboard: '', messages: [] as string[], statusItems: [] as { text: string; tooltip: string; shown: boolean }[],
  diagnostics: new Map<string, unknown[]>(), root: '', config: {} as Record<string, unknown>,
};
const disposable = { dispose() {} };
const event = () => () => disposable;
export class Range { constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {} }
export class Diagnostic { source?: string; constructor(public range: Range, public message: string, public severity: number) {} }
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum OverviewRulerLane { Left = 1 }
export class ThemeColor { constructor(public id: string) {} }
export class MarkdownString { constructor(public value: string) {} }
export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolResult { constructor(public content: LanguageModelTextPart[]) {} }
export const Uri = { file: (fsPath: string) => ({ fsPath, toString: () => fsPath }) };
export const workspace = {
  get workspaceFolders() { return state.root ? [{ uri: { fsPath: state.root } }] : undefined; },
  getConfiguration: () => ({ get: <T>(k: string, d: T) => (k in state.config ? state.config[k] as T : d) }),
  findFiles: async () => [], textDocuments: [] as unknown[],
  onDidSaveTextDocument: event(), onDidOpenTextDocument: event(),
  createFileSystemWatcher: () => ({ onDidChange: event(), onDidCreate: event(), onDidDelete: event(), dispose() {} }),
  fs: { stat: async () => { throw new Error('missing'); }, writeFile: async () => {} },
};
export const window = {
  createStatusBarItem: () => { const s = { text: '', tooltip: '', shown: false, command: '', show() { s.shown = true; }, dispose() {} }; state.statusItems.push(s); return s; },
  createTextEditorDecorationType: () => disposable,
  visibleTextEditors: [] as unknown[], onDidChangeVisibleTextEditors: event(),
  registerWebviewViewProvider: (id: string, p: { resolveWebviewView: (v: unknown) => void }) => { state.providers.set(id, p); return disposable; },
  showInformationMessage: async (m: string) => { state.messages.push(m); }, showTextDocument: async () => {},
};
export const languages = {
  createDiagnosticCollection: () => ({ set: (u: { fsPath: string }, d: unknown[]) => state.diagnostics.set(u.fsPath, d), clear: () => state.diagnostics.clear(), dispose() {} }),
};
export const commands = {
  registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => { state.commands.set(id, fn); return disposable; },
  executeCommand: async (id: string) => state.commands.get(id)?.(),
};
export const env = { clipboard: { writeText: async (t: string) => { state.clipboard = t; } } };
export const lm = { registerTool: (name: string, tool: { invoke: (...a: unknown[]) => Promise<unknown> }) => { state.tools.set(name, tool); return disposable; } };
