import { defineConfig } from 'vitest/config';
import * as path from 'path';

// The extension imports 'vscode', which exists only inside the editor. Tests use a small stand-in.
export default defineConfig({ resolve: { alias: { vscode: path.join(__dirname, 'test', 'vscode-stub.ts') } } });
