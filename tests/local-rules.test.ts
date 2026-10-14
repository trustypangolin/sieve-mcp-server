import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../src/services/backup-store.js';
import { pullScripts, safeSegment, scriptFileName, scriptNameFromFile } from '../src/services/local-rules.js';
import { SieveService } from '../src/services/sieve-service.js';
import type { SieveAccount } from '../src/types.js';
import { startFakeServer, type FakeServer } from './fake-server.js';

let dir: string;
let fake: FakeServer;
let service: SieveService;
let account: SieveAccount;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sieve-mcp-'));
  fake = await startFakeServer({
    scripts: { 'Mail Sorting Rules': 'require "fileinto";\r\nkeep;\r\n', 'old/test': 'discard;\r\n' },
    active: 'Mail Sorting Rules',
  });
  service = new SieveService(new BackupStore(path.join(dir, 'backups')));
  account = { id: 'a', name: 'Personal', host: '127.0.0.1', port: fake.port, tls: 'none', user: 'alice@example.com', password: 's3cret!' };
});

afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('file naming', () => {
  it('keeps spaces so the file name round-trips to the script name', () => {
    expect(scriptFileName('Mail Sorting Rules')).toBe('Mail Sorting Rules.sieve');
    expect(scriptNameFromFile(path.join('x', 'Mail Sorting Rules.sieve'))).toBe('Mail Sorting Rules');
  });

  it('replaces characters that are illegal in Windows file names', () => {
    expect(safeSegment('a/b\\c:d*e?"f<g>h|')).toBe('a_b_c_d_e__f_g_h_');
    expect(safeSegment('trailing. ')).toBe('trailing');
    expect(safeSegment('..')).toBe('_');
  });
});

describe('pullScripts', () => {
  it('writes every script with LF endings and reports the active one', async () => {
    const result = await pullScripts(service, account, dir);
    expect(result.active).toBe('Mail Sorting Rules');
    expect(result.written).toHaveLength(2);
    expect(readFileSync(path.join(dir, 'Personal', 'Mail Sorting Rules.sieve'), 'utf8')).toBe('require "fileinto";\nkeep;\n');
    expect(readFileSync(path.join(dir, 'Personal', 'old_test.sieve'), 'utf8')).toBe('discard;\n');
  });

  it('never overwrites local edits unless forced', async () => {
    await pullScripts(service, account, dir);
    const file = path.join(dir, 'Personal', 'Mail Sorting Rules.sieve');
    writeFileSync(file, 'my local edit\n');

    const second = await pullScripts(service, account, dir);
    expect(second.kept).toEqual([file]);
    expect(second.unchanged).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('my local edit\n');

    const forced = await pullScripts(service, account, dir, { force: true });
    expect(forced.written).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe('require "fileinto";\nkeep;\n');
  });

  it('treats CRLF local copies as unchanged', async () => {
    await pullScripts(service, account, dir);
    writeFileSync(path.join(dir, 'Personal', 'old_test.sieve'), 'discard;\r\n');
    expect((await pullScripts(service, account, dir)).kept).toEqual([]);
  });
});
