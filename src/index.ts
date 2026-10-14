import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AccountManager } from './services/account-manager.js';
import { BackupStore } from './services/backup-store.js';
import { SieveService } from './services/sieve-service.js';
import { registerTools } from './tools/index.js';
import { PACKAGE_VERSION } from './version.js';

const INSTRUCTIONS = `Manages Sieve mail filter scripts on the user's mail server over ManageSieve (RFC 5804).
Only one script is active at a time; it filters all incoming mail.
To change filters: sieve_list_scripts, then sieve_get_script on the active script, edit that text (keep existing rules), then sieve_put_script with dryRun: true and show the user the diff, then write with overwrite: true once they agree.
Check sieve_get_capabilities before using a Sieve extension in a require line.
Never activate, deactivate, or delete scripts unless the user asks. Overwrites and deletes are backed up locally (sieve_list_backups).`;

const accounts = new AccountManager();
const backups = new BackupStore();
const sieve = new SieveService(backups);

const server = new McpServer({ name: 'sieve-mcp-server', version: PACKAGE_VERSION }, { instructions: INSTRUCTIONS });
registerTools(server, accounts, sieve, backups);

async function main() {
  await server.connect(new StdioServerTransport());
  // stdout carries JSON-RPC; diagnostics go to stderr only.
  console.error(`sieve-mcp-server ${PACKAGE_VERSION} started (config: ${accounts.home})`);
}

main().catch((err) => {
  console.error('sieve-mcp-server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
