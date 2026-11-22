// What the extension shows and copies. Pure functions over a Decision (no VS Code import), so they are tested directly.
import { STATUS_LABEL, decisionMarkdown, type Decision, type ItemResult } from 'openthunder-core';

const isOpen = (i: ItemResult) => i.required && (i.status === 'failed' || i.status === 'not-checked' || i.status === 'outdated');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Status bar text: "DoD: Done", "DoD: Done (1 exception)", "DoD: 2 open". */
export function statusBarText(d: Decision, adopted: boolean): { text: string; tooltip: string } {
  const open = d.items.filter(isOpen).length;
  const ex = d.items.filter((i) => i.required && i.status === 'exception').length;
  const text = open ? `$(zap) DoD: ${open} open` : ex ? `$(zap) DoD: Done (${ex} exception${ex === 1 ? '' : 's'})` : '$(zap) DoD: Done';
  return { text, tooltip: `${d.label}. ${d.summary}${adopted ? '' : ' (OpenThunder default; this repository has not adopted a Definition of Done.)'}` };
}

function row(i: ItemResult): string {
  const icon = i.status === 'passed' ? '✓' : i.status === 'exception' ? '◐' : i.status === 'not-applicable' ? '–' : '●';
  const detail = i.status === 'exception'
    ? `Exception: ${i.exception!.approver}, until ${i.exception!.expires}. Was ${STATUS_LABEL[i.underlying!]}: ${i.evidence}`
    : `${i.evidence}${i.basis ? ` (${i.basis})` : ''}`;
  return `<li class="item ${i.status}">
    <div class="line"><span class="icon" aria-hidden="true">${icon}</span><span class="status">${esc(STATUS_LABEL[i.status])}</span><span class="title">${esc(i.title)}</span></div>
    <div class="detail">${esc(detail)}</div>
    ${isOpen(i) && i.next ? `<div class="next">→ ${esc(i.next)}</div>` : ''}
    ${isOpen(i) ? `<div class="why">Why: ${esc(i.why)}</div>` : ''}
  </li>`;
}

export interface PanelState {
  decision?: Decision;
  adopted: boolean;
  policyEditedLocally: boolean;
  reportsUsed: number;
  reportsOutdated: number;
  error?: string;
}

/** The Definition of Done panel (the approved layout): open items first, then met, then collapsed recommended and exceptions. */
export function panelHtml(s: PanelState, nonce: string, cspSource: string): string {
  const head = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">${CSS}</style></head><body>`;
  const foot = `<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-cmd]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({cmd:b.dataset.cmd})));</script></body></html>`;
  if (s.error) return `${head}<p class="empty">${esc(s.error)}</p><button data-cmd="refresh">Check again</button>${foot}`;
  if (!s.decision) return `${head}<p class="empty">Checking…</p>${foot}`;
  const d = s.decision;
  const open = d.items.filter(isOpen);
  const met = d.items.filter((i) => i.required && !isOpen(i));
  const rec = d.items.filter((i) => !i.required);
  const exceptions = d.items.filter((i) => i.status === 'exception');
  const openCount = open.length;
  const required = d.items.filter((i) => i.required).length;
  return `${head}
  <header>
    <div class="state ${d.state}"><strong>${esc(d.label)}</strong>${openCount ? ` · ${openCount} of ${required} required open` : ''}</div>
    <div class="actions"><button data-cmd="refresh" title="Check again">⟳</button><button data-cmd="copyPrSummary" title="Copy for the pull request">⧉ Copy</button></div>
  </header>
  ${!s.adopted ? `<div class="notice">This repository has no Definition of Done yet, so this is the OpenThunder default, for information. <button class="link" data-cmd="init">Create one</button></div>` : ''}
  ${s.policyEditedLocally ? `<div class="notice">You are editing the policy. This change is still judged by the base branch's copy; your edit applies once it is reviewed and merged.</div>` : ''}
  ${open.length ? `<h2>What still keeps this change from Done</h2><ul>${open.map(row).join('')}</ul>` : ''}
  ${met.length ? `<h2>Required, met</h2><ul>${met.map(row).join('')}</ul>` : ''}
  ${rec.length ? `<details><summary>Recommended (${rec.length})</summary><ul>${rec.map(row).join('')}</ul></details>` : ''}
  ${exceptions.length ? `<details><summary>Exceptions (${exceptions.length})</summary><ul>${exceptions.map((i) => `<li class="item"><div class="title">${esc(i.title)}</div><div class="detail">${esc(i.exception!.approver)} accepted it until ${esc(i.exception!.expires)}: "${esc(i.exception!.reason)}"${i.exception!.followUp ? ` · follow-up ${esc(i.exception!.followUp)}` : ''}</div></li>`).join('')}</ul></details>` : ''}
  ${open.length ? `<button class="secondary" data-cmd="copyForAssistant">Copy open items for your AI assistant</button>` : ''}
  <footer>Judged by ${esc(d.policy.source)} · ${esc(d.policy.hash.slice(7, 11))}… · ${s.reportsUsed} report${s.reportsUsed === 1 ? '' : 's'} used${s.reportsOutdated ? `, ${s.reportsOutdated} outdated` : ''}
  <br><a href="https://openthunder.dev">Do more with OpenThunder Desktop</a></footer>
  ${foot}`;
}

/** Markdown for a pull request description (the shared Core renderer). */
export function prMarkdown(d: Decision): string {
  return decisionMarkdown(d);
}

/** A prompt for an AI coding assistant: the open requirements and how to meet them, nothing to interpret. */
export function assistantPrompt(d: Decision): string {
  const open = d.items.filter(isOpen);
  if (!open.length) return `The change meets the Definition of Done (${d.summary}). Nothing is open.`;
  return [
    `This change does not meet the team's Definition of Done yet (${d.summary})`,
    'Work through these, then I will check again. Do not weaken the policy, delete tests, or lower thresholds to make an item pass.',
    '',
    ...open.map((i, n) => `${n + 1}. ${i.title} (${STATUS_LABEL[i.status]}): ${i.evidence}${i.next ? `\n   Next: ${i.next}` : ''}`),
  ].join('\n');
}

const CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:4px 12px 16px}
header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:6px 0 10px}
.state{font-size:1.05em}.state.not-done strong{color:var(--vscode-editorWarning-foreground)}.state.done strong,.state.done-with-exceptions strong{color:var(--vscode-testing-iconPassed)}
.actions button,button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:3px 8px;border-radius:3px;cursor:pointer}
button.secondary{margin-top:10px;width:100%;padding:6px}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0;text-decoration:underline}
h2{font-size:.78em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin:14px 0 6px}
ul{list-style:none;padding:0;margin:0}.item{padding:6px 0;border-bottom:1px solid var(--vscode-widget-border,transparent)}
.line{display:flex;gap:6px;align-items:baseline}.status{font-weight:600;min-width:0;white-space:nowrap}.title{flex:1}
.detail,.why{color:var(--vscode-descriptionForeground);margin:2px 0 0 18px}.next{margin:3px 0 0 18px;color:var(--vscode-textLink-foreground)}
.failed .icon,.not-checked .icon,.outdated .icon{color:var(--vscode-editorWarning-foreground)}.failed .icon{color:var(--vscode-errorForeground)}
.passed .icon{color:var(--vscode-testing-iconPassed)}.exception .icon{color:var(--vscode-charts-yellow)}
details{margin-top:10px}summary{cursor:pointer;color:var(--vscode-descriptionForeground)}
.notice{background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-textLink-foreground);padding:6px 8px;margin:6px 0}
footer{margin-top:14px;font-size:.85em;color:var(--vscode-descriptionForeground)}footer a{color:var(--vscode-textLink-foreground)}
.empty{color:var(--vscode-descriptionForeground)}
`;
