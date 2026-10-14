import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../services/account-manager.js';
import type { BackupStore } from '../services/backup-store.js';
import type { SieveService } from '../services/sieve-service.js';
import { registerAccountTools } from './account-tools.js';
import { registerScriptTools } from './script-tools.js';

export function registerTools(server: McpServer, accounts: AccountManager, sieve: SieveService, backups: BackupStore): void {
  registerAccountTools(server, accounts, sieve);
  registerScriptTools(server, accounts, sieve, backups);
}
