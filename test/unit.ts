// Feature tests against a small synthetic workspace, plus an optional smoke test against a real ADW project:
//   M2_SMOKE_ROOT=<folder containing main/MOD/DrawDoc.mod> npm test
// run: npm test

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Features, offAt, posAt, SymbolIndex } from '../src/server/features';
import { Unit } from '../src/server/model';
import { Resolver } from '../src/server/resolver';
import { Workspace } from '../src/server/workspace';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2test-'));
const files: Record<string, string> = {
  'Geo.def': `DEFINITION MODULE Geo;
TYPE
  Point = RECORD x, y : LONGREAL; END;
END Geo.
`,
  'Shapes.def': `UNSAFEGUARDED DEFINITION MODULE Shapes;
IMPORT Geo;
TYPE
  tKind = (Circle, Square);
  tShape = RECORD
    kind : tKind;
    center : Geo.Point;   (* centre of the shape *)
  END;
  tShapePtr = POINTER TO tShape;
  tShapes = ARRAY [0..9] OF tShape;

CLASS cDrawable;
REVEAL Draw, Area;
VAR
  Area : LONGREAL;
PROCEDURE Draw(x : INTEGER);
(* Draws it *)
END cDrawable;

CLASS cCircle;
INHERIT cDrawable;
REVEAL Radius;
VAR Radius : LONGREAL;
END cCircle;

PROCEDURE Make(k : tKind; VAR s : tShape) : BOOLEAN;
(* Makes a shape. *)

END Shapes.
`,
  'Shapes.mod': `UNSAFEGUARDED IMPLEMENTATION MODULE Shapes;

<*IF VIEWER THEN*>
VAR ViewerOnly : INTEGER;
<*ELSE*>
VAR EditorOnly : INTEGER;
<*END*>

CLASS cDrawable;

PROCEDURE Draw(x : INTEGER);
BEGIN
  Area := Area + FLOAT(x);
END Draw;

END cDrawable;

CLASS cCircle;
BEGIN
  Radius := 1.0;
END cCircle;

PROCEDURE Make(k : tKind; VAR s : tShape) : BOOLEAN;
VAR all : tShapes;
BEGIN
  s.kind := k;
  s.center.x := 0.0;
  WITH all[1] DO
    center.y := 2.0;
  END;
  EditorOnly := 1;
  RETURN TRUE;
END Make;

END Shapes.
`,
  'Client.mod': `MODULE Client;
FROM Shapes IMPORT Make, tShape, tShapePtr, tKind, cCircle;
IMPORT Shapes, Geo;
VAR
  sh : tShape;
  p : tShapePtr;
  c : cCircle;
  ok : BOOLEAN;

PROCEDURE Run;
BEGIN
  ok := Make(Circle, sh);
  p^.center.x := 1.0;
  c.Draw(3);
  c.Radius := c.Area;
  IF Shapes.Make(Shapes.Square, sh) THEN END;
END Run;

BEGIN
  Run;
END Client.
`,
  'Bad.mod': `MODULE Bad;
FROM Shapes IMPORT Nope;
IMPORT Missing;
BEGIN
  Undefined := 1;
END Bad.
`,
};
for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);

const ws = new Workspace();
ws.configure([dir], { adwPath: '' });
const rs = new Resolver(ws);
const ft = new Features(ws, rs);
const U = (n: string) => ws.unit(path.join(dir, n))!;
/** offset of the `nth` occurrence of `marker` in a file, plus `delta` */
const at = (n: string, marker: string, delta = 0, nth = 1): number => {
  const t = files[n];
  let i = -1;
  for (let k = 0; k < nth; k++) i = t.indexOf(marker, i + 1);
  assert.ok(i >= 0, `marker ${marker} in ${n}`);
  return i + delta;
};
const line = (u: Unit, off: number) => u.text.slice(0, off).split('\n').length;
const defLine = (n: string, marker: string, delta = 0, nth = 1) => {
  const u = U(n);
  const locs = ft.definition(u, at(n, marker, delta, nth));
  assert.equal(locs.length, 1, `definition for ${marker}`);
  return `${path.basename(ws.unitForUri(locs[0].uri)!.path)}:${locs[0].range.start.line + 1}`;
};

let passed = 0;
const test = async (name: string, f: () => void | Promise<void>) => {
  try { await f(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${(e as Error).message}`); process.exitCode = 1; }
};

(async () => {
  console.log('synthetic workspace');
  await test('parse without errors', () => {
    for (const n of ['Geo.def', 'Shapes.def', 'Shapes.mod', 'Client.mod']) assert.deepEqual(U(n).diags, [], n);
  });
  await test('definition: record field through pointer', () => assert.equal(defLine('Client.mod', 'center'), 'Shapes.def:7'));
  await test('definition: field of imported record type', () => assert.equal(defLine('Client.mod', 'x :='), 'Geo.def:3'));
  await test('definition: enum constant imported with its type', () => assert.equal(defLine('Client.mod', 'Circle,'), 'Shapes.def:4'));
  await test('definition: qualified enum constant', () => assert.equal(defLine('Client.mod', 'Square'), 'Shapes.def:4'));
  await test('definition: inherited class member', () => assert.equal(defLine('Client.mod', 'Draw'), 'Shapes.def:16'));
  await test('definition: class field inside method body', () => assert.equal(defLine('Shapes.mod', 'Area :='), 'Shapes.def:15'));
  await test('definition: WITH array element field', () => assert.equal(defLine('Shapes.mod', 'center.y'), 'Shapes.def:7'));
  await test('definition: MOD declaration jumps to DEF heading', () => assert.equal(defLine('Shapes.mod', 'Make('), 'Shapes.def:26'));
  await test('implementation: DEF heading to MOD body', () => {
    const locs = ft.implementation(U('Shapes.def'), at('Shapes.def', 'Make('));
    assert.equal(locs.length, 1);
    assert.ok(locs[0].uri.endsWith('Shapes.mod'));
  });
  await test('type definition of a variable', () => {
    const locs = ft.typeDefinition(U('Client.mod'), at('Client.mod', 'sh :'));
    assert.equal(line(ws.unitForUri(locs[0].uri)!, offAt(ws.unitForUri(locs[0].uri)!, locs[0].range.start)), 5);
  });
  await test('conditional compilation: inactive branch removed', () => {
    const u = U('Shapes.mod');
    assert.ok(u.scope.syms.has('EditorOnly'));
    assert.ok(!u.scope.syms.has('ViewerOnly'));
    assert.equal(u.inactive.length, 1);
  });
  await test('hover shows DEF documentation', () => {
    const h = ft.hover(U('Client.mod'), at('Client.mod', 'Make(C'));
    const v = (h!.contents as { value: string }).value;
    assert.ok(v.includes('PROCEDURE Make(k : tKind; VAR s : tShape) : BOOLEAN'), v);
    assert.ok(v.includes('Makes a shape.'), v);
  });
  await test('hover on a field shows trailing comment', () => {
    const v = (ft.hover(U('Client.mod'), at('Client.mod', 'center'))!.contents as { value: string }).value;
    assert.ok(v.includes('centre of the shape'), v);
  });
  await test('references across DEF, MOD and clients', async () => {
    const u = U('Shapes.def');
    const r = ft.symAt(u, at('Shapes.def', 'Make('))!;
    const refs = await ft.references(r.sym, true, () => false);
    const where = refs.map(x => `${path.basename(x.unit.path)}:${line(x.unit, x.ref.start)}`).sort();
    assert.deepEqual(where, ['Client.mod:12', 'Client.mod:16', 'Client.mod:2', 'Shapes.def:26', 'Shapes.mod:23', 'Shapes.mod:33']);
  });
  await test('rename a type everywhere', async () => {
    const e = await ft.rename(U('Client.mod'), at('Client.mod', 'tShape,'), 'tFigure', () => false);
    assert.ok(typeof e !== 'string');
    const counts = Object.fromEntries(Object.entries(e.changes!).map(([k, v]) => [path.basename(k), v.length]));
    assert.deepEqual(counts, { 'Client.mod': 2, 'Shapes.def': 4, 'Shapes.mod': 1 });
  });
  await test('rename rejects keywords', async () => {
    assert.equal(typeof (await ft.rename(U('Client.mod'), at('Client.mod', 'sh :'), 'END', () => false)), 'string');
  });
  await test('completion after record designator', () => {
    const labels = ft.completion(U('Shapes.mod'), at('Shapes.mod', 's.kind', 2)).map(c => c.label);
    assert.deepEqual(labels.sort(), ['center', 'kind']);
  });
  await test('completion after module name', () => {
    const labels = ft.completion(U('Client.mod'), at('Client.mod', 'Shapes.Make', 7)).map(c => c.label);
    for (const l of ['Make', 'tShape', 'cDrawable', 'Circle']) assert.ok(labels.includes(l), l);
  });
  await test('completion on class instance includes inherited members', () => {
    const labels = ft.completion(U('Client.mod'), at('Client.mod', 'c.Draw', 2)).map(c => c.label);
    for (const l of ['Draw', 'Area', 'Radius']) assert.ok(labels.includes(l), l);
  });
  await test('completion in scope', () => {
    const labels = ft.completion(U('Client.mod'), at('Client.mod', 'ok := M', 6)).map(c => c.label);
    for (const l of ['Make', 'sh', 'Run', 'INTEGER', 'Circle']) assert.ok(labels.includes(l), l);
  });
  await test('completion of FROM import list', () => {
    const u = U('Client.mod');
    const labels = ft.completion(u, at('Client.mod', 'Make, tShape', 6)).map(c => c.label);
    assert.ok(labels.includes('tShapePtr'));
  });
  await test('signature help: active parameter', () => {
    const s = ft.signatureHelp(U('Client.mod'), at('Client.mod', 'Circle, sh', 8))!;
    assert.equal(s.signatures[0].label, 'Make(k : tKind; VAR s : tShape) : BOOLEAN');
    assert.equal(s.activeParameter, 1);
  });
  await test('document symbols outline', () => {
    const [m] = ft.documentSymbols(U('Shapes.def'));
    assert.equal(m.name, 'Shapes');
    const names = m.children!.map(c => c.name);
    assert.deepEqual(names, ['tKind', 'tShape', 'tShapePtr', 'tShapes', 'cDrawable', 'cCircle', 'Make']);
    assert.deepEqual(m.children![4].children!.map(c => c.name), ['Area', 'Draw']);
  });
  await test('document highlights', () => {
    const h = ft.highlights(U('Client.mod'), at('Client.mod', 'sh :'));
    assert.equal(h.length, 3);
  });
  await test('diagnostics: unknown module, unexported import, undeclared', () => {
    const d = ft.diagnostics(U('Bad.mod'), 'warning').map(x => `${x.severity}:${x.message}`);
    assert.ok(d.some(m => m.includes("'Nope' is not exported")), d.join('|'));
    assert.ok(d.some(m => m.includes("Module 'Missing' not found")), d.join('|'));
    assert.ok(d.some(m => m.includes("Undeclared identifier 'Undefined'")), d.join('|'));
    assert.equal(ft.diagnostics(U('Client.mod'), 'warning').length, 0);
  });
  await test('semantic tokens', () => {
    const data = ft.semanticTokens(U('Shapes.mod'));
    assert.equal(data.length % 5, 0);
    assert.ok(data.length > 50);
  });
  await test('call hierarchy', async () => {
    const u = U('Client.mod');
    const run = ft.symAt(u, at('Client.mod', 'Run;'))!.sym;
    const out = ft.outgoingCalls(run).map(c => c.to.name).sort();
    assert.deepEqual(out, ['Draw', 'Make']);
    const make = ft.symAt(U('Shapes.def'), at('Shapes.def', 'Make('))!.sym;
    const inc = await ft.incomingCalls(make, () => false);
    assert.deepEqual(inc.map(c => c.from.name).sort(), ['Client', 'Run']);
  });
  await test('folding ranges', () => assert.ok(ft.folding(U('Shapes.mod')).length >= 5));
  await test('positions round-trip', () => {
    const u = U('Shapes.mod');
    for (const o of [0, 10, 100, u.text.length]) assert.equal(offAt(u, posAt(u, o)), o);
  });
  await test('workspace symbols', async () => {
    const idx = new SymbolIndex(ws);
    await idx.build(ws.workspaceFiles(), () => false, () => {});
    const r = idx.query('shape');
    assert.ok(r.some(s => s.name === 'tShape'));
    assert.ok(r.some(s => s.name === 'Shapes'));
  });

  // ---------------------------------------------------------------- real-project smoke test (optional)
  const pyth = process.env.M2_SMOKE_ROOT ? path.resolve(process.env.M2_SMOKE_ROOT) : '';
  if (pyth && fs.existsSync(path.join(pyth, 'main/MOD/DrawDoc.mod'))) {
    console.log(`smoke test on ${pyth}`);
    const pws = new Workspace();
    pws.configure([pyth], {});
    const prs = new Resolver(pws);
    const pft = new Features(pws, prs);
    const dd = pws.unit(path.join(pyth, 'main/MOD/DrawDoc.mod'))!;
    const find = (u: Unit, s: string) => { const i = u.text.indexOf(s); assert.ok(i >= 0, s); return i; };
    await test('DrawDoc: FROM GrOut2 IMPORT ActDevice → GrOut2.def', () => {
      const l = pft.definition(dd, find(dd, 'ActDevice'));
      assert.ok(l[0]?.uri.toLowerCase().endsWith('grout2.def'), JSON.stringify(l));
    });
    await test('DrawDoc: outline has procedures', () => {
      const [m] = pft.documentSymbols(dd);
      assert.ok(m.children!.filter(c => c.kind === 12).length > 20);
    });
    await test('DrawDoc: no parse errors and few unresolved', () => {
      const d = pft.diagnostics(dd, 'warning').filter(x => x.severity! <= 2);
      assert.ok(d.length < 10, d.slice(0, 5).map(x => `${x.range.start.line + 1}: ${x.message}`).join('\n'));
    });
    const vp = pws.unit(path.join(pyth, 'main/MOD/Viewport.mod'))!;
    await test('Viewport: class field used in method → DEF class field', () => {
      const l = pft.definition(vp, find(vp, 'ViewportRect;'));
      assert.ok(l[0]?.uri.toLowerCase().endsWith('viewport.def'), JSON.stringify(l));
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
