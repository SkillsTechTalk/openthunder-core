// OpenAPI compatibility: does the new API description break callers of the old one?
// A change can compile and pass every test while removing a route or a response field that a client relies on.
// This compares the declared contract (OpenAPI 3.x, JSON or YAML) on the base and on the change, keyless.
// Breaking: a removed path or operation, a removed success response, a removed or retyped field in a success
// response body, a request body or field that became required, a parameter that became required.
// Additions are never breaking. External $refs are not followed and are said as a limitation.
import * as yaml from 'js-yaml';
import type { EvidenceFinding } from './types';
import type { ImportedEvidence } from './importers';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

export function parseSpec(text: string): any {
  const t = text.trim();
  return t.startsWith('{') ? JSON.parse(t) : yaml.load(t);
}

interface Ctx { doc: any; external: Set<string> }

function resolve(schema: any, ctx: Ctx, seen: Set<string> = new Set()): any {
  let s = schema;
  while (s && typeof s === 'object' && typeof s.$ref === 'string') {
    const ref: string = s.$ref;
    if (!ref.startsWith('#/')) { ctx.external.add(ref); return undefined; }
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    s = ref.slice(2).split('/').reduce((o: any, k) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), ctx.doc);
  }
  return s;
}

function typeOf(s: any): string | undefined {
  if (!s || typeof s !== 'object') return undefined;
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.slice().sort().join('|');
  if (s.properties) return 'object';
  return undefined;
}

/** Fields a client could read from a response: removal or a type change breaks it. */
function compareResponseSchema(oldS: any, newS: any, where: string, oc: Ctx, nc: Ctx, out: EvidenceFinding[], depth = 0): void {
  if (depth > 8) return;
  const o = resolve(oldS, oc), n = resolve(newS, nc);
  if (!o || !n) return;
  const ot = typeOf(o), nt = typeOf(n);
  if (ot && nt && ot !== nt) { out.push({ message: `${where}: type changed from ${ot} to ${nt}`, severity: 'error', rule: 'response-type-changed' }); return; }
  if (o.properties && typeof o.properties === 'object') {
    for (const [k, v] of Object.entries<any>(o.properties)) {
      if (!n.properties || !(k in n.properties)) out.push({ message: `${where}.${k}: field removed from the response`, severity: 'error', rule: 'response-field-removed' });
      else compareResponseSchema(v, n.properties[k], `${where}.${k}`, oc, nc, out, depth + 1);
    }
  }
  if (o.items && n.items) compareResponseSchema(o.items, n.items, `${where}[]`, oc, nc, out, depth + 1);
}

/** Fields a client must now send: a field newly required in a request body breaks old clients. */
function compareRequestSchema(oldS: any, newS: any, where: string, oc: Ctx, nc: Ctx, out: EvidenceFinding[], depth = 0): void {
  if (depth > 8) return;
  const o = resolve(oldS, oc) ?? {}, n = resolve(newS, nc);
  if (!n) return;
  const oldReq = new Set<string>(Array.isArray(o.required) ? o.required : []);
  for (const k of Array.isArray(n.required) ? n.required : []) {
    if (!oldReq.has(k)) out.push({ message: `${where}.${k}: request field is now required`, severity: 'error', rule: 'request-field-now-required' });
  }
  if (n.properties && o.properties) {
    for (const [k, v] of Object.entries<any>(n.properties)) if (k in o.properties) compareRequestSchema(o.properties[k], v, `${where}.${k}`, oc, nc, out, depth + 1);
  }
}

function successCodes(responses: any): string[] {
  return Object.keys(responses ?? {}).filter((c) => /^2\d\d$|^2XX$/i.test(c));
}

function jsonSchema(content: any): any {
  if (!content || typeof content !== 'object') return undefined;
  const key = Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0];
  return key ? content[key]?.schema : undefined;
}

/** Compare two OpenAPI 3.x documents. Returns the body of a receipt (check id openapi-compat). */
export function compareOpenApi(oldDoc: any, newDoc: any, specPath = 'openapi'): ImportedEvidence {
  const base = { kind: 'check' as const, check: { id: 'openapi-compat', version: '1' } };
  const isSpec = (d: any) => d && typeof d === 'object' && (typeof d.openapi === 'string' || typeof d.swagger === 'string') && d.paths && typeof d.paths === 'object';
  if (!isSpec(oldDoc) || !isSpec(newDoc)) {
    return { ...base, outcome: 'not-checked', summary: `${specPath} could not be read as an OpenAPI document on ${!isSpec(oldDoc) ? 'the base' : 'the change'}.`, metrics: {}, limitations: ['No compatibility comparison was possible.'], findings: [] };
  }
  if (typeof oldDoc.swagger === 'string' || typeof newDoc.swagger === 'string') {
    return { ...base, outcome: 'not-checked', summary: 'Swagger 2.0 documents are not compared yet (OpenAPI 3.x only).', metrics: {}, limitations: ['Only OpenAPI 3.x is supported.'], findings: [] };
  }
  const oc: Ctx = { doc: oldDoc, external: new Set() }, nc: Ctx = { doc: newDoc, external: new Set() };
  const out: EvidenceFinding[] = [];
  let operations = 0;
  for (const [p, oldItem] of Object.entries<any>(oldDoc.paths)) {
    const newItem = newDoc.paths[p];
    for (const m of METHODS) {
      const oldOp = oldItem?.[m];
      if (!oldOp) continue;
      operations++;
      const op = `${m.toUpperCase()} ${p}`;
      const newOp = newItem?.[m];
      if (!newOp) { out.push({ message: `${op}: operation removed`, severity: 'error', rule: newItem ? 'operation-removed' : 'path-removed' }); continue; }
      for (const code of successCodes(oldOp.responses)) {
        const nr = newOp.responses?.[code];
        if (!nr) { out.push({ message: `${op}: ${code} response removed`, severity: 'error', rule: 'response-removed' }); continue; }
        compareResponseSchema(jsonSchema(resolve(oldOp.responses[code], oc)?.content), jsonSchema(resolve(nr, nc)?.content), `${op} ${code} body`, oc, nc, out);
      }
      const ob = resolve(oldOp.requestBody, oc), nb = resolve(newOp.requestBody, nc);
      if (nb?.required && !ob?.required) out.push({ message: `${op}: request body is now required`, severity: 'error', rule: 'request-body-now-required' });
      if (nb) compareRequestSchema(jsonSchema(ob?.content), jsonSchema(nb.content), `${op} request`, oc, nc, out);
      const params = (item: any, o: any, ctx: Ctx) => [...(item?.parameters ?? []), ...(o?.parameters ?? [])].map((x: any) => resolve(x, ctx)).filter(Boolean);
      const oldParams = new Map(params(oldItem, oldOp, oc).map((x: any) => [`${x.in}:${x.name}`, x]));
      for (const np of params(newItem, newOp, nc)) {
        const key = `${np.in}:${np.name}`;
        const old = oldParams.get(key);
        if (np.required && np.in !== 'path' && (!old || !old.required)) out.push({ message: `${op}: ${np.in} parameter "${np.name}" is now required`, severity: 'error', rule: 'parameter-now-required' });
      }
    }
  }
  const limitations = ['Compares the declared API description, not the running service; an undocumented change is not seen.'];
  const ext = new Set([...oc.external, ...nc.external]);
  if (ext.size) limitations.push(`External references were not followed: ${[...ext].slice(0, 3).join(', ')}${ext.size > 3 ? ' and more' : ''}.`);
  const findings = out.map((f) => ({ ...f, file: specPath }));
  const metrics = { operationsCompared: operations, breakingChanges: findings.length };
  if (!operations) return { ...base, outcome: 'not-checked', summary: 'The base API description declares no operations to compare.', metrics, limitations, findings: [] };
  return findings.length
    ? { ...base, outcome: 'failed', summary: `${findings.length} breaking change${findings.length === 1 ? '' : 's'} to the declared API (first: ${findings[0].message}).`, metrics, limitations, findings }
    : { ...base, outcome: 'passed', summary: `No breaking change across ${operations} declared operations.`, metrics, limitations, findings: [] };
}
