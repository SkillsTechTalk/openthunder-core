import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The open extension may use OpenThunder Core and VS Code only: no private package, no network client.
const SRC = path.join(__dirname, '..', 'src');

describe('boundary', () => {
  it('imports only openthunder-core among OpenThunder packages, and makes no network call', () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      for (const m of text.matchAll(/from\s+['"](@openthunder\/[^'"]+)['"]/g)) if (m[1] !== 'openthunder-core') offenders.push(`${f}: ${m[1]}`);
      if (/\bfetch\(|https?\.request\(|new WebSocket\(/.test(text)) offenders.push(`${f}: network call`);
    }
    expect(offenders).toEqual([]);
  });
});
