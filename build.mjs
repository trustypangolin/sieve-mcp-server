import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies || {})];

for (const entry of ['index', 'setup']) {
  await esbuild.build({
    entryPoints: [`src/${entry}.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: `dist/${entry}.js`,
    external,
    banner: { js: '#!/usr/bin/env node' },
  });
}

console.log('Build complete');
