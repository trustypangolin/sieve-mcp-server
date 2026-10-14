import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountManager } from '../src/services/account-manager.js';
import { BackupStore } from '../src/services/backup-store.js';
import { SieveService } from '../src/services/sieve-service.js';
import { registerTools } from '../src/tools/index.js';
import { startFakeServer, type FakeServer } from './fake-server.js';

let dir: string;
let fake: FakeServer;
let client: Client;
let accounts: AccountManager;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sieve-mcp-'));
  fake = await startFakeServer({ scripts: { main: 'keep;\r\n' }, active: 'main' });
  accounts = new AccountManager(dir);
  const backups = new BackupStore(path.join(dir, 'backups'));
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, accounts, new SieveService(backups), backups);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
}

describe('MCP tools', () => {
  it('registers the sieve_* tool set', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'sieve_activate_script',
      'sieve_add_account',
      'sieve_check_script',
      'sieve_deactivate_scripts',
      'sieve_delete_script',
      'sieve_get_backup',
      'sieve_get_capabilities',
      'sieve_get_script',
      'sieve_list_accounts',
      'sieve_list_backups',
      'sieve_list_scripts',
      'sieve_put_script',
      'sieve_remove_account',
      'sieve_rename_script',
      'sieve_update_account',
    ]);
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(40);
  });

  it('returns structured errors instead of throwing', async () => {
    const result = await call('sieve_list_scripts');
    expect(result.isError).toBe(true);
    expect(result.data.error).toMatch(/No Sieve accounts configured/);
  });

  it('adds an account after testing it, then works end to end', async () => {
    const added = await call('sieve_add_account', {
      name: 'test',
      host: '127.0.0.1',
      port: fake.port,
      tls: 'none',
      user: 'alice@example.com',
      password: 's3cret!',
    });
    expect(added.isError).toBe(false);
    expect(added.data).toMatchObject({ tested: true, implementation: 'Fake Sieve 1.0' });
    expect(JSON.stringify(added.data)).not.toContain('s3cret!');

    expect((await call('sieve_list_scripts')).data).toEqual({ scripts: [{ name: 'main', active: true }], active: 'main' });

    const put = await call('sieve_put_script', { name: 'main', content: 'discard;\n', overwrite: true });
    expect(put.data).toMatchObject({ written: true });

    const backups = await call('sieve_list_backups', { name: 'main' });
    expect(backups.data.backups).toHaveLength(1);
    const backup = await call('sieve_get_backup', { file: backups.data.backups[0].file });
    expect(backup.data.content).toBe('keep;\n');
  });

  it('does not save an account whose login fails', async () => {
    const result = await call('sieve_add_account', {
      name: 'bad',
      host: '127.0.0.1',
      port: fake.port,
      tls: 'none',
      user: 'alice@example.com',
      password: 'wrong',
    });
    expect(result.isError).toBe(true);
    expect(accounts.list()).toEqual([]);
  });

  it('requires an explicit account to remove', async () => {
    accounts.add({ name: 'only', host: 'h', port: 4190, tls: 'starttls', user: 'u', password: 'p' });
    expect((await call('sieve_remove_account')).isError).toBe(true);
    expect(accounts.list()).toHaveLength(1);
    expect((await call('sieve_remove_account', { accountName: 'only' })).data).toEqual({ removed: 'only' });
  });
});
