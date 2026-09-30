// Modula-2 language server (ADW dialect).

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import {
  createConnection, Diagnostic, DidChangeConfigurationNotification, FileChangeType, InitializeResult,
  ProposedFeatures, TextDocuments, TextDocumentSyncKind, WorkDoneProgressReporter, CancellationToken,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Features, offAt, parseErrFile, rangeOf, SymbolIndex, TOKEN_MODS, TOKEN_TYPES } from './features';
import { Resolver } from './resolver';
import { Settings, Workspace } from './workspace';

interface ClientSettings extends Partial<Settings> {
  diagnostics?: { unresolvedIdentifiers?: 'off' | 'hint' | 'information' | 'warning' | 'error'; compilerErrors?: boolean };
  index?: { onStartup?: boolean };
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const ws = new Workspace();
const rs = new Resolver(ws);
const ft = new Features(ws, rs);
const index = new SymbolIndex(ws);

let roots: string[] = [];
let settings: ClientSettings = {};
let hasConfigCapability = false;
const errDiagnostics = new Map<string, Map<string, Diagnostic[]>>(); // err file -> uri -> diags

const log = (m: string) => connection.console.log(m);

// requests wait until the first configuration + workspace scan is done
let markReady: () => void;
const ready = new Promise<void>(r => (markReady = r));

connection.onInitialize((params): InitializeResult => {
  hasConfigCapability = !!params.capabilities.workspace?.configuration;
  roots = (params.workspaceFolders ?? []).map(f => URI.parse(f.uri).fsPath);
  if (!roots.length && params.rootUri) roots = [URI.parse(params.rootUri).fsPath];
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: { label: 'Modula-2' },
      workspaceSymbolProvider: true,
      definitionProvider: true,
      declarationProvider: true,
      implementationProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: { workDoneProgress: true },
      renameProvider: { prepareProvider: true },
      hoverProvider: true,
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      callHierarchyProvider: true,
      completionProvider: { triggerCharacters: ['.', ' ', ','] },
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODS }, full: true, range: false },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'modula2-language-server', version: '1.0.0' },
  };
});

async function loadSettings() {
  if (hasConfigCapability) {
    const s = (await connection.workspace.getConfiguration('modula2')) as ClientSettings | null;
    settings = s ?? {};
  }
  const t0 = Date.now();
  ws.configure(roots, {
    searchPaths: settings.searchPaths ?? [],
    adwPath: settings.adwPath ?? undefined,
    exclude: settings.exclude ?? undefined,
    defines: settings.defines ?? {},
    cacheSize: settings.cacheSize ?? undefined,
  } as Partial<Settings>);
  for (const d of documents.all()) ws.setOpen(d.uri, d.getText(), d.version);
  log(`Indexed ${ws.files.size} Modula-2 files (${ws.defs.size} DEF modules) in ${Date.now() - t0} ms; roots: ${roots.join(', ')}`);
}

connection.onInitialized(async () => {
  if (hasConfigCapability) connection.client.register(DidChangeConfigurationNotification.type, { section: 'modula2' });
  await loadSettings();
  markReady();
  scanErrFiles();
  refreshAllDiagnostics();
  if (settings.index?.onStartup !== false) void buildIndex();
});

connection.onDidChangeConfiguration(async () => {
  await loadSettings();
  scanErrFiles();
  refreshAllDiagnostics();
  void buildIndex();
});

// ---------------------------------------------------------------- workspace index
let indexRun = 0;
async function buildIndex() {
  const run = ++indexRun;
  let progress: WorkDoneProgressReporter | undefined;
  try { progress = await connection.window.createWorkDoneProgress(); } catch { /* client without progress */ }
  const files = ws.workspaceFiles();
  progress?.begin('Modula-2: indexing symbols', 0, `${files.length} files`, false);
  const t0 = Date.now();
  await index.build(files, () => run !== indexRun, (done, total) => progress?.report(Math.round((100 * done) / total), `${done}/${total}`));
  progress?.done();
  if (run === indexRun) log(`Symbol index built for ${files.length} files in ${Date.now() - t0} ms`);
}

// ---------------------------------------------------------------- documents & diagnostics
const pending = new Map<string, NodeJS.Timeout>();

function unitOf(uri: string) {
  return ws.unitForUri(uri);
}

function publish(uri: string) {
  const own: Diagnostic[] = [];
  const doc = documents.get(uri);
  if (doc) {
    const u = unitOf(uri);
    if (u) {
      own.push(...ft.diagnostics(u, settings.diagnostics?.unresolvedIdentifiers ?? 'information'));
      index.indexUnit(u);
    }
  }
  if (settings.diagnostics?.compilerErrors !== false) {
    const key = URI.parse(uri).toString();
    for (const m of errDiagnostics.values()) own.push(...(m.get(key) ?? []));
  }
  connection.sendDiagnostics({ uri, diagnostics: own });
}

function schedule(uri: string, delay = 250) {
  clearTimeout(pending.get(uri));
  pending.set(uri, setTimeout(() => { pending.delete(uri); void ready.then(() => publish(uri)); }, delay));
}

function refreshAllDiagnostics() {
  const uris = new Set(documents.all().map(d => d.uri));
  for (const m of errDiagnostics.values()) for (const u of m.keys()) uris.add(u);
  for (const u of uris) publish(u);
}

documents.onDidOpen(e => { ws.setOpen(e.document.uri, e.document.getText(), e.document.version); schedule(e.document.uri, 0); });
documents.onDidChangeContent(e => {
  ws.setOpen(e.document.uri, e.document.getText(), e.document.version);
  schedule(e.document.uri);
  // other open documents may depend on the changed DEF
  if (/\.def$/i.test(e.document.uri)) for (const d of documents.all()) if (d.uri !== e.document.uri) schedule(d.uri, 1500);
});
documents.onDidClose(e => { ws.close(e.document.uri); publish(e.document.uri); });

connection.onDidChangeWatchedFiles(({ changes }) => {
  let errChanged = false;
  for (const c of changes) {
    const p = URI.parse(c.uri).fsPath;
    if (/\.err$/i.test(p)) {
      errChanged = true;
      if (c.type === FileChangeType.Deleted) errDiagnostics.delete(p.toLowerCase());
      else errDiagnostics.set(p.toLowerCase(), parseErrFile(p));
      continue;
    }
    if (c.type === FileChangeType.Deleted) { ws.removeFile(p); index.remove(p); }
    else if (c.type === FileChangeType.Created) { ws.addFile(p); ws.invalidate(p); }
    else if (!ws.isOpen(p)) { ws.invalidate(p); index.remove(p); }
  }
  if (errChanged) refreshAllDiagnostics();
  else for (const d of documents.all()) schedule(d.uri, 500);
});

function scanErrFiles() {
  errDiagnostics.clear();
  if (settings.diagnostics?.compilerErrors === false) return;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.err$/i.test(e.name)) errDiagnostics.set(p.toLowerCase(), parseErrFile(p));
    }
  };
  for (const r of roots) walk(r, 0);
}

// ---------------------------------------------------------------- requests
async function at<T>(uri: string, pos: { line: number; character: number }, f: (u: NonNullable<ReturnType<typeof unitOf>>, off: number) => T): Promise<T | null> {
  await ready;
  const u = unitOf(uri);
  if (!u) return null;
  try {
    return f(u, offAt(u, pos));
  } catch (e) {
    connection.console.error(`${(e as Error).stack ?? e}`);
    return null;
  }
}

connection.onDocumentSymbol(async p => { await ready; const u = unitOf(p.textDocument.uri); return u ? ft.documentSymbols(u) : []; });
connection.onWorkspaceSymbol(async p => { await ready; return index.query(p.query); });
connection.onDefinition(p => at(p.textDocument.uri, p.position, (u, o) => ft.definition(u, o)));
connection.onDeclaration(p => at(p.textDocument.uri, p.position, (u, o) => ft.declaration(u, o)));
connection.onImplementation(p => at(p.textDocument.uri, p.position, (u, o) => ft.implementation(u, o)));
connection.onTypeDefinition(p => at(p.textDocument.uri, p.position, (u, o) => ft.typeDefinition(u, o)));
connection.onHover(p => at(p.textDocument.uri, p.position, (u, o) => ft.hover(u, o) ?? null));
connection.onDocumentHighlight(p => at(p.textDocument.uri, p.position, (u, o) => ft.highlights(u, o)));
connection.onCompletion(p => at(p.textDocument.uri, p.position, (u, o) => ft.completion(u, o)));
connection.onSignatureHelp(p => at(p.textDocument.uri, p.position, (u, o) => ft.signatureHelp(u, o) ?? null));
connection.onFoldingRanges(async p => { await ready; const u = unitOf(p.textDocument.uri); return u ? ft.folding(u) : []; });
connection.languages.semanticTokens.on(async p => {
  await ready;
  const u = unitOf(p.textDocument.uri);
  return { data: u ? ft.semanticTokens(u) : [] };
});

connection.onReferences(async (p, token: CancellationToken, workDone) => {
  await ready;
  const u = unitOf(p.textDocument.uri);
  if (!u) return [];
  const r = ft.symAt(u, offAt(u, p.position));
  if (!r) return [];
  workDone?.begin(`Finding references to ${r.sym.name}`, 0, undefined, true);
  const refs = await ft.references(r.sym, p.context.includeDeclaration, () => token.isCancellationRequested,
    (d, t) => workDone?.report(Math.round((100 * d) / t)));
  workDone?.done();
  return refs.map(({ unit, ref }) => ({ uri: unit.uri, range: rangeOf(unit, ref.start, ref.end) }));
});

connection.onPrepareRename(async p => {
  const res = await at(p.textDocument.uri, p.position, (u, o) => ft.prepareRename(u, o));
  if (typeof res === 'string') throw new Error(res);
  return res;
});

connection.onRenameRequest(async (p, token) => {
  await ready;
  const u = unitOf(p.textDocument.uri);
  if (!u) return null;
  const res = await ft.rename(u, offAt(u, p.position), p.newName, () => token.isCancellationRequested);
  if (typeof res === 'string') throw new Error(res);
  return res;
});

connection.languages.callHierarchy.onPrepare(p => at(p.textDocument.uri, p.position, (u, o) => {
  const r = ft.symAt(u, o);
  if (!r || r.sym.kind !== 'procedure') return null;
  const item = ft.callItem(r.sym);
  return item ? [item] : null;
}));
connection.languages.callHierarchy.onIncomingCalls(async (p, token) => {
  await ready;
  const s = ft.symFromItem(p.item);
  return s ? ft.incomingCalls(s, () => token.isCancellationRequested) : [];
});
connection.languages.callHierarchy.onOutgoingCalls(async p => {
  await ready;
  const s = ft.symFromItem(p.item);
  return s ? ft.outgoingCalls(s) : [];
});

// custom requests
connection.onRequest('modula2/counterpart', async (p: { uri: string }) => {
  await ready;
  const f = ws.counterpartPath(URI.parse(p.uri).fsPath);
  return f ? URI.file(f).toString() : null;
});
connection.onRequest('modula2/reindex', async () => {
  await loadSettings();
  scanErrFiles();
  refreshAllDiagnostics();
  await buildIndex();
  return { files: ws.files.size };
});
connection.onRequest('modula2/moduleInfo', async (p: { uri: string }) => {
  await ready;
  const u = unitOf(p.uri);
  if (!u) return null;
  return { name: u.name, kind: u.kind, imports: u.imports.map(i => i.module), counterpart: ws.counterpartPath(u.path) ?? null };
});

documents.listen(connection);
connection.listen();
