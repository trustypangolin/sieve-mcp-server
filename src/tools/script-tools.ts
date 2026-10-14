import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AccountManager } from '../services/account-manager.js';
import type { BackupStore } from '../services/backup-store.js';
import { toLf, type SieveService } from '../services/sieve-service.js';
import { accountSelector, run } from './util.js';

const scriptName = z.string().min(1).describe('Script name exactly as listed by sieve_list_scripts (case-sensitive).');

export function registerScriptTools(
  server: McpServer,
  accounts: AccountManager,
  sieve: SieveService,
  backups: BackupStore,
): void {
  server.registerTool(
    'sieve_list_scripts',
    {
      description:
        'List the Sieve scripts stored on the server and which one is active. Only one script is active at a time; it is the one that filters incoming mail. Start here before reading or changing filters.',
      inputSchema: { ...accountSelector },
    },
    ({ accountId, accountName }) =>
      run(async () => {
        const scripts = await sieve.listScripts(accounts.resolve(accountId, accountName));
        return { scripts, active: scripts.find((s) => s.active)?.name ?? null };
      }),
  );

  server.registerTool(
    'sieve_get_script',
    {
      description:
        'Read the full source of a Sieve script. Always read the current script before changing it, and edit that text rather than writing a replacement from scratch, so existing rules are preserved.',
      inputSchema: { ...accountSelector, name: scriptName },
    },
    ({ accountId, accountName, name }) => run(() => sieve.getScript(accounts.resolve(accountId, accountName), name)),
  );

  server.registerTool(
    'sieve_check_script',
    {
      description:
        'Ask the server to validate Sieve source without saving it. Returns valid/errors/warnings from the server\'s own compiler, so it catches unsupported extensions too. sieve_put_script runs this automatically; use it directly while iterating on a draft.',
      inputSchema: {
        ...accountSelector,
        content: z.string().describe('Complete Sieve script source (RFC 5228), including its require line.'),
      },
    },
    ({ accountId, accountName, content }) =>
      run(() => sieve.checkScript(accounts.resolve(accountId, accountName), content)),
  );

  server.registerTool(
    'sieve_put_script',
    {
      description:
        'Create or replace a Sieve script. The server validates it first and nothing is written if it is invalid. Replacing an existing script requires overwrite: true; the previous version is backed up locally first (see sieve_list_backups). Recommended flow for changes: sieve_get_script → edit → sieve_put_script with dryRun: true → show the user the diff → sieve_put_script with overwrite: true once they agree. Writing never activates a script: if the script being replaced is already active, the change takes effect immediately; otherwise call sieve_activate_script.',
      inputSchema: {
        ...accountSelector,
        name: z.string().min(1).describe('Script name. Use an existing name (with overwrite: true) to replace that script.'),
        content: z.string().describe('Complete Sieve script source. Line endings are normalized to CRLF on upload.'),
        overwrite: z
          .boolean()
          .default(false)
          .describe('Must be true to replace a script that already exists. Leave false when creating a new script.'),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Validate and return the diff against the server copy without writing anything.'),
      },
    },
    ({ accountId, accountName, ...opts }) => run(() => sieve.putScript(accounts.resolve(accountId, accountName), opts)),
  );

  server.registerTool(
    'sieve_activate_script',
    {
      description:
        'Make a script the active one, so it filters all incoming mail from now on. This replaces the currently active script (which stays stored, just inactive). Only do this when the user asks for the script to go live.',
      inputSchema: { ...accountSelector, name: scriptName },
    },
    ({ accountId, accountName, name }) => run(() => sieve.activate(accounts.resolve(accountId, accountName), name)),
  );

  server.registerTool(
    'sieve_deactivate_scripts',
    {
      description:
        'Deactivate the active script, so no Sieve filtering is applied to incoming mail at all. Scripts stay stored. Only when the user explicitly wants filtering switched off.',
      inputSchema: { ...accountSelector },
    },
    ({ accountId, accountName }) => run(() => sieve.deactivate(accounts.resolve(accountId, accountName))),
  );

  server.registerTool(
    'sieve_delete_script',
    {
      description:
        'Delete a stored script from the server. Refuses to delete the active script. A local backup is saved first and its file name returned. Only when the user asks for the script to be deleted.',
      inputSchema: { ...accountSelector, name: scriptName },
    },
    ({ accountId, accountName, name }) =>
      run(() => sieve.deleteScript(accounts.resolve(accountId, accountName), name)),
  );

  server.registerTool(
    'sieve_rename_script',
    {
      description: 'Rename a script on the server. If it is active it stays active. Fails if the new name is taken.',
      inputSchema: {
        ...accountSelector,
        name: scriptName,
        newName: z.string().min(1).describe('New script name.'),
      },
    },
    ({ accountId, accountName, name, newName }) =>
      run(() => sieve.renameScript(accounts.resolve(accountId, accountName), name, newName)),
  );

  server.registerTool(
    'sieve_list_backups',
    {
      description:
        'List local backups taken automatically before scripts were overwritten or deleted, newest first. Use with sieve_get_backup to undo a change.',
      inputSchema: {
        ...accountSelector,
        name: z.string().optional().describe('Only backups of this script.'),
      },
    },
    ({ accountId, accountName, name }) =>
      run(() => ({ backups: backups.list(accounts.resolve(accountId, accountName).id, name) })),
  );

  server.registerTool(
    'sieve_get_backup',
    {
      description:
        'Read the content of a local backup. To restore it, pass the content to sieve_put_script (with overwrite: true if the script still exists).',
      inputSchema: {
        ...accountSelector,
        file: z.string().describe('Backup file name exactly as returned by sieve_list_backups.'),
      },
    },
    ({ accountId, accountName, file }) =>
      run(() => ({ file, content: toLf(backups.read(accounts.resolve(accountId, accountName).id, file)) })),
  );
}
