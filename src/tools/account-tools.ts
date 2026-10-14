import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AccountManager } from '../services/account-manager.js';
import type { SieveService } from '../services/sieve-service.js';
import { accountSelector, run } from './util.js';

const tlsSchema = z
  .enum(['starttls', 'implicit', 'none'])
  .describe(
    'Transport security. "starttls" (default, standard for port 4190) upgrades the connection and refuses to continue if the server cannot; "implicit" for a port that speaks TLS from the first byte; "none" sends the password unencrypted — only for localhost or a trusted network.',
  );

export function registerAccountTools(server: McpServer, accounts: AccountManager, sieve: SieveService): void {
  server.registerTool(
    'sieve_list_accounts',
    {
      description:
        'List configured ManageSieve accounts (name, host, port, tls, user, and where the password comes from — never the password itself). Call this first when the user has more than one mailbox, to get the accountName for other tools.',
      inputSchema: {},
    },
    () => run(() => ({ accounts: accounts.list(), configDirectory: accounts.home })),
  );

  server.registerTool(
    'sieve_add_account',
    {
      description:
        'Add a ManageSieve account. Prefer telling the user to run `sieve-mcp-setup add` (or `sieve-mcp-setup import-imap`) in a terminal so the password is typed there instead of passing through this conversation; use this tool only if the user explicitly provides the details here. By default the connection and login are tested first and nothing is saved if they fail. The account is stored in the shared encrypted store used by every MCP client on this machine.',
      inputSchema: {
        name: z.string().describe('Short unique name for the account, e.g. "personal" or "work".'),
        host: z.string().describe('ManageSieve server host name. Often the same as the IMAP host.'),
        port: z.number().int().min(1).max(65535).default(4190).describe('ManageSieve port; 4190 is standard.'),
        tls: tlsSchema.default('starttls'),
        user: z.string().describe('Login name, usually the full email address.'),
        password: z
          .string()
          .describe(
            'Password or app password. Pass an empty string to supply it instead via the SIEVE_MCP_ACCOUNT_<NAME>_PASSWORD environment variable in the MCP client config.',
          ),
        allowInvalidCertificate: z
          .boolean()
          .default(false)
          .describe('Skip TLS certificate verification. Only for a self-signed certificate the user trusts.'),
        test: z.boolean().default(true).describe('Connect and log in before saving; nothing is saved if this fails.'),
      },
    },
    ({ test, ...input }) =>
      run(async () => {
        const account = { ...input, allowInvalidCertificate: input.allowInvalidCertificate || undefined };
        let capabilities;
        if (test && account.password) {
          capabilities = await sieve.capabilities({ ...account, id: 'pending' });
        }
        const saved = accounts.add(account);
        return {
          account: saved,
          tested: !!capabilities,
          implementation: capabilities?.implementation,
          sieveExtensions: capabilities?.sieveExtensions,
        };
      }),
  );

  server.registerTool(
    'sieve_update_account',
    {
      description:
        'Change connection settings of an existing account (host, port, tls, user, certificate check, name). Passwords are best changed with `sieve-mcp-setup update <name> --password` in a terminal. The account must be named explicitly.',
      inputSchema: {
        ...accountSelector,
        newName: z.string().optional().describe('Rename the account.'),
        host: z.string().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        tls: tlsSchema.optional(),
        user: z.string().optional(),
        password: z.string().optional().describe('New password. Omit to keep the current one.'),
        allowInvalidCertificate: z.boolean().optional(),
      },
    },
    ({ accountId, accountName, newName, ...patch }) =>
      run(() => {
        if (!accountId && !accountName) throw new Error('Name the account to update with accountName or accountId.');
        const account = accounts.resolve(accountId, accountName);
        return { account: accounts.update(account.id, { ...patch, name: newName }) };
      }),
  );

  server.registerTool(
    'sieve_remove_account',
    {
      description:
        'Remove an account from the local config. This only forgets the connection details on this machine; scripts on the server are untouched. The account must be named explicitly, and only do this when the user asks.',
      inputSchema: {
        accountName: z.string().optional().describe('Account name to remove.'),
        accountId: z.string().optional().describe('Account id to remove, as an alternative to accountName.'),
      },
    },
    ({ accountId, accountName }) =>
      run(() => {
        if (!accountId && !accountName) throw new Error('Name the account to remove with accountName or accountId.');
        const account = accounts.resolve(accountId, accountName);
        accounts.remove(account.id);
        return { removed: account.name };
      }),
  );

  server.registerTool(
    'sieve_get_capabilities',
    {
      description:
        'Connect, log in, and return the server\'s capabilities — most importantly `sieveExtensions`, the Sieve extensions this server supports (e.g. fileinto, imap4flags, vacation, regex, variables, date). Check this before writing a script that `require`s an extension. Also the quickest way to test that an account works.',
      inputSchema: { ...accountSelector },
    },
    ({ accountId, accountName }) => run(() => sieve.capabilities(accounts.resolve(accountId, accountName))),
  );
}
