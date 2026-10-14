/**
 * Wire-level parsing for ManageSieve (RFC 5804 §4).
 *
 * A response line is a sequence of atoms, strings (quoted or literal) and
 * parenthesised lists, terminated by CRLF. Literals (`{n}` / `{n+}` followed by
 * CRLF and n octets) may contain CRLF themselves, so a "line" can span many
 * physical lines — the parser works on raw bytes and returns `null` until the
 * whole logical line has arrived.
 *
 * The same parser reads client commands, which the test fake server relies on.
 */

export type Token =
  | { type: 'atom'; value: string }
  | { type: 'string'; value: string }
  | { type: 'list'; items: Token[] };

export interface ParsedLine {
  tokens: Token[];
  /** Offset just past the terminating CRLF. */
  next: number;
}

export interface StatusLine {
  status: 'OK' | 'NO' | 'BYE';
  /** Response code, uppercased, e.g. `WARNINGS`, `QUOTA/MAXSIZE`, `NONEXISTENT`. */
  code?: string;
  codeArgs: string[];
  message: string;
}

export interface SieveResponse extends StatusLine {
  /** Data lines preceding the status line. */
  data: Token[][];
}

export class ProtocolError extends Error {}

const SP = 0x20;
const CR = 0x0d;
const LF = 0x0a;
const DQUOTE = 0x22;
const BSLASH = 0x5c;
const LPAREN = 0x28;
const RPAREN = 0x29;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const PLUS = 0x2b;

const INCOMPLETE = Symbol('incomplete');

/** Longest literal length spec we accept, e.g. `{4294967295+}`. */
const MAX_LITERAL_SPEC = 16;

export function parseLine(buf: Buffer, start = 0): ParsedLine | null {
  let pos = start;

  const need = (n: number) => {
    if (pos + n > buf.length) throw INCOMPLETE;
  };

  const parseQuoted = (): string => {
    pos++; // opening quote
    const bytes: number[] = [];
    for (;;) {
      need(1);
      const c = buf[pos++];
      if (c === DQUOTE) return Buffer.from(bytes).toString('utf8');
      if (c === CR || c === LF) throw new ProtocolError('Unterminated quoted string');
      if (c === BSLASH) {
        need(1);
        bytes.push(buf[pos++]);
        continue;
      }
      bytes.push(c);
    }
  };

  const parseLiteral = (): string => {
    let i = pos + 1;
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x39) {
      i++;
      if (i - pos > MAX_LITERAL_SPEC) throw new ProtocolError('Literal length too long');
    }
    if (i >= buf.length) throw INCOMPLETE;
    const digits = buf.toString('latin1', pos + 1, i);
    if (!digits) throw new ProtocolError('Malformed literal length');
    if (buf[i] === PLUS) {
      // non-synchronizing literal marker
      i++;
      if (i >= buf.length) throw INCOMPLETE;
    }
    if (buf[i] !== RBRACE) throw new ProtocolError('Malformed literal length');
    const len = Number(digits);
    pos = i + 1;
    need(2);
    if (buf[pos] !== CR || buf[pos + 1] !== LF) {
      throw new ProtocolError('Literal length must be followed by CRLF');
    }
    pos += 2;
    need(len);
    const value = buf.toString('utf8', pos, pos + len);
    pos += len;
    return value;
  };

  const parseAtom = (): string => {
    const begin = pos;
    while (pos < buf.length) {
      const c = buf[pos];
      if (c === SP || c === CR || c === LF || c === LPAREN || c === RPAREN || c === DQUOTE || c === LBRACE) {
        break;
      }
      pos++;
    }
    // The atom might continue in the next chunk.
    if (pos >= buf.length) throw INCOMPLETE;
    return buf.toString('utf8', begin, pos);
  };

  const parseSequence = (inList: boolean): Token[] => {
    const out: Token[] = [];
    for (;;) {
      need(1);
      const c = buf[pos];
      if (c === SP) {
        pos++;
      } else if (c === CR) {
        if (inList) throw new ProtocolError('Unterminated parenthesised list');
        need(2);
        if (buf[pos + 1] !== LF) throw new ProtocolError('Bare CR in response');
        pos += 2;
        return out;
      } else if (c === LF) {
        // Lenient: tolerate bare LF line endings from sloppy servers.
        if (inList) throw new ProtocolError('Unterminated parenthesised list');
        pos++;
        return out;
      } else if (c === RPAREN) {
        if (!inList) throw new ProtocolError('Unexpected ")"');
        pos++;
        return out;
      } else if (c === LPAREN) {
        pos++;
        out.push({ type: 'list', items: parseSequence(true) });
      } else if (c === DQUOTE) {
        out.push({ type: 'string', value: parseQuoted() });
      } else if (c === LBRACE) {
        out.push({ type: 'string', value: parseLiteral() });
      } else {
        out.push({ type: 'atom', value: parseAtom() });
      }
    }
  };

  try {
    const tokens = parseSequence(false);
    return { tokens, next: pos };
  } catch (err) {
    if (err === INCOMPLETE) return null;
    throw err;
  }
}

export function tokenText(token: Token | undefined): string {
  if (!token) return '';
  if (token.type === 'list') return token.items.map(tokenText).join(' ');
  return token.value;
}

/** Interpret a parsed line as an OK/NO/BYE status line, or `null` for a data line. */
export function statusOf(tokens: Token[]): StatusLine | null {
  const first = tokens[0];
  if (first?.type !== 'atom') return null;
  const status = first.value.toUpperCase();
  if (status !== 'OK' && status !== 'NO' && status !== 'BYE') return null;

  let i = 1;
  let code: string | undefined;
  let codeArgs: string[] = [];
  const maybeCode = tokens[i];
  if (maybeCode?.type === 'list') {
    code = tokenText(maybeCode.items[0]).toUpperCase() || undefined;
    codeArgs = maybeCode.items.slice(1).map(tokenText);
    i++;
  }
  return { status, code, codeArgs, message: tokenText(tokens[i]) };
}

/** Encode a string argument: quoted when short and single-line, otherwise a non-synchronizing literal. */
export function encodeString(value: string): string {
  if (value.length <= 1024 && !/[\r\n\0]/.test(value) && Buffer.byteLength(value, 'utf8') <= 1024) {
    return `"${value.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
  }
  return encodeLiteral(value);
}

/** Encode a client literal (`{n+}` — RFC 5804 requires servers to accept non-synchronizing literals). */
export function encodeLiteral(value: string): string {
  return `{${Buffer.byteLength(value, 'utf8')}+}\r\n${value}`;
}
