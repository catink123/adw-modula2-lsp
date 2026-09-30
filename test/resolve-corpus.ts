// Resolves every identifier occurrence in the workspace and reports unresolved names.
// usage: node out/test/resolve-corpus.js <root> [--show N] [--file substr]
import { Resolver } from '../src/server/resolver';
import { Workspace } from '../src/server/workspace';

const args = process.argv.slice(2);
const show = Number(args[args.indexOf('--show') + 1]) || 0;
const fileFilter = args.includes('--file') ? args[args.indexOf('--file') + 1] : undefined;
const root = args[0];
const ws = new Workspace();
ws.configure([root], { cacheSize: 5000 });
const rs = new Resolver(ws);
let total = 0, unresolved = 0, files = 0;
const byName = new Map<string, { n: number; where: string }>();
const t0 = Date.now();
for (const f of ws.workspaceFiles()) {
  if (fileFilter && !f.includes(fileFilter)) continue;
  const u = ws.unit(f);
  if (!u) continue;
  files++;
  for (const r of u.refs) {
    total++;
    if (!rs.resolveRef(r)) {
      unresolved++;
      const key = r.base ? `${r.base.ref.name}.${r.name}` : r.name;
      const e = byName.get(key);
      if (e) e.n++;
      else {
        const line = u.text.slice(0, r.start).split('\n').length;
        byName.set(key, { n: 1, where: `${f}:${line}: ${u.text.split('\n')[line - 1].trim().slice(0, 120)}` });
      }
    }
  }
}
console.log(`files ${files}, refs ${total}, unresolved ${unresolved} (${(100 * unresolved / total).toFixed(2)}%), ${Date.now() - t0} ms, heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
for (const [k, v] of [...byName].sort((a, b) => b[1].n - a[1].n).slice(0, show)) console.log(`${String(v.n).padStart(6)} ${k.padEnd(40)} ${v.where}`);
