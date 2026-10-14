import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../src/services/backup-store.js';
import { SieveService } from '../src/services/sieve-service.js';
import type { SieveAccount } from '../src/types.js';
import { startFakeServer, type FakeOptions, type FakeServer } from './fake-server.js';

const ORIGINAL = 'require ["fileinto"];\r\nif header :contains "from" "news@" { fileinto "News"; }\r\n';

let dir: string;
let fake: FakeServer;
let backups: BackupStore;
let service: SieveService;
let account: SieveAccount;

async function setup(opts: FakeOptions = {}) {
  fake = await startFakeServer({ scripts: { main: ORIGINAL, spare: 'keep;\r\n' }, active: 'main', ...opts });
  account = {
    id: 'acct-1',
    name: 'test',
    host: '127.0.0.1',
    port: fake.port,
    tls: 'none',
    user: 'alice@example.com',
    password: 's3cret!',
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sieve-mcp-'));
  backups = new BackupStore(path.join(dir, 'backups'));
  service = new SieveService(backups);
});

afterEach(async () => {
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading', () => {
  beforeEach(() => setup());

  it('lists scripts with the active flag', async () => {
    expect(await service.listScripts(account)).toEqual([
      { name: 'main', active: true },
      { name: 'spare', active: false },
    ]);
  });

  it('returns script content with LF line endings', async () => {
    const script = await service.getScript(account, 'main');
    expect(script).toMatchObject({ name: 'main', active: true });
    expect(script.content).toBe(ORIGINAL.replace(/\r\n/g, '\n'));
  });

  it('reports capabilities and logs out', async () => {
    const caps = await service.capabilities(account);
    expect(caps.sieveExtensions).toContain('fileinto');
    expect(caps.version).toBe('1.0');
    expect(caps.secure).toBe(false);
    expect(fake.commands).toEqual(['AUTHENTICATE', 'LOGOUT']);
  });

  it('names missing scripts and lists what exists', async () => {
    await expect(service.getScript(account, 'nope')).rejects.toThrow(/No script named "nope".*"main", "spare"/);
  });

  it('fails authentication without echoing the password', async () => {
    const err = await service.listScripts({ ...account, password: 'wrong-pass' }).catch((e) => e);
    expect(err.message).toMatch(/Authentication failed for "alice@example.com"/);
    expect(err.message).not.toContain('wrong-pass');
  });
});

describe('sieve_put_script guards', () => {
  beforeEach(() => setup());
  const edited = ORIGINAL.replace(/\r\n/g, '\n') + 'if header :contains "subject" "invoice" { fileinto "Bills"; }\n';

  it('creates a new script without activating it, uploading CRLF', async () => {
    const result = await service.putScript(account, { name: 'new', content: 'keep;\n' });
    expect(result).toMatchObject({ written: true, existed: false, active: false });
    expect(result.note).toMatch(/NOT active/);
    expect(fake.scripts.get('new')).toBe('keep;\r\n');
    expect(fake.active()).toBe('main');
    expect(fake.commands).not.toContain('SETACTIVE');
  });

  it('refuses to replace an existing script without overwrite, but shows the diff', async () => {
    const result = await service.putScript(account, { name: 'main', content: edited });
    expect(result.written).toBe(false);
    expect(result.note).toMatch(/already exists and is ACTIVE.*overwrite: true/);
    expect(result.diff).toContain('+if header :contains "subject" "invoice"');
    expect(fake.scripts.get('main')).toBe(ORIGINAL);
    expect(fake.commands).not.toContain('PUTSCRIPT');
  });

  it('dry run validates and diffs without writing', async () => {
    const result = await service.putScript(account, { name: 'main', content: edited, overwrite: true, dryRun: true });
    expect(result).toMatchObject({ written: false, dryRun: true, check: { valid: true, method: 'CHECKSCRIPT' } });
    expect(result.diff).toContain('+if header :contains "subject" "invoice"');
    expect(fake.commands).not.toContain('PUTSCRIPT');
  });

  it('never writes an invalid script, even with overwrite', async () => {
    const result = await service.putScript(account, { name: 'main', content: 'syntaxerror;\n', overwrite: true });
    expect(result.written).toBe(false);
    expect(result.check).toMatchObject({ valid: false, errors: expect.stringContaining('unknown command') });
    expect(fake.scripts.get('main')).toBe(ORIGINAL);
  });

  it('backs up the previous version before overwriting', async () => {
    const result = await service.putScript(account, { name: 'main', content: edited, overwrite: true });
    expect(result).toMatchObject({ written: true, active: true });
    expect(result.note).toMatch(/ACTIVE/);
    expect(readFileSync(result.backupFile!, 'utf8')).toBe(ORIGINAL);
    expect(fake.scripts.get('main')).toBe(edited.replace(/\n/g, '\r\n'));
    expect(backups.list(account.id, 'main')).toHaveLength(1);
  });

  it('skips the write when nothing changed', async () => {
    const result = await service.putScript(account, { name: 'main', content: ORIGINAL, overwrite: true });
    expect(result).toMatchObject({ written: false, unchanged: true });
    expect(fake.commands).not.toContain('PUTSCRIPT');
  });

  it('passes through server warnings', async () => {
    const result = await service.putScript(account, { name: 'w', content: 'keep; # warnme\n' });
    expect(result.written).toBe(true);
    expect(result.check.warnings).toMatch(/warning/);
    expect(result.serverWarnings).toMatch(/warning/);
  });

  it('rejects script names with control characters', async () => {
    await expect(service.putScript(account, { name: 'a\nb', content: 'keep;' })).rejects.toThrow(/control characters/);
  });
});

describe('activation, delete, rename', () => {
  beforeEach(() => setup());

  it('activates and reports the previously active script', async () => {
    expect(await service.activate(account, 'spare')).toEqual({ active: 'spare', previouslyActive: 'main' });
    expect(fake.active()).toBe('spare');
  });

  it('deactivates all scripts', async () => {
    expect(await service.deactivate(account)).toEqual({ previouslyActive: 'main' });
    expect(fake.active()).toBeNull();
  });

  it('refuses to delete the active script', async () => {
    await expect(service.deleteScript(account, 'main')).rejects.toThrow(/active script/);
    expect(fake.scripts.has('main')).toBe(true);
    expect(fake.commands).not.toContain('DELETESCRIPT');
  });

  it('backs up then deletes an inactive script', async () => {
    const result = await service.deleteScript(account, 'spare');
    expect(fake.scripts.has('spare')).toBe(false);
    expect(readFileSync(result.backupFile, 'utf8')).toBe('keep;\r\n');
  });

  it('renames with RENAMESCRIPT and keeps it active', async () => {
    const result = await service.renameScript(account, 'main', 'filters');
    expect(result).toMatchObject({ method: 'RENAMESCRIPT', active: true });
    expect(fake.active()).toBe('filters');
  });

  it('refuses to rename onto an existing name', async () => {
    await expect(service.renameScript(account, 'main', 'spare')).rejects.toThrow(/already exists/);
  });
});

describe('pre-RFC 5804 servers', () => {
  beforeEach(() => setup({ rfc5804: false }));

  it('validates via a scratch upload and cleans it up', async () => {
    const result = await service.checkScript(account, 'keep;\n');
    expect(result).toMatchObject({ valid: true, method: 'scratch-upload' });
    expect([...fake.scripts.keys()].sort()).toEqual(['main', 'spare']);
    expect(fake.commands).not.toContain('CHECKSCRIPT');
  });

  it('reports invalid scripts from the scratch upload', async () => {
    const result = await service.checkScript(account, 'syntaxerror;\n');
    expect(result).toMatchObject({ valid: false, method: 'scratch-upload' });
    expect([...fake.scripts.keys()].sort()).toEqual(['main', 'spare']);
  });

  it('renames by copy, re-activate and delete', async () => {
    const result = await service.renameScript(account, 'main', 'filters');
    expect(result).toMatchObject({ method: 'copy-and-delete', active: true });
    expect(fake.active()).toBe('filters');
    expect(fake.scripts.get('filters')).toBe(ORIGINAL);
    expect(fake.scripts.has('main')).toBe(false);
  });
});

describe('transport security', () => {
  it('refuses to authenticate when STARTTLS is required but not offered', async () => {
    await setup({ starttls: false });
    await expect(service.listScripts({ ...account, tls: 'starttls' })).rejects.toThrow(/does not offer STARTTLS/);
    expect(fake.commands).not.toContain('AUTHENTICATE');
  });

  it('upgrades with STARTTLS and re-reads capabilities before authenticating', async () => {
    await setup({ starttls: true, saslOnlyAfterTls: true });
    const tlsAccount = { ...account, tls: 'starttls' as const, allowInvalidCertificate: true };
    const caps = await service.capabilities(tlsAccount);
    expect(caps).toMatchObject({ secure: true, starttls: false, sasl: ['PLAIN'] });
    expect(fake.commands).toEqual(['STARTTLS', 'AUTHENTICATE', 'LOGOUT']);
    expect(await service.listScripts(tlsAccount)).toHaveLength(2);
  });

  it('asks for capabilities itself when an old server stays silent after STARTTLS', async () => {
    await setup({ starttls: true, silentAfterTls: true });
    const caps = await service.capabilities({ ...account, tls: 'starttls', allowInvalidCertificate: true });
    expect(caps.secure).toBe(true);
    expect(fake.commands).toEqual(['STARTTLS', 'CAPABILITY', 'AUTHENTICATE', 'LOGOUT']);
  });

  it('verifies the certificate by default and sends no credentials when it fails', async () => {
    await setup({ starttls: true });
    await expect(service.listScripts({ ...account, tls: 'starttls' })).rejects.toThrow(/self[- ]signed/i);
    expect(fake.commands).not.toContain('AUTHENTICATE');
  });

  it('supports implicit TLS', async () => {
    await setup({ implicitTls: true });
    const caps = await service.capabilities({ ...account, tls: 'implicit', allowInvalidCertificate: true });
    expect(caps.secure).toBe(true);
  });

  it('reports connection failures clearly', async () => {
    await setup();
    await fake.close();
    await expect(service.listScripts(account)).rejects.toThrow(/Could not connect to 127\.0\.0\.1/);
  });
});
