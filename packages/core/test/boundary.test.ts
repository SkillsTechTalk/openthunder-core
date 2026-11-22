import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The public/private boundary (docs/BOUNDARY.md): this package must build and run with no private OpenThunder package.
const ROOT = path.join(__dirname, '..');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('boundary', () => {
  it('no source file imports a private @openthunder package or reaches outside the package', () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(ROOT, 'src')).filter((x) => x.endsWith('.ts'))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith('@openthunder/') || spec.startsWith('../../')) offenders.push(`${path.relative(ROOT, f)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime dependencies are public npm packages only', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.entries<string>(pkg.dependencies ?? {});
    expect(deps.filter(([n, v]) => n.startsWith('@openthunder/') || v.startsWith('workspace:'))).toEqual([]);
    expect(deps.map(([n]) => n)).toEqual(['js-yaml']);
  });

  it('the build config does not extend the monorepo', () => {
    const ts = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    expect(ts.extends).toBeUndefined();
  });
});
