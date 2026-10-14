/**
 * Read-only access to imap-mcp-server's store (`~/.imap-mcp/`) so the setup CLI
 * can create Sieve accounts from existing IMAP accounts without retyping
 * passwords. That store is AES-256-CBC, `<iv hex>:<ciphertext hex>`, keyed by
 * the hex key in `.key`. Nothing is ever written there.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ImapAccountSummary {
  name: string;
  host: string;
  user: string;
  /** Empty when the IMAP account is env-managed. */
  password: string;
}

export function defaultImapMcpHome(): string {
  return path.join(os.homedir(), '.imap-mcp');
}

export function decryptImapMcpField(value: string | undefined, hexKey: string): string {
  if (!value) return '';
  const [ivHex, data] = value.split(':');
  if (!ivHex || data === undefined) throw new Error('Unrecognised imap-mcp credential format');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(hexKey, 'hex'), Buffer.from(ivHex, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

export function readImapMcpAccounts(home: string = defaultImapMcpHome()): ImapAccountSummary[] {
  let raw: string;
  let key: string;
  try {
    raw = readFileSync(path.join(home, 'accounts.json'), 'utf8');
    key = readFileSync(path.join(home, '.key'), 'utf8').trim();
  } catch (err) {
    throw new Error(`No imap-mcp-server accounts found in ${home} (${(err as Error).message})`);
  }
  const accounts = JSON.parse(raw) as Array<{ name: string; host: string; user: string; password?: string }>;
  return accounts.map((a) => ({
    name: a.name,
    host: a.host,
    user: a.user,
    password: decryptImapMcpField(a.password, key),
  }));
}
