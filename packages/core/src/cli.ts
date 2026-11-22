#!/usr/bin/env node
// done-core: the standalone Definition of Done CLI . No account, no AI key, no network.
//
//   done-core init                                   write the default policy to .openthunder/done-core.yml
//   done-core collect --format junit|lcov|sarif --report <file> [--base <ref>]
//   done-core openapi --spec <path> --base <ref>     compare the API description on base vs this change
//   done-core evaluate --base <ref> [--now <iso>] [--json]
//   done-core keygen --out <dir>                     an Ed25519 key pair for a CI collector
//   done-core ci [--base <ref>] [--junit a,b] [--lcov f] [--sarif a,b] [--openapi spec] [--mode report|enforce]
//                                                    collect + evaluate in CI; writes the GitHub step summary and outputs
//
// Signing: when DONE_CORE_SIGNING_KEY (a PEM private key, e.g. a CI secret) and DONE_CORE_KEY_ID are set, collected
// receipts are signed and count where the policy requires trusted CI. Without them, receipts are self-reported.
// Exit codes for evaluate: 0 Done or Done with exceptions, 1 Not done, 2 could not evaluate.
import * as fs from 'fs';
import * as path from 'path';
import { importJUnit, importLcov, importSarif } from './importers';
import { compareOpenApi, parseSpec } from './openapi';
import { DEFAULT_POLICY_YAML, parsePolicy } from './policy';
import { evaluate, renderDecision } from './evaluate';
import { decisionMarkdown } from './markdown';
import { generateKeyPair } from './receipt';
import {
  buildReceipt, writeReceipt, readReceipts, repositoryIdentity, currentRevision, changedFiles, changedLines, fileAtRef, executionFromEnv,
} from './collect';

export const POLICY_FILE = '.openthunder/done-core.yml';
export const RECEIPTS_DIR = '.done/receipts';

function args(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = rest[i + 1];
    if (v !== undefined && !v.startsWith('--')) { flags[k] = v; i++; } else flags[k] = true;
  }
  return { cmd, flags };
}

function str(f: Record<string, string | true>, k: string): string | undefined {
  return typeof f[k] === 'string' ? (f[k] as string) : undefined;
}

function signing(env: NodeJS.ProcessEnv) {
  const pem = env.DONE_CORE_SIGNING_KEY;
  const id = env.DONE_CORE_KEY_ID;
  return pem && id ? { privateKeyPem: pem, keyId: id } : undefined;
}

export function main(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, out = (s: string) => console.log(s), err = (s: string) => console.error(s)): number {
  const { cmd, flags } = args(argv);
  try {
    if (cmd === 'init') {
      const file = path.join(cwd, POLICY_FILE);
      if (fs.existsSync(file)) { err(`${POLICY_FILE} already exists; edit it instead.`); return 1; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, DEFAULT_POLICY_YAML);
      out(`Wrote ${POLICY_FILE}. Commit it to the base branch: changes are judged by the base branch's copy.`);
      return 0;
    }
    if (cmd === 'keygen') {
      const dir = str(flags, 'out');
      if (!dir) { err('keygen needs --out <dir> (the private key is written there with owner-only permissions).'); return 2; }
      const kp = generateKeyPair();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'done-core-private.pem'), kp.privateKey, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'done-core-public.pem'), kp.publicKey);
      out(`Wrote ${path.join(dir, 'done-core-private.pem')} (store it as a CI secret, DONE_CORE_SIGNING_KEY) and the public key below (add it to "keys" in the policy):\n${kp.publicKey}`);
      return 0;
    }
    if (cmd === 'collect' || cmd === 'openapi') {
      const repository = str(flags, 'repository') ?? repositoryIdentity(cwd);
      const { revision, dirty } = currentRevision(cwd);
      const outDir = path.join(cwd, str(flags, 'out') ?? RECEIPTS_DIR);
      let ev;
      let artifact: { name: string; bytes: Buffer } | undefined;
      if (cmd === 'collect') {
        const format = str(flags, 'format');
        const report = str(flags, 'report');
        if (!format || !report) { err('collect needs --format junit|lcov|sarif and --report <file>.'); return 2; }
        const bytes = fs.readFileSync(path.resolve(cwd, report));
        artifact = { name: path.basename(report), bytes };
        const text = bytes.toString('utf8');
        const base = str(flags, 'base');
        if (format === 'junit') ev = importJUnit(text);
        else if (format === 'lcov') ev = importLcov(text, { ...(base ? { changedLines: changedLines(cwd, base) } : {}), stripPrefix: str(flags, 'strip-prefix') ?? `${cwd.replace(/\\/g, '/')}/` });
        else if (format === 'sarif') ev = importSarif(text);
        else { err(`Unknown format "${format}" (junit, lcov, sarif).`); return 2; }
      } else {
        const spec = str(flags, 'spec');
        const base = str(flags, 'base');
        if (!spec || !base) { err('openapi needs --spec <path> and --base <ref>.'); return 2; }
        const oldText = fileAtRef(cwd, base, spec);
        const newText = fs.existsSync(path.join(cwd, spec)) ? fs.readFileSync(path.join(cwd, spec), 'utf8') : null;
        if (oldText === null || newText === null) {
          ev = { kind: 'check' as const, check: { id: 'openapi-compat', version: '1' }, outcome: 'not-checked' as const, summary: `${spec} is missing on ${oldText === null ? `the base (${base})` : 'this change'}.`, metrics: {}, limitations: ['No comparison was possible.'], findings: [] };
        } else {
          ev = compareOpenApi(parseSpec(oldText), parseSpec(newText), spec);
          artifact = { name: path.basename(spec), bytes: Buffer.from(newText) };
        }
      }
      const execution = executionFromEnv(env);
      const r = buildReceipt(ev, { repository, revision, execution, ...(artifact ? { artifact } : {}), ...(signing(env) ? { signing: signing(env)! } : {}) });
      const file = writeReceipt(outDir, r);
      out(`${r.check.id}: ${r.summary}`);
      out(`Receipt: ${path.relative(cwd, file)} (${r.signature ? `signed with key "${r.signature.keyId}"` : 'self-reported: no signing key'}; revision ${revision.slice(0, 12)}${dirty ? ', uncommitted changes' : ''}).`);
      return 0;
    }
    if (cmd === 'ci') {
      // In a pull request, GitHub sets GITHUB_BASE_REF (e.g. "main"); the checkout needs fetch-depth: 0 for origin/<base>.
      const base = str(flags, 'base') ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined);
      if (!base) { err('ci needs --base <ref>, or run it in a pull request (GITHUB_BASE_REF).'); return 2; }
      const mode = str(flags, 'mode') ?? 'report';
      if (mode !== 'report' && mode !== 'enforce') { err('--mode must be report or enforce.'); return 2; }
      const list = (k: string) => (str(flags, k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const sign = signing(env);
      const repository = str(flags, 'repository') ?? repositoryIdentity(cwd);
      const { revision } = currentRevision(cwd);
      const execution = executionFromEnv(env);
      const receipts = [] as ReturnType<typeof buildReceipt>[];
      const missing: string[] = [];
      const add = (format: 'junit' | 'lcov' | 'sarif', file: string) => {
        const abs = path.resolve(cwd, file);
        if (!fs.existsSync(abs)) { missing.push(file); return; }
        const bytes = fs.readFileSync(abs);
        const text = bytes.toString('utf8');
        const ev = format === 'junit' ? importJUnit(text) : format === 'sarif' ? importSarif(text) : importLcov(text, { changedLines: changedLines(cwd, base), stripPrefix: `${cwd.replace(/\\/g, '/')}/` });
        receipts.push(buildReceipt(ev, { repository, revision, execution, artifact: { name: file, bytes }, ...(sign ? { signing: sign } : {}) }));
      };
      for (const f of list('junit')) add('junit', f);
      for (const f of list('lcov')) add('lcov', f);
      for (const f of list('sarif')) add('sarif', f);
      for (const spec of list('openapi')) {
        const oldText = fileAtRef(cwd, base, spec);
        const newText = fs.existsSync(path.join(cwd, spec)) ? fs.readFileSync(path.join(cwd, spec), 'utf8') : null;
        if (oldText === null || newText === null) { missing.push(`${spec} (on ${oldText === null ? base : 'this change'})`); continue; }
        receipts.push(buildReceipt(compareOpenApi(parseSpec(oldText), parseSpec(newText), spec), { repository, revision, execution, artifact: { name: spec, bytes: Buffer.from(newText) }, ...(sign ? { signing: sign } : {}) }));
      }
      // Receipts other steps wrote (for example a plugin analyzer), used as they are.
      receipts.push(...readReceipts(path.join(cwd, str(flags, 'receipts') ?? RECEIPTS_DIR)).receipts);
      const policyPath = str(flags, 'policy-path') ?? POLICY_FILE;
      const trustedText = fileAtRef(cwd, base, policyPath);
      if (trustedText === null) {
        const msg = `No ${policyPath} on ${base}, so there is no Definition of Done to check. Add one with \`done-core init\` and merge it first.`;
        if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Definition of Done: not set up\n\n${msg}\n`);
        out(msg);
        return mode === 'enforce' ? 1 : 0;
      }
      let working: string | null = null;
      try { working = fs.readFileSync(path.join(cwd, policyPath), 'utf8'); } catch { working = null; }
      const decision = evaluate({
        policy: parsePolicy(trustedText),
        integrity: { source: `${policyPath} on ${base}`, editedByChange: working !== trustedText },
        receipts, subject: { repository, revision, changedFiles: changedFiles(cwd, base) },
        now: str(flags, 'now') ?? new Date().toISOString(),
      });
      for (const m of missing) decision.notes.push(`A report named in the workflow was not found: ${m}. Its requirement stays Not checked.`);
      if (!sign) decision.notes.push('No signing key was configured (DONE_CORE_SIGNING_KEY), so this run\'s receipts are self-reported.');
      const open = decision.items.filter((i) => i.required && ['failed', 'not-checked', 'outdated'].includes(i.status)).length;
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, decisionMarkdown(decision) + '\n');
      if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `state=${decision.state}\nopen=${open}\n`);
      out(renderDecision(decision));
      if (mode === 'report' && decision.state === 'not-done') out('\n(report mode: this does not fail the job; set mode: enforce to make it required.)');
      return mode === 'enforce' && decision.state === 'not-done' ? 1 : 0;
    }
    if (cmd === 'evaluate') {
      const base = str(flags, 'base');
      if (!base) { err('evaluate needs --base <ref> (the branch the change will merge into; its policy judges the change).'); return 2; }
      const policyPath = str(flags, 'policy-path') ?? POLICY_FILE;
      const trustedText = fileAtRef(cwd, base, policyPath);
      if (trustedText === null) { err(`No ${policyPath} on ${base}. Run \`done-core init\`, commit it to ${base}, then evaluate.`); return 2; }
      let working: string | null = null;
      try { working = fs.readFileSync(path.join(cwd, policyPath), 'utf8'); } catch { working = null; }
      const { revision } = currentRevision(cwd);
      const now = str(flags, 'now') ?? new Date().toISOString();
      const { receipts, unreadable } = readReceipts(path.join(cwd, str(flags, 'receipts') ?? RECEIPTS_DIR));
      const decision = evaluate({
        policy: parsePolicy(trustedText),
        integrity: { source: `${policyPath} on ${base}`, editedByChange: working !== trustedText },
        receipts,
        subject: { repository: str(flags, 'repository') ?? repositoryIdentity(cwd), revision, changedFiles: changedFiles(cwd, base) },
        now,
      });
      for (const u of unreadable) decision.notes.push(`Receipt file ${u} could not be read and was ignored.`);
      out(flags.json ? JSON.stringify(decision, null, 2) : renderDecision(decision));
      return decision.state === 'not-done' ? 1 : 0;
    }
    out('done-core: init | ci [--base <ref>] [--junit a,b] [--lcov f] [--sarif a,b] [--openapi spec] [--mode report|enforce] | collect --format junit|lcov|sarif --report <file> [--base <ref>] | openapi --spec <path> --base <ref> | evaluate --base <ref> [--now <iso>] [--json] | keygen --out <dir>');
    return cmd === 'help' ? 0 : 2;
  } catch (e) {
    err(`done-core could not finish, so nothing was decided: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
