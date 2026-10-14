/**
 * Script operations with the safety rules the tools promise:
 *
 *  - every upload is validated by the server first (CHECKSCRIPT, or a scratch
 *    PUTSCRIPT on pre-RFC 5804 servers) and nothing is written if it fails;
 *  - replacing an existing script requires `overwrite: true`;
 *  - `dryRun` reports the validation result and a diff without writing;
 *  - the previous version is saved to the local backup store before any
 *    overwrite or delete (and before a copy-and-delete rename);
 *  - uploads never activate a script — activation is its own explicit call;
 *  - the active script cannot be deleted.
 */
import crypto from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import {
  ManageSieveClient,
  SieveError,
  type Capabilities,
  type CheckResult,
  type ConnectOptions,
  type ScriptInfo,
} from '../protocol/client.js';
import type { SieveAccount } from '../types.js';
import { assertCredentialsResolved } from './account-manager.js';
import type { BackupStore } from './backup-store.js';

export type Connector = (opts: ConnectOptions) => Promise<ManageSieveClient>;

export interface CheckOutcome extends CheckResult {
  method: 'CHECKSCRIPT' | 'scratch-upload';
}

export interface PutOptions {
  name: string;
  content: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface PutOutcome {
  name: string;
  written: boolean;
  dryRun: boolean;
  existed: boolean;
  active: boolean;
  unchanged: boolean;
  check: CheckOutcome;
  diff: string;
  backupFile?: string;
  serverWarnings?: string;
  note: string;
}

/** Sieve (RFC 5228) mandates CRLF line endings on the wire. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/** Scripts are shown to the model with LF endings to keep JSON readable. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function validateScriptName(name: string): void {
  if (!name) throw new Error('Script name must not be empty.');
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('Script name must not contain control characters.');
  if (name.length > 512) throw new Error('Script name is too long.');
}

export class SieveService {
  constructor(
    private readonly backups: BackupStore,
    private readonly connect: Connector = (opts) => ManageSieveClient.connect(opts),
  ) {}

  async capabilities(account: SieveAccount): Promise<Capabilities & { secure: boolean }> {
    return this.session(account, async (client) => ({ ...client.capabilities, secure: client.secure }));
  }

  async listScripts(account: SieveAccount): Promise<ScriptInfo[]> {
    return this.session(account, (client) => client.listScripts());
  }

  async getScript(account: SieveAccount, name: string): Promise<ScriptInfo & { content: string }> {
    validateScriptName(name);
    return this.session(account, async (client) => {
      const info = await this.requireScript(client, name);
      return { ...info, content: toLf(await client.getScript(name)) };
    });
  }

  async checkScript(account: SieveAccount, content: string): Promise<CheckOutcome> {
    return this.session(account, (client) => this.check(client, toCrlf(content)));
  }

  async putScript(account: SieveAccount, opts: PutOptions): Promise<PutOutcome> {
    validateScriptName(opts.name);
    const dryRun = opts.dryRun ?? false;
    const content = toCrlf(opts.content);

    return this.session(account, async (client) => {
      const existing = (await client.listScripts()).find((s) => s.name === opts.name);
      const previous = existing ? await client.getScript(opts.name) : '';
      const unchanged = !!existing && toLf(previous) === toLf(content);
      const diff = createTwoFilesPatch(
        existing ? `${opts.name} (on server)` : '/dev/null',
        `${opts.name} (proposed)`,
        toLf(previous),
        toLf(content),
        undefined,
        undefined,
        { context: 3 },
      );
      const base = { name: opts.name, dryRun, existed: !!existing, active: existing?.active ?? false, unchanged, diff };

      const check = await this.check(client, content);
      if (!check.valid) {
        return { ...base, written: false, check, note: 'The server rejected the script; nothing was written. Fix the errors and retry.' };
      }
      if (dryRun) {
        const needs = existing && !opts.overwrite ? ' Writing it will require overwrite: true.' : '';
        return { ...base, written: false, check, note: `Dry run: script is valid; nothing was written.${needs}` };
      }
      if (unchanged) {
        return { ...base, written: false, check, note: 'Script on the server is already identical; nothing was written.' };
      }
      if (existing && !opts.overwrite) {
        return {
          ...base,
          written: false,
          check,
          note: `A script named "${opts.name}" already exists${existing.active ? ' and is ACTIVE' : ''}. Review the diff and call again with overwrite: true to replace it.`,
        };
      }

      const backupFile = existing ? this.backups.save(account.id, opts.name, previous) : undefined;
      const serverWarnings = await client.putScript(opts.name, content);
      const note = existing?.active
        ? 'Written. This script is ACTIVE, so the new rules are already filtering incoming mail.'
        : 'Written. It is NOT active; call sieve_activate_script to make it the filter in use.';
      return { ...base, written: true, check, backupFile, serverWarnings, note };
    });
  }

  async activate(account: SieveAccount, name: string): Promise<{ active: string; previouslyActive: string | null }> {
    validateScriptName(name);
    return this.session(account, async (client) => {
      const scripts = await client.listScripts();
      if (!scripts.some((s) => s.name === name)) throw this.notFound(name, scripts);
      const previous = scripts.find((s) => s.active)?.name ?? null;
      await client.setActive(name);
      return { active: name, previouslyActive: previous };
    });
  }

  async deactivate(account: SieveAccount): Promise<{ previouslyActive: string | null }> {
    return this.session(account, async (client) => {
      const previous = (await client.listScripts()).find((s) => s.active)?.name ?? null;
      if (previous) await client.setActive('');
      return { previouslyActive: previous };
    });
  }

  async deleteScript(account: SieveAccount, name: string): Promise<{ deleted: string; backupFile: string }> {
    validateScriptName(name);
    return this.session(account, async (client) => {
      const info = await this.requireScript(client, name);
      if (info.active) {
        throw new Error(
          `"${name}" is the active script; deleting it would switch off filtering. ` +
            'Activate a different script (or call sieve_deactivate_scripts) first.',
        );
      }
      const backupFile = this.backups.save(account.id, name, await client.getScript(name));
      await client.deleteScript(name);
      return { deleted: name, backupFile };
    });
  }

  async renameScript(
    account: SieveAccount,
    oldName: string,
    newName: string,
  ): Promise<{ renamed: string; to: string; active: boolean; method: 'RENAMESCRIPT' | 'copy-and-delete' }> {
    validateScriptName(oldName);
    validateScriptName(newName);
    return this.session(account, async (client) => {
      const scripts = await client.listScripts();
      const info = scripts.find((s) => s.name === oldName);
      if (!info) throw this.notFound(oldName, scripts);
      if (scripts.some((s) => s.name === newName)) {
        throw new Error(`A script named "${newName}" already exists; delete or rename it first.`);
      }
      if (client.supportsRfc5804) {
        await client.renameScript(oldName, newName);
        return { renamed: oldName, to: newName, active: info.active, method: 'RENAMESCRIPT' };
      }
      const content = await client.getScript(oldName);
      this.backups.save(account.id, oldName, content);
      await client.putScript(newName, content);
      if (info.active) await client.setActive(newName);
      await client.deleteScript(oldName);
      return { renamed: oldName, to: newName, active: info.active, method: 'copy-and-delete' };
    });
  }

  // --- helpers --------------------------------------------------------------

  private async session<T>(account: SieveAccount, fn: (client: ManageSieveClient) => Promise<T>): Promise<T> {
    assertCredentialsResolved(account);
    const client = await this.connect({
      host: account.host,
      port: account.port,
      tls: account.tls,
      rejectUnauthorized: !account.allowInvalidCertificate,
    });
    try {
      await client.authenticate(account.user, account.password, account.authzid);
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  private async check(client: ManageSieveClient, content: string): Promise<CheckOutcome> {
    if (client.supportsRfc5804) {
      return { ...(await client.checkScript(content)), method: 'CHECKSCRIPT' };
    }
    // Pre-RFC 5804 servers have no CHECKSCRIPT: upload under a throwaway name
    // (the server compiles on PUTSCRIPT) and delete it again.
    const scratch = `sieve-mcp-check-${crypto.randomBytes(4).toString('hex')}`;
    try {
      const warnings = await client.putScript(scratch, content);
      await client.deleteScript(scratch);
      return { valid: true, warnings, method: 'scratch-upload' };
    } catch (err) {
      if (err instanceof SieveError && err.response && !err.code?.startsWith('QUOTA')) {
        return { valid: false, errors: err.response.message || err.message, method: 'scratch-upload' };
      }
      throw err;
    }
  }

  private async requireScript(client: ManageSieveClient, name: string): Promise<ScriptInfo> {
    const scripts = await client.listScripts();
    const info = scripts.find((s) => s.name === name);
    if (!info) throw this.notFound(name, scripts);
    return info;
  }

  private notFound(name: string, scripts: ScriptInfo[]): Error {
    const names = scripts.map((s) => `"${s.name}"`).join(', ') || 'none';
    return new Error(`No script named "${name}". Scripts on the server: ${names}.`);
  }
}
