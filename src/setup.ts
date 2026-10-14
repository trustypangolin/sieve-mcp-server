/**
 * sieve-mcp-setup — manage accounts in the shared store from a terminal, so
 * passwords are typed here rather than pasted into a chat.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AccountManager, envVarName } from './services/account-manager.js';
import { BackupStore } from './services/backup-store.js';
import { configHome } from './paths.js';
import { readImapMcpAccounts } from './services/imap-import.js';
import { DEFAULT_RULES_DIR, pullScripts, scriptNameFromFile } from './services/local-rules.js';
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

Working on rules locally:
  pull                     Download every script to local-rules/<account>/ (keeps local edits unless --force)
  check <file>             Have the server validate a local .sieve file
  push <file>              Validate, show the diff, confirm, then upload (backs up the server copy;
                           never activates — use the sieve_activate_script tool or activate <script>)
  activate <script>        Make a server script the active one

Options:
  --name <name>            add / import-imap: account name; push: script name (default: file name)
  --host <host>            ManageSieve host (import-imap: overrides the IMAP host)
  --port <port>            ManageSieve port (default 4190)
  --tls <mode>             starttls (default) | implicit | none
  --user <user>            Login name
  --password               update: prompt for a new password
  --allow-invalid-cert     Skip TLS certificate verification (self-signed certs)
  --account <name>         Account to use (optional with one account); import-imap: the IMAP account
  --dir <dir>              pull: target folder (default: local-rules/ in the project)
  --force                  pull: overwrite local files that differ from the server
  --yes                    push / activate: skip the confirmation prompt
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

/** Package root: this file runs from dist/ when built, src/ under tsx. */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function serverEntryPath(): string {
  return path.join(packageRoot(), 'dist', 'index.js');
}

function printCheck(check: { valid: boolean; errors?: string; warnings?: string }): void {
  if (!check.valid) console.error(`Server rejected the script:\n  ${check.errors}`);
  else console.log(`Valid${check.warnings ? `, with warnings:\n  ${check.warnings}` : '.'}`);
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
      dir: { type: 'string' },
      force: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
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

      case 'pull': {
        const account = accounts.resolve(undefined, values.account);
        const root = path.resolve(values.dir ?? path.join(packageRoot(), DEFAULT_RULES_DIR));
        const result = await pullScripts(sieve, account, root, { force: values.force });
        console.log(`Scripts for "${account.name}" in ${result.dir}:`);
        for (const f of result.written) console.log(`  saved      ${path.basename(f)}`);
        for (const f of result.unchanged) console.log(`  unchanged  ${path.basename(f)}`);
        for (const f of result.kept) console.log(`  KEPT       ${path.basename(f)} (local edits differ from server; --force to overwrite)`);
        console.log(`Active script: ${result.active ?? '(none)'}`);
        break;
      }

      case 'check': {
        if (!target) throw new Error('Usage: sieve-mcp-setup check <file.sieve>');
        const check = await sieve.checkScript(accounts.resolve(undefined, values.account), readFileSync(target, 'utf8'));
        printCheck(check);
        if (!check.valid) process.exitCode = 1;
        break;
      }

      case 'push': {
        if (!target) throw new Error('Usage: sieve-mcp-setup push <file.sieve> [--name <script>]');
        const account = accounts.resolve(undefined, values.account);
        const name = values.name ?? scriptNameFromFile(target);
        const content = readFileSync(target, 'utf8');
        const preview = await sieve.putScript(account, { name, content, overwrite: true, dryRun: true });
        printCheck(preview.check);
        if (!preview.check.valid) {
          process.exitCode = 1;
          break;
        }
        if (preview.unchanged) {
          console.log(`"${name}" on the server is already identical; nothing to do.`);
          break;
        }
        console.log(`\n${preview.diff}`);
        const what = preview.existed
          ? `Replace "${name}"${preview.active ? ' — it is ACTIVE, so this takes effect immediately' : ''}`
          : `Create new script "${name}" (it will not be active)`;
        if (!values.yes && (await prompt.ask(`${what}. Continue? [y/N]`)).toLowerCase() !== 'y') {
          console.log('Cancelled; nothing was uploaded.');
          break;
        }
        const result = await sieve.putScript(account, { name, content, overwrite: true });
        console.log(result.note);
        if (result.backupFile) console.log(`Previous version backed up to ${result.backupFile}`);
        break;
      }

      case 'activate': {
        if (!target) throw new Error('Usage: sieve-mcp-setup activate <script name>');
        const account = accounts.resolve(undefined, values.account);
        if (!values.yes && (await prompt.ask(`Make "${target}" the active filter for "${account.name}"? [y/N]`)).toLowerCase() !== 'y') {
          console.log('Cancelled.');
          break;
        }
        const result = await sieve.activate(account, target);
        console.log(`"${result.active}" is now active${result.previouslyActive ? ` (was "${result.previouslyActive}")` : ''}.`);
        break;
      }

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
