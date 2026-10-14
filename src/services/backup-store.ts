/**
 * Local copies of scripts taken before they are overwritten, renamed over, or
 * deleted: `<configHome>/backups/<accountId>/<script>__<timestamp>.sieve`.
 * Restoring is a sieve_get_backup followed by sieve_put_script.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configHome } from '../paths.js';

export interface BackupInfo {
  file: string;
  script: string;
  savedAt: string;
  bytes: number;
}

const SEPARATOR = '__';
const EXTENSION = '.sieve';

/** Filesystem-safe rendering of a script name (lossy: "a b" and "a_b" share a prefix). */
function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || '_';
}

export class BackupStore {
  constructor(private readonly root: string = path.join(configHome(), 'backups')) {}

  save(accountId: string, scriptName: string, content: string): string {
    const dir = this.dir(accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let file = path.join(dir, `${safe(scriptName)}${SEPARATOR}${stamp}${EXTENSION}`);
    for (let n = 1; exists(file); n++) {
      file = path.join(dir, `${safe(scriptName)}${SEPARATOR}${stamp}-${n}${EXTENSION}`);
    }
    writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    return file;
  }

  list(accountId: string, scriptName?: string): BackupInfo[] {
    let files: string[];
    try {
      files = readdirSync(this.dir(accountId));
    } catch {
      return [];
    }
    const prefix = scriptName === undefined ? undefined : `${safe(scriptName)}${SEPARATOR}`;
    return files
      .filter((f) => f.endsWith(EXTENSION) && f.includes(SEPARATOR) && (!prefix || f.startsWith(prefix)))
      .map((file) => {
        const stats = statSync(path.join(this.dir(accountId), file));
        return {
          file,
          script: file.slice(0, file.lastIndexOf(SEPARATOR)),
          savedAt: stats.mtime.toISOString(),
          bytes: stats.size,
        };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  read(accountId: string, file: string): string {
    // Only bare file names listed by list() are accepted — no path traversal.
    if (file !== path.basename(file) || !file.endsWith(EXTENSION)) {
      throw new Error(`Invalid backup file name: ${file}`);
    }
    if (!this.list(accountId).some((b) => b.file === file)) {
      throw new Error(`No backup named ${file} for this account. Use sieve_list_backups.`);
    }
    return readFileSync(path.join(this.dir(accountId), file), 'utf8');
  }

  private dir(accountId: string): string {
    return path.join(this.root, safe(accountId));
  }
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
