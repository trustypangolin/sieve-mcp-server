/**
 * Account store at `<configHome>/accounts.json`, passwords encrypted with
 * AES-256-GCM under a random key in `<configHome>/.key`.
 *
 * The file is re-read on every lookup, so an account added with the setup CLI
 * (or by another MCP client sharing the store) is visible to an
 * already-running server without a restart.
 *
 * Credentials may also come from the environment, keyed by the normalized
 * account name: SIEVE_MCP_ACCOUNT_<NAME>_USERNAME / _PASSWORD. These are
 * captured at construction, encrypted in memory and deleted from process.env.
 */
import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configHome } from '../paths.js';
import type { AccountInput, PublicAccount, SieveAccount, TlsMode } from '../types.js';

const ENV_PATTERN = /^SIEVE_MCP_ACCOUNT_.+_(?:USERNAME|PASSWORD)$/;
const TLS_MODES: readonly TlsMode[] = ['starttls', 'implicit', 'none'];

/** Uppercase, every non-alphanumeric character replaced by "_". */
export function envVarName(accountName: string, field: 'USERNAME' | 'PASSWORD'): string {
  return `SIEVE_MCP_ACCOUNT_${accountName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
}

/** Fail with the missing variable's name instead of dialing out with a blank credential. */
export function assertCredentialsResolved(account: SieveAccount): void {
  const missing: string[] = [];
  if (!account.user) missing.push(envVarName(account.name, 'USERNAME'));
  if (!account.password) missing.push(envVarName(account.name, 'PASSWORD'));
  if (missing.length) {
    throw new Error(
      `Account "${account.name}" has no ${missing.length === 1 ? 'credential' : 'credentials'} for ` +
        `${missing.join(', ')}. Set ${missing.length === 1 ? 'it' : 'them'} in the MCP client's env ` +
        'and restart, or store them with `sieve-mcp-setup update`.',
    );
  }
}

export class AccountManager {
  readonly home: string;
  private readonly accountsPath: string;
  private readonly key: Buffer;
  private readonly envOverrides = new Map<string, string>();

  constructor(home: string = configHome()) {
    this.home = home;
    this.accountsPath = path.join(home, 'accounts.json');
    this.key = this.loadOrCreateKey();
    this.captureEnvOverrides();
  }

  list(): PublicAccount[] {
    return this.load().map((stored) => this.toPublic(this.decrypted(stored)));
  }

  get(id: string): SieveAccount | undefined {
    const stored = this.load().find((a) => a.id === id);
    return stored && this.decrypted(stored);
  }

  getByName(name: string): SieveAccount | undefined {
    const stored = this.load().find((a) => a.name.toLowerCase() === name.toLowerCase());
    return stored && this.decrypted(stored);
  }

  /**
   * Resolve the account a call refers to: explicit id, else name, else the
   * only configured account. Throws an actionable error otherwise.
   */
  resolve(accountId?: string, accountName?: string): SieveAccount {
    if (accountId) {
      const account = this.get(accountId);
      if (!account) throw new Error(`Account ${accountId} not found. Use sieve_list_accounts to see accounts.`);
      return account;
    }
    if (accountName) {
      const account = this.getByName(accountName);
      if (!account) throw new Error(`No account named "${accountName}". Use sieve_list_accounts to see accounts.`);
      return account;
    }
    const all = this.load();
    if (all.length === 1) return this.decrypted(all[0]);
    if (all.length === 0) {
      throw new Error('No Sieve accounts configured. Run `sieve-mcp-setup add` (or `sieve-mcp-setup import-imap`), or use sieve_add_account.');
    }
    throw new Error(`${all.length} accounts are configured; pass accountName or accountId. Use sieve_list_accounts to see them.`);
  }

  add(input: AccountInput): PublicAccount {
    const accounts = this.load();
    validate(input);
    if (accounts.some((a) => a.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error(`An account named "${input.name}" already exists.`);
    }
    const stored: SieveAccount = { ...input, id: crypto.randomUUID(), password: this.encrypt(input.password) };
    this.save([...accounts, stored]);
    return this.toPublic(this.decrypted(stored));
  }

  update(id: string, patch: Partial<AccountInput>): PublicAccount {
    const accounts = this.load();
    const index = accounts.findIndex((a) => a.id === id);
    if (index === -1) throw new Error(`Account ${id} not found.`);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<AccountInput>;
    if (clean.name && accounts.some((a, i) => i !== index && a.name.toLowerCase() === clean.name!.toLowerCase())) {
      throw new Error(`An account named "${clean.name}" already exists.`);
    }
    const merged: SieveAccount = { ...accounts[index], ...clean, id };
    validate({ ...merged, password: '' });
    if (clean.password !== undefined) merged.password = this.encrypt(clean.password);
    accounts[index] = merged;
    this.save(accounts);
    return this.toPublic(this.decrypted(merged));
  }

  remove(id: string): void {
    const accounts = this.load();
    const remaining = accounts.filter((a) => a.id !== id);
    if (remaining.length === accounts.length) throw new Error(`Account ${id} not found.`);
    this.save(remaining);
  }

  // --- storage ------------------------------------------------------------

  private load(): SieveAccount[] {
    try {
      const parsed = JSON.parse(readFileSync(this.accountsPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read ${this.accountsPath}: ${(err as Error).message}`);
    }
  }

  /** Atomic write (temp file + rename) so a concurrent reader never sees half a file. */
  private save(accounts: SieveAccount[]): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.accountsPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    renameSync(tmp, this.accountsPath);
    restrictPermissions(this.accountsPath, 0o600);
  }

  private loadOrCreateKey(): Buffer {
    const keyPath = path.join(this.home, '.key');
    try {
      const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
      if (key.length !== 32) throw new Error(`${keyPath} is not a 256-bit hex key`);
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const key = crypto.randomBytes(32);
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, key.toString('hex'), { mode: 0o600, flag: 'wx' });
      restrictPermissions(this.home, 0o700);
      return key;
    }
  }

  // --- crypto ---------------------------------------------------------------

  private encrypt(plain: string): string {
    if (plain === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  private decrypt(value: string): string {
    if (value === '') return '';
    const [version, iv, tag, data] = value.split(':');
    if (version !== 'v1' || !iv || !tag || data === undefined) {
      throw new Error('Stored credential is not in a recognised encrypted format');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Cannot decrypt stored credential — was the .key file replaced?');
    }
  }

  // --- environment overrides ------------------------------------------------

  private captureEnvOverrides(): void {
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && ENV_PATTERN.test(name)) {
        this.envOverrides.set(name, this.encrypt(value));
        delete process.env[name];
      }
    }
  }

  private envOverride(accountName: string, field: 'USERNAME' | 'PASSWORD'): string | undefined {
    const value = this.envOverrides.get(envVarName(accountName, field));
    return value === undefined ? undefined : this.decrypt(value);
  }

  private decrypted(stored: SieveAccount): SieveAccount {
    return {
      ...stored,
      user: this.envOverride(stored.name, 'USERNAME') ?? stored.user,
      password: this.envOverride(stored.name, 'PASSWORD') ?? this.decrypt(stored.password),
    };
  }

  private toPublic(account: SieveAccount): PublicAccount {
    const { password, ...rest } = account;
    const fromEnv = this.envOverrides.has(envVarName(account.name, 'PASSWORD'));
    return { ...rest, passwordSource: fromEnv ? 'environment' : password ? 'stored' : 'missing' };
  }
}

function validate(input: AccountInput): void {
  if (!input.name?.trim()) throw new Error('Account name is required.');
  if (!input.host?.trim()) throw new Error('Host is required.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`Invalid port: ${input.port}`);
  }
  if (!TLS_MODES.includes(input.tls)) throw new Error(`tls must be one of ${TLS_MODES.join(', ')}`);
}

/** Best effort; POSIX modes don't apply on Windows (the profile directory ACL protects it there). */
function restrictPermissions(target: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(target, mode);
  } catch {
    // ignore
  }
}
