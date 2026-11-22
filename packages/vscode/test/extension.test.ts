import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { state } from './vscode-stub';
import { activate } from '../src/extension';

// activate() against a real git repository: what the extension registers, shows, and copies.
let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-ext-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(repo, '.openthunder')); fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, '.openthunder/done-core.yml'), 'version: 1\nrequire:\n  - tests\n');
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'f');
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
  state.root = repo;
  state.config = { baseBranch: 'main' };
});
afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('activate', () => {
  const ctx = { subscriptions: [] as unknown[] };
  it('registers the commands, the panel, and the Copilot tool, and shows the answer in the status bar', async () => {
    activate(ctx as never);
    for (const c of ['openthunderCore.refresh', 'openthunderCore.init', 'openthunderCore.copyPrSummary', 'openthunderCore.copyForAssistant', 'openthunderCore.checkApi', 'openthunderCore.focus']) expect(state.commands.has(c)).toBe(true);
    expect(state.providers.has('openthunderCore.done')).toBe(true);
    expect(state.tools.has('openthunder_definition_of_done')).toBe(true);
    await state.commands.get('openthunderCore.refresh')!();
    expect(state.statusItems[0]).toMatchObject({ text: '$(zap) DoD: 1 open', shown: true });
    expect(ctx.subscriptions.length).toBeGreaterThan(10);
  });

  it('the panel renders the decision with open items first', async () => {
    const view = { webview: { options: {}, html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: () => ({ dispose() {} }) } };
    state.providers.get('openthunderCore.done')!.resolveWebviewView(view);
    expect(view.webview.html).toMatch(/Not done/);
    expect(view.webview.html).toMatch(/What still keeps this change from Done/);
    expect(view.webview.html).toMatch(/Tests run and pass/);
  });

  it('Copilot tool returns the deterministic decision and forbids gaming the policy', async () => {
    const r = await state.tools.get('openthunder_definition_of_done')!.invoke({}, {}) as { content: { value: string }[] };
    expect(r.content[0].value).toMatch(/^Definition of Done: Not done/);
    expect(r.content[0].value).toMatch(/Do not weaken the policy, delete tests, or lower thresholds/);
  });

  it('copy commands put the PR summary and the assistant prompt on the clipboard', async () => {
    await state.commands.get('openthunderCore.copyPrSummary')!();
    expect(state.clipboard).toMatch(/^### Definition of Done: Not done/);
    await state.commands.get('openthunderCore.copyForAssistant')!();
    expect(state.clipboard).toMatch(/1\. Tests run and pass \(Not checked\)/);
  });

  it('a folder that is not a git repository: nothing is decided, and it says so instead of guessing', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-ext-plain-'));
    state.root = plain;
    await state.commands.get('openthunderCore.refresh')!();
    expect(state.statusItems[0].text).toBe('$(zap) DoD: not checked');
    expect(state.statusItems[0].tooltip).toMatch(/could not check this workspace, so nothing was decided/);
    const r = await state.tools.get('openthunder_definition_of_done')!.invoke({}, {}) as { content: { value: string }[] };
    expect(r.content[0].value).toMatch(/could not check this workspace/);
    state.root = repo;
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
