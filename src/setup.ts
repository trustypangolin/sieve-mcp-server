/**
 * sieve-mcp-setup — manage accounts in the shared store from a terminal, so
 * passwords are typed here rather than pasted into a chat.
 */
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AccountManager, envVarName } from './services/account-manager.js';
import { BackupStore } from './services/backup-store.js';
import { configHome } from './paths.js';
import { readImapMcpAccounts } from './services/imap-import.js';
import { SieveService } from './services/sieve-service.js';
import type { AccountInput, SieveAccount, TlsMode } from './types.js';

const USAGE = `Usage: sieve-mcp-setup <command> [options]

Commands:
  add                      Add an account (prompts for anything not given)
  list                     List accounts (never shows passwords)
  test <name>              Connect, log in, and show server capabilities
  update <name>            Change settings; --password prompts for a new password
  remove <name>            Forget an account (scripts on the server are untouched)
  import-imap              Create accounts from imap-mcp-server's store (~/.imap-mcp)
  config                   Print MCP client configuration for Claude Desktop / Claude Code

Options:
  --name <name>            Account name (add, import-imap with --account)
  --host <host>            ManageSieve host (import-imap: overrides the IMAP host)
  --port <port>            ManageSieve port (default 4190)
  --tls <mode>             starttls (default) | implicit | none
  --user <user>            Login name
  --password               update: prompt for a new password
  --allow-invalid-cert     Skip TLS certificate verification (self-signed certs)
  --account <name>         import-imap: import only this IMAP account
  --imap-home <dir>        import-imap: imap-mcp-server config dir (default ~/.imap-mcp)
  --skip-test              Save without testing the connection first

Config directory: ${configHome()} (set SIEVE_MCP_HOME to move it)`;

class Prompter {
  private rl: readline.Interface | null = null;
  private muted = false;

  private get iface(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
      const internals = this.rl as unknown as { _writeToOutput(s: string): void };
      const write = internals._writeToOutput.bind(this.rl);
      internals._writeToOutput = (s: string) => {
        if (!this.muted) write(s);
      };
    }
    return this.rl;
  }

  ask(question: string, defaultValue?: string): Promise<string> {
    const label = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    return new Promise((resolve) => {
      this.iface.question(label, (answer) => resolve(answer.trim() || defaultValue || ''));
    });
  }

  askHidden(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.iface.question(`${question}: `, (answer) => {
        this.muted = false;
        process.stdout.write('\n');
        resolve(answer);
      });
      this.muted = true;
    });
  }

  close(): void {
    this.rl?.close();
  }
}

function parseTls(value: string | undefined): TlsMode {
  const mode = (value ?? 'starttls').toLowerCase();
  if (mode !== 'starttls' && mode !== 'implicit' && mode !== 'none') {
    throw new Error(`--tls must be starttls, implicit or none (got "${value}")`);
  }
  return mode;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

async function testAccount(sieve: SieveService, account: SieveAccount): Promise<void> {
  process.stdout.write(`Testing ${account.user}@${account.host}:${account.port} (${account.tls})... `);
  const caps = await sieve.capabilities(account);
  console.log('OK');
  console.log(`  Server:     ${caps.implementation ?? 'unknown'}${caps.version ? ` (ManageSieve ${caps.version})` : ''}`);
  console.log(`  Encrypted:  ${caps.secure ? 'yes' : 'NO'}`);
  console.log(`  Extensions: ${caps.sieveExtensions.join(' ') || '(none reported)'}`);
}

function serverEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/setup.js sits next to dist/index.js; under tsx we run from src/.
  return path.basename(here) === 'src' ? path.resolve(here, '..', 'dist', 'index.js') : path.join(here, 'index.js');
}

function printConfig(): void {
  const entry = serverEntryPath();
  const desktopConfig =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? '%APPDATA%', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? '~/Library/Application Support/Claude/claude_desktop_config.json'
        : '~/.config/Claude/claude_desktop_config.json';
  const snippet = JSON.stringify({ mcpServers: { sieve: { command: 'node', args: [entry] } } }, null, 2);
  console.log(`Claude Desktop — merge into ${desktopConfig}:\n\n${snippet}\n`);
  console.log(`Claude Code (all projects):\n\n  claude mcp add --scope user sieve -- node "${entry}"\n`);
  console.log('Both read the same accounts from the shared config directory, so set accounts up once.');
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      tls: { type: 'string' },
      user: { type: 'string' },
      password: { type: 'boolean' },
      'allow-invalid-cert': { type: 'boolean' },
      account: { type: 'string' },
      'imap-home': { type: 'string' },
      'skip-test': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const accounts = new AccountManager();
  const sieve = new SieveService(new BackupStore());
  const prompt = new Prompter();
  const requireTarget = () => {
    if (!target) throw new Error(`Usage: sieve-mcp-setup ${command} <account name>`);
    return accounts.resolve(undefined, target);
  };

  try {
    switch (command) {
      case 'list': {
        const list = accounts.list();
        if (!list.length) console.log('No accounts configured. Run `sieve-mcp-setup add` or `sieve-mcp-setup import-imap`.');
        for (const a of list) {
          console.log(`${a.name}\t${a.user}@${a.host}:${a.port}\t${a.tls}\tpassword: ${a.passwordSource}`);
        }
        break;
      }

      case 'add': {
        const name = values.name ?? (await prompt.ask('Account name', 'default'));
        const host = values.host ?? (await prompt.ask('ManageSieve host (often the IMAP host)'));
        const port = parsePort(values.port ?? (await prompt.ask('Port', '4190'))) ?? 4190;
        const tls = parseTls(values.tls ?? (await prompt.ask('TLS mode (starttls/implicit/none)', 'starttls')));
        const user = values.user ?? (await prompt.ask('Username (usually your email address)'));
        const password = await prompt.askHidden(`Password (leave empty to use ${envVarName(name, 'PASSWORD')})`);
        const input: AccountInput = { name, host, port, tls, user, password, allowInvalidCertificate: values['allow-invalid-cert'] || undefined };
        if (password && !values['skip-test']) await testAccount(sieve, { ...input, id: 'pending' });
        const saved = accounts.add(input);
        console.log(`Saved account "${saved.name}" to ${accounts.home}`);
        break;
      }

      case 'test':
        await testAccount(sieve, requireTarget());
        break;

      case 'update': {
        const account = requireTarget();
        const patch: Partial<AccountInput> = {
          name: values.name,
          host: values.host,
          port: parsePort(values.port),
          tls: values.tls === undefined ? undefined : parseTls(values.tls),
          user: values.user,
          allowInvalidCertificate: values['allow-invalid-cert'],
        };
        if (values.password) patch.password = await prompt.askHidden('New password');
        const updated = accounts.update(account.id, patch);
        console.log(`Updated "${updated.name}".`);
        if (!values['skip-test']) await testAccount(sieve, accounts.resolve(updated.id));
        break;
      }

      case 'remove': {
        const account = requireTarget();
        const answer = await prompt.ask(`Remove "${account.name}" (${account.user}@${account.host}) from this machine? [y/N]`);
        if (answer.toLowerCase() !== 'y') {
          console.log('Cancelled.');
          break;
        }
        accounts.remove(account.id);
        console.log(`Removed "${account.name}". Scripts on the server were not touched.`);
        break;
      }

      case 'import-imap': {
        let source = readImapMcpAccounts(values['imap-home']);
        if (values.account) {
          source = source.filter((a) => a.name.toLowerCase() === values.account!.toLowerCase());
          if (!source.length) throw new Error(`No imap-mcp-server account named "${values.account}".`);
        }
        if (values.name && source.length !== 1) throw new Error('--name needs --account to pick a single IMAP account.');
        const port = parsePort(values.port) ?? 4190;
        const tls = parseTls(values.tls);
        for (const imap of source) {
          const input: AccountInput = {
            name: values.name ?? imap.name,
            host: values.host ?? imap.host,
            port,
            tls,
            user: imap.user,
            password: imap.password,
            allowInvalidCertificate: values['allow-invalid-cert'] || undefined,
          };
          if (accounts.getByName(input.name)) {
            console.log(`Skipping "${input.name}": an account with that name already exists.`);
            continue;
          }
          try {
            if (input.password && !values['skip-test']) await testAccount(sieve, { ...input, id: 'pending' });
            accounts.add(input);
            console.log(`Imported "${input.name}" (${input.user}@${input.host}:${input.port}).`);
            if (!input.password) console.log(`  Password is env-managed: set ${envVarName(input.name, 'PASSWORD')}.`);
          } catch (err) {
            console.error(`Could not import "${input.name}": ${(err as Error).message}`);
            console.error('  The ManageSieve host may differ from the IMAP host — retry with --account and --host, or --skip-test.');
          }
        }
        break;
      }

      case 'config':
        printConfig();
        break;

      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    prompt.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
