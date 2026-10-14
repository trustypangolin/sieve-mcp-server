import os from 'node:os';
import path from 'node:path';

/**
 * Root of the shared config store. Claude Desktop and Claude Code launch the
 * server as the same OS user, so both resolve the same directory and see the
 * same accounts. `SIEVE_MCP_HOME` relocates it (tests, portable setups).
 */
export function configHome(): string {
  return process.env.SIEVE_MCP_HOME || path.join(os.homedir(), '.sieve-mcp');
}
