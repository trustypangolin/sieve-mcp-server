import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this module to our own package.json (works from src/ under tsx and dist/ after bundling). */
function findPackageVersion(startDir: string): string {
  for (let dir = startDir; ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'sieve-mcp-server') return pkg.version;
    } catch {
      // keep walking
    }
    if (dirname(dir) === dir) return '0.0.0';
  }
}

export const PACKAGE_VERSION = findPackageVersion(dirname(fileURLToPath(import.meta.url)));
