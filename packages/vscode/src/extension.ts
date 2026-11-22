// OpenThunder: Definition of Done for VS Code. Open source; built only on OpenThunder Core.
// Local only: reads files and git, never runs project code, makes no network call, needs no account or AI key.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parsePolicy, renderDecision, DEFAULT_POLICY_YAML, POLICY_FILE, LEGACY_POLICY_FILE } from 'openthunder-core';
import { gather, expiringExceptions, lineOfPath, type Gathered } from './engine';
import { panelHtml, prMarkdown, assistantPrompt, statusBarText, type PanelState } from './render';

let last: Gathered | undefined;
let lastError: string | undefined;

function cfg() { return vscode.workspace.getConfiguration('openthunderCore'); }
function root(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }

async function findReports(): Promise<string[]> {
  const globs = cfg().get<string[]>('reports', []);
  const found = new Set<string>();
  for (const g of globs) for (const u of await vscode.workspace.findFiles(g, '**/{node_modules,.git,dist,build,.next}/**', 50)) found.add(u.fsPath);
  return [...found];
}

async function findOpenApi(r: string): Promise<string[]> {
  const found = new Set<string>();
  for (const g of cfg().get<string[]>('openApiFiles', [])) for (const u of await vscode.workspace.findFiles(g, '**/node_modules/**', 20)) found.add(path.relative(r, u.fsPath).split(path.sep).join('/'));
  return [...found];
}

class DonePanel implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView;
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((m: { cmd?: string }) => {
      const map: Record<string, string> = { refresh: 'openthunderCore.refresh', copyPrSummary: 'openthunderCore.copyPrSummary', copyForAssistant: 'openthunderCore.copyForAssistant', init: 'openthunderCore.init' };
      if (m.cmd && map[m.cmd]) void vscode.commands.executeCommand(map[m.cmd]);
    });
    this.render();
  }
  render() {
    if (!this.view) return;
    const state: PanelState = last
      ? { decision: last.decision, adopted: last.adopted, policyEditedLocally: last.policyEditedLocally, reportsUsed: last.reports.filter((r) => r.status === 'used').length, reportsOutdated: last.reports.filter((r) => r.status === 'outdated').length }
      : { adopted: false, policyEditedLocally: false, reportsUsed: 0, reportsOutdated: 0, ...(lastError ? { error: lastError } : {}) };
    this.view.webview.html = panelHtml(state, crypto.randomBytes(16).toString('base64'), this.view.webview.cspSource);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const panel = new DonePanel();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'openthunderCore.focus';
  const evidence = vscode.languages.createDiagnosticCollection('OpenThunder');
  const policyDiag = vscode.languages.createDiagnosticCollection('OpenThunder policy');
  const gap = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
  });

  const decorate = () => {
    const r = root();
    for (const ed of vscode.window.visibleTextEditors) {
      if (!r || !last) { ed.setDecorations(gap, []); continue; }
      const rel = path.relative(r, ed.document.uri.fsPath).split(path.sep).join('/');
      ed.setDecorations(gap, last.coverageGaps.filter((g) => g.file === rel).map((g) => ({
        range: new vscode.Range(g.line - 1, 0, g.line - 1, 0),
        hoverMessage: new vscode.MarkdownString('**OpenThunder:** this changed line did not run under any test (from your latest coverage report).'),
      })));
    }
  };

  const publish = (r: string) => {
    evidence.clear();
    if (!last) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, d: vscode.Diagnostic) => { const k = path.join(r, file); byFile.set(k, [...(byFile.get(k) ?? []), d]); };
    for (const f of last.findings) {
      if (!f.file) continue;
      const line = Math.max(0, (f.line ?? 1) - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 200), `${f.message}${f.rule ? ` (${f.rule})` : ''}`, f.severity === 'error' ? vscode.DiagnosticSeverity.Error : f.severity === 'note' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      d.source = 'OpenThunder (from your scanner report)';
      add(f.file, d);
    }
    for (const b of last.apiBreaks) {
      let text = '';
      try { text = fs.readFileSync(path.join(r, b.file), 'utf8'); } catch { /* gone */ }
      for (const f of b.findings) {
        const apiPath = /^[A-Z]+ (\S+)/.exec(f.message)?.[1] ?? '';
        const line = lineOfPath(text, apiPath) - 1;
        const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 200), `Breaking API change vs ${last.base}: ${f.message}`, vscode.DiagnosticSeverity.Warning);
        d.source = 'OpenThunder (API compatibility)';
        add(b.file, d);
      }
    }
    for (const [file, ds] of byFile) evidence.set(vscode.Uri.file(file), ds);
  };

  const checkPolicyFile = (doc: vscode.TextDocument) => {
    const r = root();
    if (!r) return;
    const rel = path.relative(r, doc.uri.fsPath).split(path.sep).join('/');
    const configured = cfg().get<string>('policyPath', '');
    if (configured ? rel !== configured : rel !== POLICY_FILE && rel !== LEGACY_POLICY_FILE) return;
    const text = doc.getText();
    const p = parsePolicy(text);
    const ds = p.errors.map((e) => { const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 200), e, vscode.DiagnosticSeverity.Error); d.source = 'OpenThunder policy'; return d; });
    for (const n of p.notes) { const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 200), n, vscode.DiagnosticSeverity.Information); d.source = 'OpenThunder policy'; ds.push(d); }
    for (const e of expiringExceptions(text, new Date().toISOString().slice(0, 10))) {
      const d = new vscode.Diagnostic(new vscode.Range(e.line - 1, 0, e.line - 1, 200), `The exception for "${e.requirement}" expires on ${e.expires}. After that, the requirement applies again.`, vscode.DiagnosticSeverity.Warning);
      d.source = 'OpenThunder policy'; ds.push(d);
    }
    policyDiag.set(doc.uri, ds);
  };

  let running: Promise<void> | undefined;
  const refresh = async () => {
    const r = root();
    if (!r) return;
    if (running) return running;
    running = (async () => {
      try {
        last = gather({ root: r, base: cfg().get<string>('baseBranch', ''), policyPath: cfg().get<string>('policyPath', ''), reportFiles: await findReports(), openApiFiles: await findOpenApi(r) });
        lastError = undefined;
        const sb = statusBarText(last.decision, last.adopted);
        status.text = sb.text; status.tooltip = sb.tooltip; status.show();
      } catch (e) {
        last = undefined;
        lastError = `OpenThunder could not check this workspace, so nothing was decided: ${e instanceof Error ? e.message : String(e)}`;
        status.text = '$(zap) DoD: not checked'; status.tooltip = lastError; status.show();
      }
      panel.render(); publish(r); decorate();
    })().finally(() => { running = undefined; });
    return running;
  };

  let timer: NodeJS.Timeout | undefined;
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void refresh(), 600); };

  context.subscriptions.push(
    status, evidence, policyDiag, gap,
    vscode.window.registerWebviewViewProvider('openthunderCore.done', panel),
    vscode.commands.registerCommand('openthunderCore.refresh', refresh),
    vscode.commands.registerCommand('openthunderCore.focus', () => vscode.commands.executeCommand('openthunderCore.done.focus')),
    vscode.commands.registerCommand('openthunderCore.checkApi', async () => { await refresh(); const n = last?.apiBreaks.reduce((a, b) => a + b.findings.length, 0) ?? 0; void vscode.window.showInformationMessage(n ? `OpenThunder: ${n} breaking API change${n === 1 ? '' : 's'} vs ${last!.base}. See the Problems panel.` : 'OpenThunder: no breaking change in the declared API descriptions.'); }),
    vscode.commands.registerCommand('openthunderCore.copyPrSummary', async () => { if (!last) await refresh(); if (!last) return; await vscode.env.clipboard.writeText(prMarkdown(last.decision)); void vscode.window.showInformationMessage('OpenThunder: Definition of Done copied for the pull request.'); }),
    vscode.commands.registerCommand('openthunderCore.copyForAssistant', async () => { if (!last) await refresh(); if (!last) return; await vscode.env.clipboard.writeText(assistantPrompt(last.decision)); void vscode.window.showInformationMessage('OpenThunder: open items copied. Paste them into your AI assistant.'); }),
    vscode.commands.registerCommand('openthunderCore.init', async () => {
      const r = root(); if (!r) return;
      const configured = cfg().get<string>('policyPath', '');
      const existing = !configured && fs.existsSync(path.join(r, LEGACY_POLICY_FILE)) && !fs.existsSync(path.join(r, POLICY_FILE)) ? LEGACY_POLICY_FILE : undefined;
      const uri = vscode.Uri.file(path.join(r, configured || existing || POLICY_FILE));
      try { await vscode.workspace.fs.stat(uri); void vscode.window.showInformationMessage('OpenThunder: a Definition of Done already exists. Opening it.'); }
      catch { await vscode.workspace.fs.writeFile(uri, Buffer.from(DEFAULT_POLICY_YAML)); }
      await vscode.window.showTextDocument(uri);
      void vscode.window.showInformationMessage('Adjust it to what your team values, then commit it to the base branch: changes are judged by the base branch\'s copy.');
    }),
    vscode.lm.registerTool('openthunder_definition_of_done', {
      async invoke() {
        await refresh();
        if (!last) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lastError ?? 'OpenThunder could not check this workspace.')]);
        const note = last.adopted ? '' : '\n(This repository has no Definition of Done yet; this is the OpenThunder default, for information.)';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`${renderDecision(last.decision)}${note}\n\nDo not weaken the policy, delete tests, or lower thresholds to make an item pass.`)]);
      },
      prepareInvocation() { return { invocationMessage: 'Checking the Definition of Done (local, deterministic)' }; },
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => { checkPolicyFile(doc); soon(); }),
    vscode.workspace.onDidOpenTextDocument(checkPolicyFile),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
  );
  // Re-check when evidence appears or changes, and when the branch or commit changes.
  for (const glob of ['**/{junit*.xml,TEST-*.xml,lcov.info,*.sarif}', '**/.done/receipts/*.json', '**/.git/HEAD']) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    context.subscriptions.push(w, w.onDidChange(soon), w.onDidCreate(soon), w.onDidDelete(soon));
  }
  for (const doc of vscode.workspace.textDocuments) checkPolicyFile(doc);
  void refresh();
}

export function deactivate() { /* nothing to clean up beyond subscriptions */ }
