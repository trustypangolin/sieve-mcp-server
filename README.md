# sieve-mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets Claude (Desktop, Code, or any MCP client) read, write, validate, and activate **Sieve** mail filter scripts on your mail server over **ManageSieve** ([RFC 5804](https://www.rfc-editor.org/rfc/rfc5804)).

It is built to go alongside an IMAP MCP server such as [imap-mcp-server](https://github.com/nikolausm/imap-mcp-server), which can read and move mail but cannot manage server-side filter rules.

- Every upload is **validated by your server** first (`CHECKSCRIPT`), and nothing is written if validation fails.
- Replacing a script needs `overwrite: true`, and `dryRun` shows a diff first.
- The previous version is **backed up locally** before any overwrite or delete.
- Uploading a script **never activates it**; activation is a separate, explicit call.
- The active script cannot be deleted.
- Passwords are stored **AES-256-GCM encrypted** in one place shared by all your MCP clients.

## Requirements

- Node.js ≥ 22.12
- A mail server with ManageSieve enabled, usually on port 4190. Dovecot/Pigeonhole, Cyrus, Stalwart, mailbox.org, Posteo and most cPanel/Plesk hosts support it. Gmail and Outlook.com do **not** support Sieve.

## Install

```bash
git clone https://github.com/trustypangolin/sieve-mcp-server.git
cd sieve-mcp-server
npm install
npm run build
```

## Set up an account

Run the setup CLI in a terminal. That way your password is typed there and never passes through a chat:

```bash
node dist/setup.js add
```

If you already use **imap-mcp-server**, you can import its accounts without retyping passwords. The importer only reads `~/.imap-mcp`; it never changes anything there.

```bash
node dist/setup.js import-imap
# ManageSieve host differs from the IMAP host:
node dist/setup.js import-imap --account personal --host sieve.example.com
```

Other commands: `list`, `test <name>`, `update <name> [--host … --port … --tls … --password]`, `remove <name>`. Run `node dist/setup.js --help` for all options.

Each account is tested (connect, TLS, login) before it is saved. Pass `--skip-test` to save it anyway.

## Connect Claude

`node dist/setup.js config` prints both snippets below with the correct absolute path filled in.

**Claude Desktop**: add to `claude_desktop_config.json`. On Windows that is `%APPDATA%\Claude\`; on macOS it is `~/Library/Application Support/Claude/`.

```json
{
  "mcpServers": {
    "sieve": {
      "command": "node",
      "args": ["C:\\path\\to\\sieve-mcp-server\\dist\\index.js"]
    }
  }
}
```

**Claude Code** (available in all projects):

```bash
claude mcp add --scope user sieve -- node /path/to/sieve-mcp-server/dist/index.js
```

## One shared config for every client

Accounts live in `~/.sieve-mcp/` (`%USERPROFILE%\.sieve-mcp\` on Windows):

| File | Contents |
|---|---|
| `accounts.json` | Accounts, with passwords AES-256-GCM encrypted |
| `.key` | Random 256-bit encryption key (owner-only permissions on macOS/Linux) |
| `backups/<account id>/` | Script versions saved before each overwrite or delete |

Claude Desktop and Claude Code both run the server as your user, so they read the same store. The store is re-read on every call, which means an account added with the CLI shows up without restarting either client. Set `SIEVE_MCP_HOME` to move the store somewhere else.

### Credentials from environment variables

To keep a password out of the store, save the account with an empty password, then set environment variables in the MCP client's `env` block:

```
SIEVE_MCP_ACCOUNT_<NAME>_USERNAME
SIEVE_MCP_ACCOUNT_<NAME>_PASSWORD
```

`<NAME>` is the account name in uppercase, with every non-alphanumeric character replaced by `_`. For example, the account `Personal Mail` becomes `SIEVE_MCP_ACCOUNT_PERSONAL_MAIL_PASSWORD`. The values are read once at startup and then removed from the process environment.

## Tools

| Tool | What it does |
|---|---|
| `sieve_list_accounts` | Lists the configured accounts. Passwords are never shown. |
| `sieve_add_account` / `sieve_update_account` / `sieve_remove_account` | Manage accounts from the chat. The CLI is preferred for passwords. |
| `sieve_get_capabilities` | Shows the server's supported Sieve extensions. Also works as a connection test. |
| `sieve_list_scripts` | Lists the scripts on the server and which one is active. |
| `sieve_get_script` | Returns a script's source. |
| `sieve_check_script` | Has the server validate a script without saving it. |
| `sieve_put_script` | Creates or replaces a script, with validation, `overwrite`, `dryRun` and diff, and an automatic backup. |
| `sieve_activate_script` / `sieve_deactivate_scripts` | Sets which script filters incoming mail, or switches filtering off. |
| `sieve_delete_script` | Deletes an inactive script, after backing it up. |
| `sieve_rename_script` | Renames a script. If it was active, it stays active. |
| `sieve_list_backups` / `sieve_get_backup` | Lists local backups and reads one back, so a change can be undone. |

Every tool accepts `accountName` (or `accountId`). You can leave both out when only one account is configured.

A typical change goes like this. You ask, for example, *"file anything from the council into Council"*. Claude reads the active script, edits it, and runs a dry run so you can review the diff. It writes the change only after you approve it.

## Security

- **TLS is required by default.** With the default `tls: "starttls"`, the server refuses to log in if the mail server doesn't offer STARTTLS. Use `implicit` for a port that speaks TLS from the first byte. Use `none` only on localhost or a trusted network.
- Certificates are verified. Set `allowInvalidCertificate` only for a self-signed certificate you trust. The client sets verification explicitly, so a global `NODE_TLS_REJECT_UNAUTHORIZED=0` does not weaken it.
- Logins use SASL PLAIN, and only ever after TLS unless you chose `tls: "none"`.
- Nothing is logged except startup info, which goes to stderr. There is no telemetry, and the server makes no network connections other than to your own mail server.

## Development

```bash
npm run dev      # run the server from source
npm run setup -- list
npm test         # vitest, including a fake ManageSieve server with STARTTLS
npm run lint     # tsc --noEmit
```

The ManageSieve client in `src/protocol/` is written from RFC 5804. It contains no code from other ManageSieve implementations. In particular, the AGPL-licensed [Sieve Editor](https://github.com/thsmi/sieve) is not a source.

## License

MIT
