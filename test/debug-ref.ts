// Explains the resolution of one identifier: node out/test/debug-ref.js <root> <file> <line> <col>
import { Resolver } from '../src/server/resolver';
import { Workspace } from '../src/server/workspace';
const [root, file, line, col] = process.argv.slice(2);
const ws = new Workspace();
ws.configure([root], {});
const rs = new Resolver(ws);
const u = ws.unit(file)!;
const lines = u.text.split('\n');
let off = 0;
for (let i = 0; i < Number(line) - 1; i++) off += lines[i].length + 1;
off += Number(col) - 1;
const r = rs.refAt(u, off);
if (!r) { console.log('no ref at', off, JSON.stringify(u.text.slice(off - 10, off + 10))); process.exit(); }
const chain = [];
for (let x: typeof r | undefined = r; x; x = x.base?.ref) chain.unshift(`${x.name}${x.base ? '' : ''}`);
console.log('ref', chain.join('.'), 'scope', r.scope.kind, r.scope.owner?.name, 'ops', r.base?.ops);
for (let s: typeof r.scope | undefined = r.scope; s; s = s.parent) console.log('  scope', s.kind, s.owner?.name, [...s.syms.keys()].slice(0, 12).join(','), 'withs', s.withs.length);
const sym = rs.resolveRef(r);
console.log('=>', sym ? `${sym.kind} ${sym.name} @ ${sym.unit.path}:${sym.unit.text.slice(0, sym.nameStart).split('\n').length} ${sym.detail}` : 'UNRESOLVED');
if (r.base) {
  const b = rs.resolveRef(r.base.ref);
  console.log('base =>', b ? `${b.kind} ${b.name} ${b.detail} @ ${b.unit.path}` : 'UNRESOLVED');
  if (b) console.log('base value type', JSON.stringify(rs.valueType(b, r.base.ops), (k, v) => (k === 'scope' || k === 'unit' || k === 'fields' || k === 'list' || k === 'members' || k === 'sym' || k === 'low') ? undefined : v));
}
