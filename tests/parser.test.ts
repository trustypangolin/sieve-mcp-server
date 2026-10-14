import { describe, expect, it } from 'vitest';
import { encodeLiteral, encodeString, parseLine, statusOf, ProtocolError } from '../src/protocol/parser.js';

const b = (s: string) => Buffer.from(s, 'utf8');

describe('parseLine', () => {
  it('parses atoms, quoted strings and the terminating CRLF', () => {
    const parsed = parseLine(b('"IMPLEMENTATION" "Dovecot Pigeonhole"\r\nOK\r\n'));
    expect(parsed?.tokens).toEqual([
      { type: 'string', value: 'IMPLEMENTATION' },
      { type: 'string', value: 'Dovecot Pigeonhole' },
    ]);
    expect(parsed?.next).toBe(39);
  });

  it('unescapes quoted strings', () => {
    expect(parseLine(b('"a \\"b\\" \\\\ c"\r\n'))?.tokens).toEqual([{ type: 'string', value: 'a "b" \\ c' }]);
  });

  it('reads literals containing CRLF, with and without "+"', () => {
    const body = 'require "fileinto";\r\nkeep;\r\n';
    for (const spec of [`{${body.length}}`, `{${body.length}+}`]) {
      const parsed = parseLine(b(`${spec}\r\n${body}\r\n`));
      expect(parsed?.tokens).toEqual([{ type: 'string', value: body }]);
    }
  });

  it('counts literal length in bytes, not characters', () => {
    const body = 'Grüße ✉';
    const parsed = parseLine(b(`{${Buffer.byteLength(body)}}\r\n${body}\r\n`));
    expect(parsed?.tokens[0]).toEqual({ type: 'string', value: body });
  });

  it('returns null until the whole logical line has arrived', () => {
    const full = b('{10}\r\n0123456789\r\nOK\r\n');
    for (let cut = 1; cut < 18; cut++) {
      expect(parseLine(full.subarray(0, cut))).toBeNull();
    }
    expect(parseLine(full)?.tokens).toEqual([{ type: 'string', value: '0123456789' }]);
  });

  it('treats a partial atom at the end of the buffer as incomplete', () => {
    expect(parseLine(b('O'))).toBeNull();
    expect(parseLine(b('OK'))).toBeNull();
    expect(parseLine(b('OK\r'))).toBeNull();
  });

  it('parses response codes as lists', () => {
    const parsed = parseLine(b('NO (QUOTA/MAXSIZE) "Script too big"\r\n'))!;
    expect(statusOf(parsed.tokens)).toEqual({ status: 'NO', code: 'QUOTA/MAXSIZE', codeArgs: [], message: 'Script too big' });
  });

  it('parses a status with a literal message and code arguments', () => {
    const parsed = parseLine(b('OK (TAG "x1") {5}\r\nhello\r\n'))!;
    expect(statusOf(parsed.tokens)).toEqual({ status: 'OK', code: 'TAG', codeArgs: ['x1'], message: 'hello' });
  });

  it('does not treat data lines as status lines', () => {
    expect(statusOf(parseLine(b('"OK" ACTIVE\r\n'))!.tokens)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(() => parseLine(b('{abc}\r\n'))).toThrow(ProtocolError);
    expect(() => parseLine(b('"unterminated\r\n'))).toThrow(ProtocolError);
    expect(() => parseLine(b('OK)\r\n'))).toThrow(ProtocolError);
  });
});

describe('encoding', () => {
  it('quotes short single-line strings with escapes', () => {
    expect(encodeString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('falls back to a non-synchronizing literal for multi-line or long strings', () => {
    expect(encodeString('a\r\nb')).toBe('{4+}\r\na\r\nb');
    expect(encodeString('x'.repeat(2000)).startsWith('{2000+}\r\n')).toBe(true);
  });

  it('round-trips through the parser', () => {
    const content = 'require ["fileinto"];\r\nif header :contains "subject" "ü" { fileinto "X"; }\r\n';
    expect(parseLine(b(`${encodeLiteral(content)}\r\n`))?.tokens[0]).toEqual({ type: 'string', value: content });
  });
});
