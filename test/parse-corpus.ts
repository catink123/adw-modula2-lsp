// Parses every .def/.mod under the given roots and reports diagnostics and timing.
// usage: node out/test/parse-corpus.js <root> [<root>...] [--show N] [--file substr]

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../src/server/parser';

const args = process.argv.slice(2);
const show = Number(args[args.indexOf('--show') + 1]) || 0;
const fileFilter = args.includes('--file') ? args[args.indexOf('--file') + 1] : undefined;
const roots = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.svn' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(def|mod)$/i.test(e.name)) out.push(p);
  }
}

const files: string[] = [];
for (const r of roots) walk(r, files);
let total = 0, withErr = 0, diagCount = 0, bytes = 0, refs = 0, syms = 0;
const byMsg = new Map<string, number>();
const samples: string[] = [];
const perKey = new Map<string, number>();
const t0 = Date.now();
let slowest = { f: '', ms: 0 };
for (const f of files) {
  if (fileFilter && !f.includes(fileFilter)) continue;
  const text = fs.readFileSync(f, 'latin1');
  bytes += text.length;
  const t1 = Date.now();
  const u = parse(text, 'file:///' + f, f, new Map());
  const ms = Date.now() - t1;
  if (ms > slowest.ms) slowest = { f, ms };
  total++;
  refs += u.refs.length;
  const count = (s: { children?: unknown[] }[]): number => s.reduce((n, x) => n + 1 + count((x.children ?? []) as never), 0);
  syms += count(u.symbols);
  const errs = u.diags.filter(d => d.severity === 1);
  if (errs.length) withErr++;
  diagCount += errs.length;
  for (const d of errs) {
    const key = d.message.replace(/'[^']*'/g, "'_'").replace(/END \w+/g, 'END _');
    byMsg.set(key, (byMsg.get(key) ?? 0) + 1);
    const seen = perKey.get(key) ?? 0;
    perKey.set(key, seen + 1);
    if (seen < show) {
      const line = text.slice(0, d.start).split('\n').length;
      samples.push(`${f}:${line}: ${d.message}\n    ${text.split('\n')[line - 1]?.trim()}`);
    }
  }
}
const dt = Date.now() - t0;
console.log(`files ${total}, ${(bytes / 1e6).toFixed(1)} MB, ${dt} ms, slowest ${slowest.ms} ms ${path.basename(slowest.f)}`);
console.log(`symbols ${syms}, refs ${refs}`);
console.log(`files with errors ${withErr}, errors ${diagCount}`);
for (const [m, n] of [...byMsg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}\t${m}`);
for (const s of samples) console.log(s);
