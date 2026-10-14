import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountManager, assertCredentialsResolved, envVarName } from '../src/services/account-manager.js';
import { BackupStore } from '../src/services/backup-store.js';
import { readImapMcpAccounts } from '../src/services/imap-import.js';

let dir: string;

const input = {
  name: 'Personal Mail',
  host: 'mail.example.com',
  port: 4190,
  tls: 'starttls' as const,
  user: 'alice@example.com',
  password: 'hunter2-very-secret',
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sieve-mcp-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('SIEVE_MCP_ACCOUNT_')) delete process.env[key];
});

describe('AccountManager', () => {
  it('encrypts passwords at rest and never returns them from list()', () => {
    const accounts = new AccountManager(dir);
    const saved = accounts.add(input);
    expect(saved).not.toHaveProperty('password');
    expect(saved.passwordSource).toBe('stored');
    expect(readFileSync(path.join(dir, 'accounts.json'), 'utf8')).not.toContain(input.password);
    expect(JSON.stringify(accounts.list())).not.toContain(input.password);
    expect(accounts.resolve(undefined, 'personal mail').password).toBe(input.password);
  });

  it('shares the store between independent processes/clients', () => {
    new AccountManager(dir).add(input);
    const other = new AccountManager(dir);
    expect(other.resolve().password).toBe(input.password);
  });

  it('picks up accounts added after construction (no restart needed)', () => {
    const server = new AccountManager(dir);
    expect(() => server.resolve()).toThrow(/No Sieve accounts configured/);
    new AccountManager(dir).add(input);
    expect(server.resolve().name).toBe('Personal Mail');
  });

  it('resolves by id, by name, or the single default; errors when ambiguous', () => {
    const accounts = new AccountManager(dir);
    const a = accounts.add(input);
    const b = accounts.add({ ...input, name: 'work' });
    expect(accounts.resolve(a.id).name).toBe('Personal Mail');
    expect(accounts.resolve(undefined, 'WORK').id).toBe(b.id);
    expect(() => accounts.resolve()).toThrow(/2 accounts are configured/);
    expect(() => accounts.resolve(undefined, 'nope')).toThrow(/No account named "nope"/);
  });

  it('rejects duplicate names and invalid settings', () => {
    const accounts = new AccountManager(dir);
    accounts.add(input);
    expect(() => accounts.add({ ...input, name: 'PERSONAL MAIL' })).toThrow(/already exists/);
    expect(() => accounts.add({ ...input, name: 'x', port: 0 })).toThrow(/Invalid port/);
    expect(() => accounts.add({ ...input, name: 'y', tls: 'ssl' as never })).toThrow(/tls must be/);
  });

  it('updates settings and re-encrypts a new password', () => {
    const accounts = new AccountManager(dir);
    const { id } = accounts.add(input);
    accounts.update(id, { host: 'sieve.example.com', password: 'new-pass-123' });
    const account = accounts.resolve(id);
    expect(account).toMatchObject({ host: 'sieve.example.com', password: 'new-pass-123', user: input.user });
    expect(readFileSync(path.join(dir, 'accounts.json'), 'utf8')).not.toContain('new-pass-123');
  });

  it('takes credentials from env vars, then removes them from process.env', () => {
    const accounts0 = new AccountManager(dir);
    accounts0.add({ ...input, password: '' });
    const varName = envVarName('Personal Mail', 'PASSWORD');
    expect(varName).toBe('SIEVE_MCP_ACCOUNT_PERSONAL_MAIL_PASSWORD');
    process.env[varName] = 'from-env';
    const accounts = new AccountManager(dir);
    expect(process.env[varName]).toBeUndefined();
    expect(accounts.resolve().password).toBe('from-env');
    expect(accounts.list()[0].passwordSource).toBe('environment');
  });

  it('names the missing env var instead of connecting with a blank password', () => {
    const accounts = new AccountManager(dir);
    accounts.add({ ...input, password: '' });
    expect(accounts.list()[0].passwordSource).toBe('missing');
    expect(() => assertCredentialsResolved(accounts.resolve())).toThrow(/SIEVE_MCP_ACCOUNT_PERSONAL_MAIL_PASSWORD/);
  });

  it('refuses to read credentials encrypted with a different key', () => {
    new AccountManager(dir).add(input);
    writeFileSync(path.join(dir, '.key'), crypto.randomBytes(32).toString('hex'));
    expect(() => new AccountManager(dir).resolve()).toThrow(/Cannot decrypt/);
  });
});

describe('BackupStore', () => {
  it('lists newest first and only reads its own files', () => {
    const store = new BackupStore(path.join(dir, 'backups'));
    store.save('acct', 'main', 'one');
    store.save('acct', 'main', 'two');
    store.save('acct', 'other', 'x');
    const list = store.list('acct', 'main');
    expect(list).toHaveLength(2);
    expect(list.map((b) => store.read('acct', b.file)).sort()).toEqual(['one', 'two']);
    expect(() => store.read('acct', '../../accounts.json')).toThrow(/Invalid backup file name/);
    expect(() => store.read('acct', 'missing__x.sieve')).toThrow(/No backup named/);
    expect(store.list('other-account')).toEqual([]);
  });
});

describe('imap-mcp-server import', () => {
  it('decrypts the imap-mcp store (AES-256-CBC, iv:ciphertext hex)', () => {
    const home = path.join(dir, 'imap');
    mkdirSync(home);
    const key = crypto.randomBytes(32).toString('hex');
    const encrypt = (text: string) => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
      return `${iv.toString('hex')}:${cipher.update(text, 'utf8', 'hex')}${cipher.final('hex')}`;
    };
    writeFileSync(path.join(home, '.key'), key);
    writeFileSync(
      path.join(home, 'accounts.json'),
      JSON.stringify([
        { id: '1', name: 'gmail', host: 'imap.example.com', port: 993, user: 'a@example.com', password: encrypt('pw1'), tls: true },
        { id: '2', name: 'envy', host: 'imap.example.org', port: 993, user: 'b@example.org', password: '', tls: true },
      ]),
    );
    expect(readImapMcpAccounts(home)).toEqual([
      { name: 'gmail', host: 'imap.example.com', user: 'a@example.com', password: 'pw1' },
      { name: 'envy', host: 'imap.example.org', user: 'b@example.org', password: '' },
    ]);
  });

  it('explains when there is no imap-mcp store', () => {
    expect(() => readImapMcpAccounts(path.join(dir, 'missing'))).toThrow(/No imap-mcp-server accounts found/);
  });
});
