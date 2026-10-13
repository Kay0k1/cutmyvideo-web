import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullResult, Reporter } from '@playwright/test/reporter';

const prefix = 'cutmy-e2e-results-';
const marker = '.cutmy-generated';
const signature = 'cutmy-e2e-owned-v1';

export function localArtifactDirectory(): string {
  // Prune only directories created by this runner, never supplied output paths.
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(prefix)) continue;
    const root = join(tmpdir(), name), stamp = join(root, marker);
    try {
      if (lstatSync(root).isSymbolicLink() || !existsSync(stamp) || lstatSync(stamp).isSymbolicLink()) continue;
      if (readFileSync(stamp, 'utf8') === signature && Date.now() - lstatSync(stamp).mtimeMs > 7 * 86400_000) rmSync(root, { recursive: true, force: true });
    } catch { /* A concurrent runner may already have cleaned its directory. */ }
  }
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, marker), signature);
  return root;
}

export default class LocalArtifacts implements Reporter {
  private passed = false;
  constructor(private options: { root: string }) {}
  onEnd(result: FullResult) { this.passed = result.status === 'passed'; }
  onExit() {
    if (this.passed) rmSync(this.options.root, { recursive: true, force: true });
    else console.log(`Failure diagnostics retained for seven days: ${this.options.root}`);
  }
}
