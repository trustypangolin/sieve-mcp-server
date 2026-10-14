/**
 * Mirror server scripts into a local working folder for hand editing:
 * `<root>/<account>/<script>.sieve`, LF line endings. Local edits are never
 * clobbered by a pull unless forced.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SieveAccount } from '../types.js';
import { toLf, type SieveService } from './sieve-service.js';

export const DEFAULT_RULES_DIR = 'local-rules';
const EXTENSION = '.sieve';

/** A path segment safe on Windows, macOS and Linux; keeps spaces and most punctuation. */
export function safeSegment(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return cleaned || '_';
}

export function scriptFileName(scriptName: string): string {
  return `${safeSegment(scriptName)}${EXTENSION}`;
}

/** Script name implied by a local file: its base name without `.sieve`. */
export function scriptNameFromFile(file: string): string {
  const base = path.basename(file);
  return base.endsWith(EXTENSION) ? base.slice(0, -EXTENSION.length) : base;
}

export interface PullResult {
  dir: string;
  active: string | null;
  written: string[];
  unchanged: string[];
  /** Local files that differ from the server and were left alone. */
  kept: string[];
}

export async function pullScripts(
  sieve: SieveService,
  account: SieveAccount,
  root: string,
  { force = false }: { force?: boolean } = {},
): Promise<PullResult> {
  const dir = path.join(root, safeSegment(account.name));
  mkdirSync(dir, { recursive: true });
  const result: PullResult = { dir, active: null, written: [], unchanged: [], kept: [] };

  for (const script of await sieve.getAllScripts(account)) {
    if (script.active) result.active = script.name;
    const file = path.join(dir, scriptFileName(script.name));
    if (existsSync(file)) {
      const local = toLf(readFileSync(file, 'utf8'));
      if (local === script.content) {
        result.unchanged.push(file);
        continue;
      }
      if (!force) {
        result.kept.push(file);
        continue;
      }
    }
    writeFileSync(file, script.content, 'utf8');
    result.written.push(file);
  }
  return result;
}
