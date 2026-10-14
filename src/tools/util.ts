import { z } from 'zod';
import { SieveError } from '../protocol/client.js';

export const accountSelector = {
  accountName: z
    .string()
    .optional()
    .describe('Account name (from sieve_list_accounts). Optional when only one account is configured.'),
  accountId: z.string().optional().describe('Account id, as an alternative to accountName.'),
};

export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Run a tool body, turning failures into a structured JSON error result instead of a thrown exception. */
export async function run(body: () => Promise<unknown> | unknown) {
  try {
    return jsonResult(await body());
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = err instanceof SieveError ? err.code : undefined;
    return { ...jsonResult(code ? { error, code } : { error }), isError: true };
  }
}
