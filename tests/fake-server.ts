/**
 * In-process fake ManageSieve server for tests. Speaks enough of RFC 5804 to
 * exercise the client: greeting, STARTTLS / implicit TLS, AUTHENTICATE PLAIN,
 * script CRUD, and either RFC 5804 mode (VERSION, CHECKSCRIPT, RENAMESCRIPT)
 * or legacy mode.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { parseLine, tokenText } from '../src/protocol/parser.js';

export interface FakeOptions {
  rfc5804?: boolean;
  starttls?: boolean;
  user?: string;
  password?: string;
  scripts?: Record<string, string>;
  active?: string | null;
  /** Content matching this is rejected by the "compiler". */
  reject?: RegExp;
  /** Content matching this compiles with a warning. */
  warn?: RegExp;
  /** Speak TLS from the first byte. */
  implicitTls?: boolean;
  /** Only advertise SASL PLAIN once TLS is up, like Dovecot with disable_plaintext_auth. */
  saslOnlyAfterTls?: boolean;
  /** Skip the RFC 5804 capability re-announcement after STARTTLS (old servers). */
  silentAfterTls?: boolean;
}

export interface FakeServer {
  port: number;
  scripts: Map<string, string>;
  active: () => string | null;
  /** Command verbs received, in order, across all connections. */
  commands: string[];
  close: () => Promise<void>;
}

/** Self-signed localhost certificate (CN=localhost, SAN localhost + 127.0.0.1). */
export const TEST_CERT = {
  key: readFileSync(new URL('./fixtures/localhost.key', import.meta.url)),
  cert: readFileSync(new URL('./fixtures/localhost.crt', import.meta.url)),
};

const quote = (s: string) => `"${s.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
const literal = (s: string) => `{${Buffer.byteLength(s, 'utf8')}}\r\n${s}`;

export async function startFakeServer(opts: FakeOptions = {}): Promise<FakeServer> {
  const rfc5804 = opts.rfc5804 ?? true;
  const user = opts.user ?? 'alice@example.com';
  const password = opts.password ?? 's3cret!';
  const reject = opts.reject ?? /syntaxerror/;
  const warn = opts.warn ?? /warnme/;
  const scripts = new Map(Object.entries(opts.scripts ?? {}));
  let active: string | null = opts.active ?? null;
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();

  const capabilities = (secure: boolean) =>
    [
      '"IMPLEMENTATION" "Fake Sieve 1.0"',
      opts.saslOnlyAfterTls && !secure ? '"SASL" ""' : '"SASL" "PLAIN"',
      '"SIEVE" "fileinto vacation imap4flags"',
      ...(opts.starttls && !secure ? ['"STARTTLS"'] : []),
      ...(rfc5804 ? ['"VERSION" "1.0"'] : []),
      'OK "Ready"',
    ].join('\r\n') + '\r\n';

  const compile = (content: string): string => {
    if (reject.test(content)) return 'NO "line 2: error: unknown command \'syntaxerror\'"';
    if (warn.test(content)) return 'OK (WARNINGS) "line 3: warning: something odd"';
    return 'OK';
  };

  const onConnection = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let authed = false;
    let stream: net.Socket = socket;
    let secure = !!opts.implicitTls;
    socket.write(capabilities(secure));

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseLine(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.next);
        const [verbToken, ...args] = parsed.tokens;
        const verb = tokenText(verbToken).toUpperCase();
        const arg = (i: number) => tokenText(args[i]);
        commands.push(verb);
        const reply = (text: string) => stream.write(`${text}\r\n`);

        if (verb === 'LOGOUT') {
          reply('OK "Bye"');
          stream.end();
          return;
        }
        if (verb === 'CAPABILITY') {
          stream.write(capabilities(secure));
          continue;
        }
        if (verb === 'STARTTLS' && opts.starttls && !secure) {
          reply('OK "Begin TLS negotiation"');
          socket.off('data', onData);
          const upgraded = new tls.TLSSocket(socket, { isServer: true, ...TEST_CERT });
          upgraded.on('error', () => {});
          upgraded.on('secure', () => {
            if (!opts.silentAfterTls) upgraded.write(capabilities(true));
          });
          upgraded.on('data', onData);
          stream = upgraded;
          secure = true;
          return;
        }
        if (verb === 'AUTHENTICATE') {
          const [, u, p] = Buffer.from(arg(1), 'base64').toString('utf8').split('\0');
          authed = u === user && p === password;
          reply(authed ? 'OK "Logged in"' : 'NO "Authentication failed"');
          continue;
        }
        if (!authed) {
          reply('NO "Not authenticated"');
          continue;
        }

        switch (verb) {
          case 'LISTSCRIPTS':
            for (const name of scripts.keys()) reply(`${quote(name)}${name === active ? ' ACTIVE' : ''}`);
            reply('OK');
            break;
          case 'GETSCRIPT':
            if (!scripts.has(arg(0))) reply('NO (NONEXISTENT) "No such script"');
            else reply(`${literal(scripts.get(arg(0))!)}\r\nOK`);
            break;
          case 'PUTSCRIPT': {
            const result = compile(arg(1));
            if (result.startsWith('OK')) scripts.set(arg(0), arg(1));
            reply(result);
            break;
          }
          case 'CHECKSCRIPT':
            reply(rfc5804 ? compile(arg(0)) : 'NO "Unknown command"');
            break;
          case 'SETACTIVE':
            if (arg(0) === '') {
              active = null;
              reply('OK');
            } else if (!scripts.has(arg(0))) {
              reply('NO (NONEXISTENT) "No such script"');
            } else {
              active = arg(0);
              reply('OK');
            }
            break;
          case 'DELETESCRIPT':
            if (!scripts.has(arg(0))) reply('NO (NONEXISTENT) "No such script"');
            else if (arg(0) === active) reply('NO (ACTIVE) "Script is active"');
            else {
              scripts.delete(arg(0));
              reply('OK');
            }
            break;
          case 'RENAMESCRIPT':
            if (!rfc5804) reply('NO "Unknown command"');
            else if (!scripts.has(arg(0))) reply('NO (NONEXISTENT) "No such script"');
            else if (scripts.has(arg(1))) reply('NO (ALREADYEXISTS) "Exists"');
            else {
              scripts.set(arg(1), scripts.get(arg(0))!);
              scripts.delete(arg(0));
              if (active === arg(0)) active = arg(1);
              reply('OK');
            }
            break;
          case 'HAVESPACE':
            reply('OK');
            break;
          default:
            reply('NO "Unknown command"');
        }
      }
    };
    socket.on('data', onData);
  };

  const server = opts.implicitTls ? tls.createServer(TEST_CERT, onConnection) : net.createServer(onConnection);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    scripts,
    active: () => active,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
