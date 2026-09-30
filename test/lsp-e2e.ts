// End-to-end test: spawns dist/server.js over stdio and speaks LSP to it, like VS Code does.
// usage: node out/test/lsp-e2e.js <workspaceRoot> <file relative to root>

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

const [rootArg, rel] = process.argv.slice(2);
const root = path.resolve(rootArg);
const file = path.resolve(root, rel);
const uri = URI.file(file).toString();
const text = fs.readFileSync(file, 'latin1');

const server = spawn(process.execPath, [path.resolve(__dirname, '../../dist/server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
let id = 0;
const waiting = new Map<number, (r: unknown) => void>();
const notes: { method: string; params: unknown }[] = [];
const serverRequests: string[] = [];
const zedLike = !!process.env.ZED_LIKE;

server.stdout.on('data', (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, h).toString())![1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString());
    if (process.env.LSP_TRACE) console.error("<-", JSON.stringify(msg).slice(0, 200));
    buf = buf.slice(h + 4 + len);
    if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) { waiting.get(msg.id)!(msg.error ?? msg.result); waiting.delete(msg.id); }
    else if (msg.id !== undefined && msg.method) {
      serverRequests.push(`${msg.method}${msg.method === 'client/registerCapability' ? ' ' + msg.params.registrations.map((r: { method: string }) => r.method).join(',') : ''}`);
      // ZED_LIKE: answer with the whole configuration object, as some clients do
      const config = zedLike ? [{ modula2: { diagnostics: { unresolvedIdentifiers: 'warning' } } }] : [{}];
      send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? config : null });
    }
    else if (msg.method) notes.push(msg);
  }
});
function send(m: object) {
  const s = JSON.stringify(m);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request<T>(method: string, params: unknown): Promise<T> {
  const i = ++id;
  send({ jsonrpc: '2.0', id: i, method, params });
  return new Promise(r => waiting.set(i, r as (r: unknown) => void));
}
const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
const posOf = (needle: string) => {
  const off = text.indexOf(needle);
  const before = text.slice(0, off);
  const line = before.split('\n').length - 1;
  return { line, character: off - (before.lastIndexOf('\n') + 1) };
};

(async () => {
  const t0 = Date.now();
  const init = await request<{ capabilities: Record<string, unknown> }>('initialize', {
    processId: process.pid, rootUri: URI.file(root).toString(), workspaceFolders: [{ uri: URI.file(root).toString(), name: 'ws' }],
    clientInfo: { name: zedLike ? 'Zed' : 'test' },
    capabilities: { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: zedLike } }, window: { workDoneProgress: false } },
  });
  console.log('capabilities:', Object.keys(init.capabilities).join(', '));
  notify('initialized', {});
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'modula2', version: 1, text } });
  const td = { textDocument: { uri } };
  const syms = await request<{ name: string; children: unknown[] }[]>('textDocument/documentSymbol', td);
  console.log(`documentSymbol: module ${syms[0].name} with ${syms[0].children.length} children (${Date.now() - t0} ms since start)`);
  // first imported name
  const m = /FROM\s+(\w+)\s+IMPORT\s+(\w+)/.exec(text)!;
  const p = posOf(m[0]);
  p.character += m[0].length - 1;
  const def = await request<{ uri: string; range: { start: { line: number } } }[]>('textDocument/definition', { ...td, position: p });
  console.log(`definition of ${m[2]}: ${def.map(d => `${path.basename(URI.parse(d.uri).fsPath)}:${d.range.start.line + 1}`)}`);
  const hover = await request<{ contents: { value: string } }>('textDocument/hover', { ...td, position: p });
  console.log('hover:', hover?.contents.value.split('\n').slice(0, 3).join(' | '));
  const t1 = Date.now();
  const refs = await request<unknown[]>('textDocument/references', { ...td, position: p, context: { includeDeclaration: true } });
  console.log(`references to ${m[2]}: ${refs.length} (${Date.now() - t1} ms)`);
  const sem = await request<{ data: number[] }>('textDocument/semanticTokens/full', td);
  console.log(`semantic tokens: ${sem.data.length / 5}`);
  const fold = await request<unknown[]>('textDocument/foldingRange', td);
  console.log(`folding ranges: ${fold.length}`);
  await new Promise(r => setTimeout(r, 1500));
  const diag = notes.filter(n => n.method === 'textDocument/publishDiagnostics' && (n.params as { uri: string }).uri === uri).pop();
  const ds = (diag?.params as { diagnostics: { severity: number; message: string; range: { start: { line: number } } }[] })?.diagnostics ?? [];
  console.log(`diagnostics: ${ds.filter(d => d.severity === 1).length} errors, ${ds.filter(d => d.severity === 2).length} warnings, ${ds.filter(d => d.severity === 3).length} info`);
  for (const d of ds.filter(d => d.severity <= 3).slice(0, 8)) console.log(`   ${d.range.start.line + 1}: ${d.message}`);
  const t2 = Date.now();
  const wsym = await request<unknown[]>('workspace/symbol', { query: 'Draw' });
  console.log(`workspace/symbol "Draw": ${wsym.length} (${Date.now() - t2} ms)`);
  console.log('server requests:', serverRequests.join(' | '));
  await request('shutdown', null);
  notify('exit', null);
  setTimeout(() => process.exit(0), 200);
})();
