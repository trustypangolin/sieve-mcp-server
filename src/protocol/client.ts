/**
 * Minimal ManageSieve client (RFC 5804), written from the RFC.
 *
 * One client = one connection = one authenticated session. The service layer
 * opens a session per tool call and logs out afterwards; script management is
 * infrequent enough that pooling would only add stale-connection failure modes.
 */
import net from 'node:net';
import tls from 'node:tls';
import {
  encodeLiteral,
  encodeString,
  parseLine,
  statusOf,
  tokenText,
  type SieveResponse,
  type Token,
} from './parser.js';

export type TlsMode = 'starttls' | 'implicit' | 'none';

export interface ConnectOptions {
  host: string;
  port: number;
  tls: TlsMode;
  /** Verify the server certificate (default true). */
  rejectUnauthorized?: boolean;
  /** Idle timeout for connect and every response, in ms (default 30s). */
  timeoutMs?: number;
}

export interface Capabilities {
  implementation?: string;
  sasl: string[];
  sieveExtensions: string[];
  starttls: boolean;
  /** Present on RFC 5804 servers; gates CHECKSCRIPT, RENAMESCRIPT and NOOP. */
  version?: string;
  notify: string[];
  maxRedirects?: number;
  owner?: string;
  language?: string;
}

export interface ScriptInfo {
  name: string;
  active: boolean;
}

export interface CheckResult {
  valid: boolean;
  /** Server's error text when invalid. */
  errors?: string;
  /** Server's warning text (response code WARNINGS) when valid. */
  warnings?: string;
}

export class SieveError extends Error {
  constructor(
    message: string,
    readonly response?: SieveResponse,
  ) {
    super(message);
    this.name = 'SieveError';
  }

  /** The server's response code, e.g. `NONEXISTENT`, `ACTIVE`, `QUOTA/MAXSIZE`. */
  get code(): string | undefined {
    return this.response?.code;
  }
}

/** How long to wait for the RFC-mandated capability re-announcement after STARTTLS. */
const POST_TLS_CAPABILITY_WAIT_MS = 2000;

export function parseCapabilities(response: SieveResponse): Capabilities {
  const raw = new Map<string, string>();
  for (const line of response.data) {
    raw.set(tokenText(line[0]).toUpperCase(), tokenText(line[1]));
  }
  const words = (key: string) => (raw.get(key) ?? '').split(/\s+/).filter(Boolean);
  const maxRedirects = raw.get('MAXREDIRECTS');
  return {
    implementation: raw.get('IMPLEMENTATION'),
    sasl: words('SASL'),
    sieveExtensions: words('SIEVE'),
    starttls: raw.has('STARTTLS'),
    version: raw.get('VERSION'),
    notify: words('NOTIFY'),
    maxRedirects: maxRedirects ? Number(maxRedirects) : undefined,
    owner: raw.get('OWNER'),
    language: raw.get('LANGUAGE'),
  };
}

function serverName(host: string): string | undefined {
  // SNI must not be an IP literal.
  return net.isIP(host) ? undefined : host;
}

function describe(response: SieveResponse): string {
  const code = response.code ? ` (${[response.code, ...response.codeArgs].join(' ')})` : '';
  return `${response.message || response.status}${code}`;
}

export class ManageSieveClient {
  capabilities!: Capabilities;

  private socket!: net.Socket;
  private detach: (() => void) | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly opts: Required<ConnectOptions>;

  private constructor(opts: ConnectOptions) {
    this.opts = { rejectUnauthorized: true, timeoutMs: 30_000, ...opts };
  }

  static async connect(opts: ConnectOptions): Promise<ManageSieveClient> {
    const client = new ManageSieveClient(opts);
    try {
      await client.open();
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  get secure(): boolean {
    return this.socket instanceof tls.TLSSocket;
  }

  get supportsRfc5804(): boolean {
    return this.capabilities.version !== undefined;
  }

  async authenticate(user: string, password: string, authzid = ''): Promise<void> {
    const mechanisms = this.capabilities.sasl.map((m) => m.toUpperCase());
    if (!mechanisms.includes('PLAIN')) {
      throw new SieveError(
        `Server does not offer SASL PLAIN (offers: ${mechanisms.join(', ') || 'none'}).` +
          (this.secure ? '' : ' Many servers only offer it after TLS — check the account\'s tls setting.'),
      );
    }
    const initial = Buffer.from(`${authzid}\0${user}\0${password}`, 'utf8').toString('base64');
    const response = await this.exchange(`AUTHENTICATE "PLAIN" ${encodeString(initial)}`);
    if (response.status !== 'OK') {
      throw new SieveError(`Authentication failed for "${user}": ${describe(response)}`, response);
    }
  }

  async listScripts(): Promise<ScriptInfo[]> {
    const response = await this.command('LISTSCRIPTS');
    return response.data.map((line) => ({
      name: tokenText(line[0]),
      active: line[1]?.type === 'atom' && line[1].value.toUpperCase() === 'ACTIVE',
    }));
  }

  async getScript(name: string): Promise<string> {
    const response = await this.command(`GETSCRIPT ${encodeString(name)}`);
    return tokenText(response.data[0]?.[0]);
  }

  /** Upload a script. Returns the server's warning text, if any. */
  async putScript(name: string, content: string): Promise<string | undefined> {
    const response = await this.command(`PUTSCRIPT ${encodeString(name)} ${encodeLiteral(content)}`);
    return response.code === 'WARNINGS' ? response.message : undefined;
  }

  /** Validate without storing (RFC 5804 servers only — see `supportsRfc5804`). */
  async checkScript(content: string): Promise<CheckResult> {
    const response = await this.exchange(`CHECKSCRIPT ${encodeLiteral(content)}`);
    if (response.status === 'OK') {
      return { valid: true, warnings: response.code === 'WARNINGS' ? response.message : undefined };
    }
    return { valid: false, errors: response.message || describe(response) };
  }

  /** Activate a script; an empty name deactivates all scripts. */
  async setActive(name: string): Promise<void> {
    await this.command(`SETACTIVE ${encodeString(name)}`);
  }

  async deleteScript(name: string): Promise<void> {
    await this.command(`DELETESCRIPT ${encodeString(name)}`);
  }

  async renameScript(oldName: string, newName: string): Promise<void> {
    await this.command(`RENAMESCRIPT ${encodeString(oldName)} ${encodeString(newName)}`);
  }

  async haveSpace(name: string, size: number): Promise<boolean> {
    const response = await this.exchange(`HAVESPACE ${encodeString(name)} ${size}`);
    return response.status === 'OK';
  }

  /** Polite LOGOUT, then close. Never throws. */
  async logout(): Promise<void> {
    try {
      if (!this.failure) await this.exchange('LOGOUT');
    } catch {
      // the server may close before or instead of answering
    } finally {
      this.close();
    }
  }

  close(): void {
    this.detach?.();
    this.socket?.destroy();
  }

  // --- connection setup -------------------------------------------------

  private async open(): Promise<void> {
    const { host, port, rejectUnauthorized, timeoutMs } = this.opts;

    if (this.opts.tls === 'implicit') {
      const socket = tls.connect({ host, port, servername: serverName(host), rejectUnauthorized });
      await this.waitForEvent(socket, 'secureConnect', timeoutMs, `${host}:${port}`);
      this.attach(socket);
    } else {
      const socket = net.connect({ host, port });
      await this.waitForEvent(socket, 'connect', timeoutMs, `${host}:${port}`);
      this.attach(socket);
    }

    this.capabilities = parseCapabilities(await this.expectOk(await this.readResponse(), 'server greeting'));

    if (this.opts.tls === 'starttls') {
      if (!this.capabilities.starttls) {
        throw new SieveError(
          `${host}:${port} does not offer STARTTLS. Refusing to send credentials unencrypted; ` +
            'use tls "implicit" if the port speaks TLS directly, or "none" only on a trusted network.',
        );
      }
      await this.command('STARTTLS');
      await this.upgradeToTls();
      // RFC 5804 §2.2: the server re-announces capabilities after TLS. Some
      // older servers don't, so ask explicitly if nothing arrives.
      const announced = this.buffer.length > 0 || (await this.waitForData(POST_TLS_CAPABILITY_WAIT_MS));
      const response = announced ? await this.readResponse() : await this.exchange('CAPABILITY');
      this.capabilities = parseCapabilities(this.expectOk(response, 'post-TLS capabilities'));
    }
  }

  private async upgradeToTls(): Promise<void> {
    const { host, rejectUnauthorized, timeoutMs } = this.opts;
    const raw = this.socket;
    this.detach?.();
    const secure = tls.connect({ socket: raw, servername: serverName(host), rejectUnauthorized });
    await this.waitForEvent(secure, 'secureConnect', timeoutMs, `TLS handshake with ${host}`);
    this.attach(secure);
  }

  private waitForEvent(socket: net.Socket, event: string, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new SieveError(`Timed out connecting to ${what}`));
      }, timeoutMs);
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new SieveError(`Could not connect to ${what}: ${err.message}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, onEvent);
        socket.off('error', onError);
      };
      socket.once(event, onEvent);
      socket.once('error', onError);
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    const onData = (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.wake?.();
    };
    const onError = (err: Error) => {
      this.failure ??= new SieveError(`Connection error: ${err.message}`);
      this.wake?.();
    };
    const onClose = () => {
      this.failure ??= new SieveError('Connection closed by server');
      this.wake?.();
    };
    const onTimeout = () => {
      this.failure ??= new SieveError(`Server did not respond within ${this.opts.timeoutMs} ms`);
      socket.destroy();
      this.wake?.();
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.setTimeout(this.opts.timeoutMs, onTimeout);
    this.detach = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.setTimeout(0);
      socket.off('timeout', onTimeout);
      this.detach = null;
    };
  }

  // --- request/response -------------------------------------------------

  /** Resolve true when data arrives, false on `timeoutMs` (if given); reject on connection failure. */
  private waitForData(timeoutMs?: number): Promise<boolean> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.wake = null;
        resolve(false);
      }, timeoutMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        if (this.failure) reject(this.failure);
        else resolve(true);
      };
    });
  }

  private async readResponse(): Promise<SieveResponse> {
    const data: Token[][] = [];
    for (;;) {
      const parsed = parseLine(this.buffer);
      if (!parsed) {
        await this.waitForData();
        continue;
      }
      this.buffer = this.buffer.subarray(parsed.next);
      const status = statusOf(parsed.tokens);
      if (!status) {
        data.push(parsed.tokens);
        continue;
      }
      const response = { ...status, data };
      if (response.status === 'BYE') {
        this.failure ??= new SieveError(`Server closed the session: ${describe(response)}`, response);
        throw this.failure;
      }
      return response;
    }
  }

  /** Send one command and return its response, whatever the status. */
  private async exchange(line: string): Promise<SieveResponse> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`, 'utf8');
    return this.readResponse();
  }

  /** Send one command; a NO response becomes a SieveError. */
  private async command(line: string): Promise<SieveResponse> {
    const verb = line.split(' ', 1)[0];
    return this.expectOk(await this.exchange(line), verb);
  }

  private expectOk(response: SieveResponse, what: string): SieveResponse {
    if (response.status !== 'OK') {
      throw new SieveError(`${what} failed: ${describe(response)}`, response);
    }
    return response;
  }
}
