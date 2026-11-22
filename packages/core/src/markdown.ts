// The decision as Markdown (pull request descriptions, CI run summaries). One implementation, used by the CLI, the
// GitHub Action, and the VS Code extension. What still keeps the change from Done comes first; an exception keeps the
// result the evidence gave underneath it.
import { STATUS_LABEL } from './evaluate';
import type { Decision, ItemResult } from './types';

const isOpen = (i: ItemResult) => i.required && (i.status === 'failed' || i.status === 'not-checked' || i.status === 'outdated');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function evidence(i: ItemResult): string {
  if (i.status === 'exception') return `Was ${STATUS_LABEL[i.underlying!]}: ${i.evidence} Accepted by ${i.exception!.approver} ${i.exception!.untilLabel ?? `until ${i.exception!.expires}`}: "${i.exception!.reason}".`;
  return `${i.evidence}${i.basis ? ` (${i.basis})` : ''}`;
}

export function decisionMarkdown(d: Decision, opts: { heading?: string } = {}): string {
  const L = [`${opts.heading ?? '###'} Definition of Done: ${d.label}`, '', d.summary];
  const open = d.items.filter(isOpen);
  const met = d.items.filter((i) => i.required && !isOpen(i));
  const rec = d.items.filter((i) => !i.required);
  if (open.length) {
    L.push('', '**What still keeps this change from Done**', '', '| Status | Requirement | Evidence | Next |', '|---|---|---|---|');
    for (const i of open) L.push(`| ${STATUS_LABEL[i.status]} | ${cell(i.title)} | ${cell(evidence(i))} | ${cell(i.next ?? '')} |`);
  }
  if (met.length) {
    L.push('', '**Required, met**', '', '| Status | Requirement | Evidence |', '|---|---|---|');
    for (const i of met) L.push(`| ${STATUS_LABEL[i.status]} | ${cell(i.title)} | ${cell(evidence(i))} |`);
  }
  if (rec.length) {
    L.push('', '<details><summary>Recommended (never holds a change)</summary>', '', '| Status | Requirement | Evidence |', '|---|---|---|');
    for (const i of rec) L.push(`| ${STATUS_LABEL[i.status]} | ${cell(i.title)} | ${cell(evidence(i))} |`);
    L.push('', '</details>');
  }
  if (d.notes.length) L.push('', ...d.notes.map((n) => `> ${n}`));
  L.push('', `_Decided by OpenThunder Core from ${d.policy.source} (\`${d.policy.hash.slice(7, 19)}\`) at \`${d.subject.revision.slice(0, 12)}\`, ${d.evaluatedAt}._`);
  return L.join('\n');
}
