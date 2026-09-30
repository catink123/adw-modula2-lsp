// Bundles the extension client and language server with esbuild.
//   node build.mjs              development build into dist/
//   node build.mjs --production minified build
//   node build.mjs --watch      rebuild on change
//   node build.mjs --tests      also build test/*.ts into out/test/
import * as esbuild from 'esbuild';
import { readdirSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
};

const configs = [
  { ...common, entryPoints: ['src/client/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server.js' },
];
if (tests) {
  for (const f of readdirSync('test').filter(f => f.endsWith('.ts'))) {
    configs.push({ ...common, external: ['vscode'], sourcemap: true, minify: false, entryPoints: [`test/${f}`], outfile: `out/test/${f.replace(/\.ts$/, '.js')}` });
  }
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
  console.log('watching...');
} else {
  await Promise.all(configs.map(c => esbuild.build(c)));
  console.log(`built ${configs.length} bundle(s)${production ? ' (production)' : ''}`);
}
