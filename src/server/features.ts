// Language features built on the parser + resolver, independent of the LSP transport.

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import {
  CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, CompletionItem, CompletionItemKind,
  Diagnostic, DiagnosticSeverity, DiagnosticTag, DocumentHighlight, DocumentHighlightKind, DocumentSymbol,
  FoldingRange, FoldingRangeKind, Hover, Location, MarkupKind, ParameterInformation, Position, Range,
  SignatureHelp, SymbolInformation, SymbolKind, TextEdit, WorkspaceEdit,
} from 'vscode-languageserver';
import { isBuiltin } from './builtins';
import { KEYWORDS } from './lexer';
import { Op, Ref, Scope, Sym, Unit } from './model';
import { Resolver, symKey } from './resolver';
import { Workspace } from './workspace';

// ---------------------------------------------------------------- positions

const lineCache = new WeakMap<Unit, number[]>();
function lineStarts(u: Unit): number[] {
  let ls = lineCache.get(u);
  if (!ls) {
    ls = [0];
    const t = u.text;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) ls.push(i + 1);
    lineCache.set(u, ls);
  }
  return ls;
}
export function posAt(u: Unit, off: number): Position {
  const ls = lineStarts(u);
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ls[m] <= off) lo = m;
    else hi = m - 1;
  }
  return { line: lo, character: off - ls[lo] };
}
export function offAt(u: Unit, p: Position): number {
  const ls = lineStarts(u);
  const l = Math.min(Math.max(p.line, 0), ls.length - 1);
  return Math.min(ls[l] + p.character, u.text.length);
}
export const rangeOf = (u: Unit, s: number, e: number): Range => ({ start: posAt(u, s), end: posAt(u, e) });
const locOf = (s: Sym): Location | undefined => (isBuiltin(s) || !s.unit.path ? undefined : { uri: s.unit.uri, range: rangeOf(s.unit, s.nameStart, s.nameEnd) });

// ---------------------------------------------------------------- kinds

function symbolKind(s: Sym): SymbolKind {
  switch (s.kind) {
    case 'module': return SymbolKind.Module;
    case 'const': return SymbolKind.Constant;
    case 'class': return SymbolKind.Class;
    case 'var': return SymbolKind.Variable;
    case 'field': return SymbolKind.Field;
    case 'param': return SymbolKind.Variable;
    case 'enumMember': return SymbolKind.EnumMember;
    case 'genericParam': return SymbolKind.TypeParameter;
    case 'procedure': return s.container?.kind === 'class' ? SymbolKind.Method : SymbolKind.Function;
    case 'type':
      switch (s.type?.k) {
        case 'record': return SymbolKind.Struct;
        case 'enum': return SymbolKind.Enum;
        case 'proc': return SymbolKind.Function;
        default: return SymbolKind.TypeParameter;
      }
  }
}

function completionKind(s: Sym): CompletionItemKind {
  switch (s.kind) {
    case 'module': return CompletionItemKind.Module;
    case 'const': return CompletionItemKind.Constant;
    case 'class': return CompletionItemKind.Class;
    case 'var': case 'param': return CompletionItemKind.Variable;
    case 'field': return CompletionItemKind.Field;
    case 'enumMember': return CompletionItemKind.EnumMember;
    case 'procedure': return s.container?.kind === 'class' ? CompletionItemKind.Method : CompletionItemKind.Function;
    case 'type': return s.type?.k === 'record' ? CompletionItemKind.Struct : s.type?.k === 'enum' ? CompletionItemKind.Enum : CompletionItemKind.TypeParameter;
    default: return CompletionItemKind.Text;
  }
}

const KIND_WORD: Record<string, string> = {
  module: 'module', const: 'CONST', type: 'TYPE', class: 'CLASS', var: 'VAR', field: 'field', param: 'parameter',
  procedure: 'PROCEDURE', enumMember: 'enumeration constant', genericParam: 'generic parameter',
};

export const TOKEN_TYPES = ['namespace', 'type', 'class', 'enum', 'enumMember', 'function', 'method', 'parameter', 'variable', 'property', 'struct', 'typeParameter', 'comment', 'macro'];
export const TOKEN_MODS = ['declaration', 'readonly', 'defaultLibrary', 'static'];

export class Features {
  constructor(public ws: Workspace, public rs: Resolver) {}

  // ---------------------------------------------------------------- symbol at cursor
  symAt(u: Unit, off: number): { ref: Ref; sym: Sym } | undefined {
    const ref = this.rs.refAt(u, off) ?? this.rs.refAt(u, off - 1);
    if (!ref) return undefined;
    const sym = this.rs.resolveRef(ref);
    return sym ? { ref, sym } : undefined;
  }

  // ---------------------------------------------------------------- outline
  documentSymbols(u: Unit): DocumentSymbol[] {
    const conv = (s: Sym, depth: number): DocumentSymbol | undefined => {
      if (s.kind === 'param') return undefined;
      const start = Math.min(s.start, s.nameStart);
      const end = Math.max(s.end, s.nameEnd);
      const children: DocumentSymbol[] = [];
      if (s.children && (s.kind !== 'procedure' || depth < 8)) {
        for (const c of s.children) {
          // keep outlines readable: inside procedures show nested procedures, types and constants only
          if (s.kind === 'procedure' && c.kind === 'var') continue;
          const d = conv(c, depth + 1);
          if (d) children.push(d);
        }
      }
      let detail = s.kind === 'procedure' ? s.detail.replace(/^.*?PROCEDURE\s+\w+\s*/, '') : s.kind === 'var' || s.kind === 'field' ? s.detail.replace(/^\w+\s*:\s*/, '') : '';
      if (s.forward) detail += ' FORWARD';
      if (detail.length > 120) detail = detail.slice(0, 120) + '…';
      return {
        name: s.name, kind: symbolKind(s), detail,
        range: rangeOf(u, start, end), selectionRange: rangeOf(u, s.nameStart, s.nameEnd),
        children,
      };
    };
    const top = u.symbols.map(s => conv(s, 0)).filter((x): x is DocumentSymbol => !!x);
    if (u.moduleSym) {
      const m = u.moduleSym;
      return [{
        name: m.name, kind: SymbolKind.Module, detail: m.detail.replace(` ${m.name}`, ''),
        range: rangeOf(u, m.start, Math.max(m.end, m.nameEnd)), selectionRange: rangeOf(u, m.nameStart, m.nameEnd), children: top,
      }];
    }
    return top;
  }

  // ---------------------------------------------------------------- navigation
  definition(u: Unit, off: number): Location[] {
    const r = this.symAt(u, off);
    if (!r) return [];
    let target = r.sym;
    // on a declaration name, jump to the counterpart (MOD body <-> DEF heading)
    if (r.ref.decl) target = this.rs.counterpartSym(r.sym) ?? r.sym;
    // PROCEDURE A = B aliases
    const loc = locOf(target);
    return loc ? [loc] : [];
  }

  declaration(u: Unit, off: number): Location[] {
    const r = this.symAt(u, off);
    if (!r) return [];
    const s = r.sym.unit.kind === 'implementation' ? this.rs.counterpartSym(r.sym) ?? r.sym : r.sym;
    const loc = locOf(s);
    return loc ? [loc] : [];
  }

  implementation(u: Unit, off: number): Location[] {
    const r = this.symAt(u, off);
    if (!r) return [];
    const sym = r.sym;
    const out: Location[] = [];
    if (sym.kind === 'module' && sym === sym.unit.moduleSym) {
      const m = this.ws.implementationUnit(sym.name, u.path);
      if (m?.moduleSym) out.push(locOf(m.moduleSym)!);
      return out;
    }
    const impl = sym.unit.kind === 'definition' ? this.rs.counterpartSym(sym) : sym;
    if (impl) { const l = locOf(impl); if (l) out.push(l); }
    return out;
  }

  typeDefinition(u: Unit, off: number): Location[] {
    const r = this.symAt(u, off);
    if (!r) return [];
    const t = this.rs.typeSymOf(r.sym);
    const loc = t && locOf(t);
    return loc ? [loc] : [];
  }

  // ---------------------------------------------------------------- references
  /** keys identifying a symbol and its DEF/MOD counterpart */
  targetKeys(sym: Sym): Set<string> {
    const keys = new Set([symKey(sym)]);
    const c = this.rs.counterpartSym(sym);
    if (c) keys.add(symKey(c));
    return keys;
  }

  /** files that may reference the symbol */
  candidateFiles(sym: Sym): string[] {
    const counterpart = this.rs.counterpartSym(sym);
    const exported = isBuiltin(sym) || sym.unit.kind === 'definition' || counterpart?.unit.kind === 'definition' || !sym.unit.path;
    const local = !exported && (sym.kind === 'param' || (sym.container && sym.container.kind === 'procedure') || sym.unit.kind !== 'definition');
    if (local && sym.unit.path) return [sym.unit.path];
    const re = new RegExp(`\\b${sym.name}\\b`);
    return this.ws.workspaceFiles().filter(f => {
      const t = this.ws.readText(f);
      return !!t && t.includes(sym.name) && re.test(t);
    });
  }

  async references(sym: Sym, includeDecl: boolean, cancelled: () => boolean, progress?: (done: number, total: number) => void): Promise<{ unit: Unit; ref: Ref }[]> {
    const keys = this.targetKeys(sym);
    const files = this.candidateFiles(sym);
    const out: { unit: Unit; ref: Ref }[] = [];
    let i = 0;
    for (const f of files) {
      if (cancelled()) break;
      if (++i % 20 === 0) { progress?.(i, files.length); await new Promise(r => setImmediate(r)); }
      const u = this.ws.unit(f);
      if (!u) continue;
      for (const r of u.refs) {
        if (r.name !== sym.name) continue;
        if (!includeDecl && r.decl) continue;
        const s = this.rs.resolveRef(r);
        if (s && keys.has(symKey(s))) out.push({ unit: u, ref: r });
      }
    }
    return out;
  }

  highlights(u: Unit, off: number): DocumentHighlight[] {
    const r = this.symAt(u, off);
    if (!r) return [];
    const keys = this.targetKeys(r.sym);
    const out: DocumentHighlight[] = [];
    for (const ref of u.refs) {
      if (ref.name !== r.sym.name) continue;
      const s = this.rs.resolveRef(ref);
      if (s && keys.has(symKey(s))) out.push({ range: rangeOf(u, ref.start, ref.end), kind: ref.decl ? DocumentHighlightKind.Write : DocumentHighlightKind.Read });
    }
    return out;
  }

  prepareRename(u: Unit, off: number): { range: Range; placeholder: string } | string {
    const r = this.symAt(u, off);
    if (!r) return 'No symbol to rename here.';
    if (isBuiltin(r.sym)) return 'Built-in identifiers cannot be renamed.';
    if (this.ws.isLibrary(r.sym.unit.path)) return 'Library symbols cannot be renamed.';
    if (r.sym.kind === 'module' && r.sym === r.sym.unit.moduleSym) return 'Renaming a module requires renaming its files; not supported.';
    return { range: rangeOf(u, r.ref.start, r.ref.end), placeholder: r.ref.name };
  }

  async rename(u: Unit, off: number, newName: string, cancelled: () => boolean): Promise<WorkspaceEdit | string> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) || KEYWORDS.has(newName)) return `'${newName}' is not a valid identifier.`;
    const p = this.prepareRename(u, off);
    if (typeof p === 'string') return p;
    const r = this.symAt(u, off)!;
    const refs = await this.references(r.sym, true, cancelled);
    const changes: Record<string, TextEdit[]> = {};
    for (const { unit, ref } of refs) (changes[unit.uri] ??= []).push({ range: rangeOf(unit, ref.start, ref.end), newText: newName });
    return { changes };
  }

  // ---------------------------------------------------------------- hover
  signature(s: Sym): string {
    if (s.kind === 'procedure') return s.detail.startsWith('PROCEDURE') || /^(ABSTRACT|OVERRIDE)/.test(s.detail) ? s.detail : `PROCEDURE ${s.detail}`;
    if (s.kind === 'module') return s.detail;
    if (s.kind === 'class') return s.detail;
    if (s.kind === 'type' && s.unit.text && s.end > s.start) {
      // show the declaration as written (records, enumerations) up to 40 lines
      let src = s.unit.text.slice(s.start, s.end).replace(/\r/g, '');
      const lines = src.split('\n');
      if (lines.length > 40) src = lines.slice(0, 40).join('\n') + '\n  …';
      const ind = Math.min(...src.split('\n').slice(1).filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length), 99);
      src = src.split('\n').map((l, i) => (i ? l.slice(Math.min(ind, /^\s*/.exec(l)![0].length)) : l)).join('\n');
      return `TYPE ${src.replace(/\t/g, '    ')}`;
    }
    if (s.kind === 'const') return `CONST ${s.detail}`;
    if (s.kind === 'var') return `VAR ${s.detail}`;
    if (s.kind === 'field') return `${s.container ? '(field) ' : ''}${s.detail}`;
    if (s.kind === 'param') return `(parameter) ${s.detail}`;
    if (s.kind === 'enumMember') return `(enumeration constant) ${s.detail}`;
    return s.detail;
  }

  hoverText(s: Sym): string {
    const parts = ['```modula2\n' + this.signature(s) + '\n```'];
    const where: string[] = [];
    if (s.container && s.kind !== 'param') where.push(`${KIND_WORD[s.container.kind] === 'CLASS' ? 'class' : KIND_WORD[s.container.kind] ?? s.container.kind} \`${s.container.name}\``);
    if (s.unit.name && s.kind !== 'module') where.push(`module \`${s.unit.name}\`${s.unit.kind === 'definition' ? ' (DEF)' : s.unit.kind === 'implementation' ? ' (MOD)' : ''}`);
    if (isBuiltin(s)) where.splice(0, where.length, s.unit.name === '(pervasive)' ? 'pervasive identifier' : `compiler module \`${s.unit.name}\``);
    if (where.length) parts.push(`*${KIND_WORD[s.kind] ?? s.kind}* in ${where.join(', ')}`);
    let doc = s.doc;
    if (!doc) {
      // a MOD body without comment: use the DEF heading documentation
      const c = this.rs.counterpartSym(s);
      doc = c?.doc;
    }
    if (doc) parts.push(doc.includes('\n') ? '```text\n' + doc + '\n```' : doc);
    return parts.join('\n\n');
  }

  hover(u: Unit, off: number): Hover | undefined {
    const r = this.symAt(u, off);
    if (!r) return undefined;
    return { contents: { kind: MarkupKind.Markdown, value: this.hoverText(r.sym) }, range: rangeOf(u, r.ref.start, r.ref.end) };
  }

  // ---------------------------------------------------------------- completion
  private toItem(s: Sym, sortPrefix = '1'): CompletionItem {
    const item: CompletionItem = {
      label: s.name, kind: completionKind(s), detail: this.signature(s).split('\n')[0].slice(0, 200), sortText: sortPrefix + s.name,
      data: undefined,
    };
    if (s.doc) item.documentation = { kind: MarkupKind.Markdown, value: s.doc.includes('\n') ? '```text\n' + s.doc + '\n```' : s.doc };
    return item;
  }

  /** backward scan from `dot` over selectors to the identifier the member access applies to */
  private baseBeforeDot(u: Unit, dot: number): { ref: Ref; ops: Op[] } | undefined {
    const t = u.text;
    let i = dot - 1;
    const ops: Op[] = [];
    const skipWs = () => { while (i >= 0 && /\s/.test(t[i])) i--; };
    for (let guard = 0; guard < 64; guard++) {
      skipWs();
      const c = t[i];
      if (c === '^') { ops.unshift('^'); i--; continue; }
      if (c === ']' || c === ')') {
        const open = c === ']' ? '[' : '(';
        let depth = 0;
        for (; i >= 0; i--) {
          if (t[i] === c) depth++;
          else if (t[i] === open && --depth === 0) break;
        }
        ops.unshift(c === ']' ? '[]' : '()');
        i--;
        continue;
      }
      break;
    }
    if (i < 0 || !/[A-Za-z0-9_]/.test(t[i])) return undefined;
    const ref = this.rs.refAt(u, i);
    return ref ? { ref, ops } : undefined;
  }

  completion(u: Unit, off: number): CompletionItem[] {
    const t = u.text;
    let w = off;
    while (w > 0 && /[A-Za-z0-9_]/.test(t[w - 1])) w--;
    const lineStart = t.lastIndexOf('\n', w - 1) + 1;
    const before = t.slice(Math.max(0, w - 2000), w);

    // FROM M IMPORT a, |
    const fromImp = /FROM\s+([A-Za-z_]\w*)\s+IMPORT\s+[\w\s,]*$/.exec(before);
    if (fromImp) {
      const mod = this.rs.moduleSym(fromImp[1], u);
      return mod ? this.rs.membersOf(mod, []).map(s => this.toItem(s)) : [];
    }
    // IMPORT a, | / FROM |
    if (/(^|[;\s])(IMPORT\s+[\w\s,]*|FROM\s+)$/.test(before) && !/:=|\(/.test(before.slice(before.lastIndexOf(';') + 1))) {
      return this.moduleNames();
    }
    // member access
    let j = w - 1;
    while (j >= lineStart && /\s/.test(t[j])) j--;
    if (t[j] === '.' && t[j - 1] !== '.') {
      const b = this.baseBeforeDot(u, j);
      const base = b && this.rs.resolveRef(b.ref);
      if (!base) return [];
      return this.rs.membersOf(base, b.ops).map(s => this.toItem(s));
    }
    // everything visible
    const scope = this.rs.scopeAt(u, off);
    const items = this.rs.visible(scope, off).map(s => this.toItem(s, isBuiltin(s) ? '3' : s.unit === u ? '1' : '2'));
    for (const k of KEYWORDS) items.push({ label: k, kind: CompletionItemKind.Keyword, sortText: '4' + k });
    return items;
  }

  moduleNames(): CompletionItem[] {
    const seen = new Set<string>();
    const out: CompletionItem[] = [];
    for (const list of [this.ws.defs, this.ws.mods]) {
      for (const paths of list.values()) {
        const name = path.basename(paths[0], path.extname(paths[0]));
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ label: name, kind: CompletionItemKind.Module, detail: paths[0] });
      }
    }
    for (const n of ['SYSTEM', 'EXCEPTIONS', 'M2EXCEPTION', 'TERMINATION', 'COROUTINES']) out.push({ label: n, kind: CompletionItemKind.Module, detail: 'compiler module' });
    return out;
  }

  // ---------------------------------------------------------------- signature help
  signatureHelp(u: Unit, off: number): SignatureHelp | undefined {
    const t = u.text;
    let depth = 0, commas = 0;
    let i = off - 1;
    const limit = Math.max(0, off - 4000);
    for (; i >= limit; i--) {
      const c = t[i];
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') {
        if (depth === 0) { if (c === '(') break; else return undefined; }
        depth--;
      } else if (c === ',' && depth === 0) commas++;
      else if (c === ';' && depth === 0) return undefined;
      else if ((c === '"' || c === "'")) { const q = t.lastIndexOf(c, i - 1); if (q >= 0 && t.lastIndexOf('\n', i) < q) i = q; }
    }
    if (i < limit || t[i] !== '(') return undefined;
    let j = i - 1;
    while (j >= 0 && /\s/.test(t[j])) j--;
    const ref = this.rs.refAt(u, j);
    if (!ref) return undefined;
    let sym = this.rs.resolveRef(ref);
    if (!sym) return undefined;
    if (sym.kind === 'procedure' && sym.instanceOf) sym = this.rs.resolveTypeName(sym.instanceOf) ?? sym;
    let label: string;
    let params: string[];
    if (sym.kind === 'procedure' && sym.params) {
      params = sym.params.map(p => p.detail);
      label = `${sym.name}(${params.join('; ')})${sym.ret?.k === 'named' ? ' : ' + sym.ret.names.join('.') : ''}`;
    } else {
      const ty = sym.kind === 'var' || sym.kind === 'field' || sym.kind === 'param' ? this.rs.resolveType(sym.type) : undefined;
      if (ty?.k === 'proc') {
        params = ty.params;
        label = `${sym.name}(${params.join(', ')})${ty.ret?.k === 'named' ? ' : ' + ty.ret.names.join('.') : ''}`;
      } else if (isBuiltin(sym) && sym.kind === 'procedure') {
        return { signatures: [{ label: sym.detail, documentation: sym.doc }], activeSignature: 0, activeParameter: commas };
      } else return undefined;
    }
    const pinfo: ParameterInformation[] = [];
    let pos = label.indexOf('(') + 1;
    for (const p of params) {
      const at = label.indexOf(p, pos);
      pinfo.push({ label: [at, at + p.length] });
      pos = at + p.length;
    }
    return {
      signatures: [{ label, parameters: pinfo, documentation: sym.doc ? { kind: MarkupKind.Markdown, value: sym.doc } : undefined }],
      activeSignature: 0,
      activeParameter: Math.min(commas, Math.max(0, pinfo.length - 1)),
    };
  }

  // ---------------------------------------------------------------- folding
  folding(u: Unit): FoldingRange[] {
    const out: FoldingRange[] = [];
    for (const f of u.folds) {
      const a = posAt(u, f.start).line;
      let b = posAt(u, f.end).line;
      if (f.kind !== 'comment' && f.kind !== 'region' && f.kind !== 'imports') b--; // keep END visible
      if (b <= a) continue;
      out.push({ startLine: a, endLine: b, kind: f.kind === 'comment' ? FoldingRangeKind.Comment : f.kind === 'imports' ? FoldingRangeKind.Imports : f.kind === 'region' ? FoldingRangeKind.Region : undefined });
    }
    return out;
  }

  // ---------------------------------------------------------------- semantic tokens
  semanticTokens(u: Unit): number[] {
    const data: number[] = [];
    let prevLine = 0, prevChar = 0;
    const push = (line: number, ch: number, len: number, type: number, mods: number) => {
      data.push(line - prevLine, line === prevLine ? ch - prevChar : ch, len, type, mods);
      prevLine = line;
      prevChar = ch;
    };
    const ty = (n: string) => TOKEN_TYPES.indexOf(n);
    const inactive = [...u.inactive].sort((a, b) => a.start - b.start);
    let ii = 0;
    const flushInactive = (upTo: number) => {
      while (ii < inactive.length && inactive[ii].start < upTo) {
        const r = inactive[ii++];
        const a = posAt(u, r.start), b = posAt(u, r.end);
        const ls = lineStarts(u);
        for (let l = a.line; l <= b.line; l++) {
          const s = l === a.line ? a.character : 0;
          const lineEnd = (l + 1 < ls.length ? ls[l + 1] - 1 : u.text.length) - ls[l];
          const e = l === b.line ? b.character : lineEnd;
          if (e > s) push(l, s, e - s, ty('comment'), 0);
        }
      }
    };
    for (const r of u.refs) {
      flushInactive(r.start);
      const s = this.rs.resolveRef(r);
      if (!s) continue;
      let type: string;
      switch (s.kind) {
        case 'module': type = 'namespace'; break;
        case 'type': type = s.type?.k === 'enum' ? 'enum' : s.type?.k === 'record' ? 'struct' : 'type'; break;
        case 'class': type = 'class'; break;
        case 'enumMember': type = 'enumMember'; break;
        case 'procedure': type = s.container?.kind === 'class' ? 'method' : 'function'; break;
        case 'param': type = 'parameter'; break;
        case 'field': type = 'property'; break;
        case 'const': type = 'variable'; break;
        case 'genericParam': type = 'typeParameter'; break;
        default: type = 'variable';
      }
      let mods = 0;
      if (r.decl) mods |= 1;
      if (s.kind === 'const' || s.kind === 'enumMember' || s.readonly) mods |= 2;
      if (isBuiltin(s)) mods |= 4;
      if (s.kind === 'var' && (!s.container || s.container.kind === 'module')) mods |= 8;
      const p = posAt(u, r.start);
      push(p.line, p.character, r.end - r.start, ty(type), mods);
    }
    flushInactive(Number.MAX_SAFE_INTEGER);
    return data;
  }

  // ---------------------------------------------------------------- diagnostics
  diagnostics(u: Unit, unresolvedSeverity: 'off' | 'hint' | 'information' | 'warning' | 'error'): Diagnostic[] {
    const out: Diagnostic[] = u.diags.map(d => ({ range: rangeOf(u, d.start, d.end), message: d.message, severity: d.severity as DiagnosticSeverity, source: 'modula2' }));
    for (const imp of u.imports) {
      if (imp.from || u.scope.moduleImports.get(imp.module) === imp) {
        if (!this.rs.moduleSym(imp.module, u) && !(u.moduleSym && imp.module === u.name)) {
          // a local module's IMPORT names identifiers of the enclosing scope, not modules
          const scope = this.rs.scopeAt(u, imp.moduleStart);
          if (!imp.from && scope.kind === 'module') continue;
          out.push({ range: rangeOf(u, imp.moduleStart, imp.moduleEnd), message: `Module '${imp.module}' not found (no ${imp.module}.def on the search path).`, severity: DiagnosticSeverity.Warning, source: 'modula2' });
        }
      }
    }
    for (const inact of u.inactive) {
      out.push({ range: rangeOf(u, inact.start, inact.end), message: 'Inactive conditional compilation branch.', severity: DiagnosticSeverity.Hint, tags: [DiagnosticTag.Unnecessary], source: 'modula2' });
    }
    if (unresolvedSeverity !== 'off') {
      const sev = { hint: DiagnosticSeverity.Hint, information: DiagnosticSeverity.Information, warning: DiagnosticSeverity.Warning, error: DiagnosticSeverity.Error }[unresolvedSeverity];
      for (const r of u.refs) {
        if (r.decl || this.rs.resolveRef(r)) continue;
        if (r.importOf) {
          const mod = this.rs.moduleSym(r.importOf.module, u);
          if (!mod || r.start === r.importOf.moduleStart) continue; // reported above
          out.push({ range: rangeOf(u, r.start, r.end), message: `'${r.name}' is not exported by module '${r.importOf.module}'.`, severity: DiagnosticSeverity.Error, source: 'modula2' });
          continue;
        }
        if (r.base) {
          // only report member access on modules; field types behind generics are not always knowable
          const b = this.rs.resolveRef(r.base.ref);
          if (b?.kind === 'module' && !r.base.ops.length && !b.instanceOf) {
            out.push({ range: rangeOf(u, r.start, r.end), message: `'${r.name}' is not exported by '${b.name}'.`, severity: sev, source: 'modula2' });
          }
          continue;
        }
        out.push({ range: rangeOf(u, r.start, r.end), message: `Undeclared identifier '${r.name}'.`, severity: sev, source: 'modula2' });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- call hierarchy
  enclosingProc(u: Unit, off: number): Sym | undefined {
    for (let s: Scope | undefined = this.rs.scopeAt(u, off); s; s = s.parent) if (s.kind === 'procedure' && s.owner) return s.owner;
    return undefined;
  }

  callItem(s: Sym): CallHierarchyItem | undefined {
    if (isBuiltin(s) || !s.unit.path) return undefined;
    const u = s.unit;
    return {
      name: s.name, kind: symbolKind(s), detail: `${s.container ? s.container.name + '.' : ''}${u.name}`,
      uri: u.uri, range: rangeOf(u, s.start, Math.max(s.end, s.nameEnd)), selectionRange: rangeOf(u, s.nameStart, s.nameEnd),
      data: { uri: u.uri, off: s.nameStart },
    };
  }

  symFromItem(item: CallHierarchyItem): Sym | undefined {
    const u = this.ws.unitForUri(item.uri);
    if (!u) return undefined;
    const off = offAt(u, item.selectionRange.start);
    return this.symAt(u, off)?.sym;
  }

  async incomingCalls(sym: Sym, cancelled: () => boolean): Promise<CallHierarchyIncomingCall[]> {
    const refs = await this.references(sym, false, cancelled);
    const groups = new Map<string, { from: CallHierarchyItem; ranges: Range[] }>();
    for (const { unit, ref } of refs) {
      const caller = this.enclosingProc(unit, ref.start) ?? unit.moduleSym;
      const item = caller && this.callItem(caller);
      if (!item) continue;
      const k = symKey(caller!);
      const g = groups.get(k) ?? { from: item, ranges: [] };
      g.ranges.push(rangeOf(unit, ref.start, ref.end));
      groups.set(k, g);
    }
    return [...groups.values()].map(g => ({ from: g.from, fromRanges: g.ranges }));
  }

  outgoingCalls(sym: Sym): CallHierarchyOutgoingCall[] {
    const u = sym.unit;
    const scope = sym.scope;
    if (!scope) return [];
    const groups = new Map<string, { to: CallHierarchyItem; ranges: Range[] }>();
    for (const r of u.refs) {
      if (r.start < scope.start || r.end > scope.end || r.decl) continue;
      // skip refs inside nested procedures
      if (this.enclosingProc(u, r.start) !== sym) continue;
      const s = this.rs.resolveRef(r);
      if (!s || s.kind !== 'procedure') continue;
      const item = this.callItem(s);
      if (!item) continue;
      const k = symKey(s);
      const g = groups.get(k) ?? { to: item, ranges: [] };
      g.ranges.push(rangeOf(u, r.start, r.end));
      groups.set(k, g);
    }
    return [...groups.values()].map(g => ({ to: g.to, fromRanges: g.ranges }));
  }
}

// ---------------------------------------------------------------- workspace symbol index

export interface IndexedSymbol { name: string; lower: string; kind: SymbolKind; container?: string; uri: string; range: Range }

export class SymbolIndex {
  private byFile = new Map<string, IndexedSymbol[]>();
  building = false;
  constructor(private ws: Workspace) {}

  indexUnit(u: Unit) {
    const list: IndexedSymbol[] = [];
    const visit = (s: Sym, container?: string, depth = 0) => {
      if (s.kind === 'param' || (s.kind === 'var' && s.container?.kind === 'procedure')) return;
      list.push({ name: s.name, lower: s.name.toLowerCase(), kind: symbolKind(s), container: container ?? u.name, uri: u.uri, range: rangeOf(u, s.nameStart, s.nameEnd) });
      if (depth < 4) for (const c of s.children ?? []) visit(c, s.name, depth + 1);
    };
    if (u.moduleSym) list.push({ name: u.name, lower: u.name.toLowerCase(), kind: SymbolKind.Module, uri: u.uri, range: rangeOf(u, u.moduleSym.nameStart, u.moduleSym.nameEnd), container: u.kind === 'definition' ? 'DEF' : 'MOD' });
    for (const s of u.symbols) visit(s);
    this.byFile.set(u.path.toLowerCase(), list);
  }

  remove(p: string) { this.byFile.delete(p.toLowerCase()); }

  async build(files: string[], cancelled: () => boolean, progress: (done: number, total: number) => void) {
    this.building = true;
    let i = 0;
    for (const f of files) {
      if (cancelled()) break;
      if (!this.byFile.has(f.toLowerCase())) {
        const u = this.ws.unit(f);
        if (u) this.indexUnit(u);
      }
      if (++i % 25 === 0) { progress(i, files.length); await new Promise(r => setImmediate(r)); }
    }
    this.building = false;
  }

  query(q: string, limit = 500): SymbolInformation[] {
    const lq = q.toLowerCase();
    const scored: { s: IndexedSymbol; score: number }[] = [];
    for (const list of this.byFile.values()) {
      for (const s of list) {
        let score: number;
        if (!lq) score = 3;
        else if (s.lower === lq) score = 0;
        else if (s.lower.startsWith(lq)) score = 1;
        else if (s.lower.includes(lq)) score = 2;
        else if (fuzzy(s.lower, lq)) score = 3;
        else continue;
        scored.push({ s, score });
      }
    }
    scored.sort((a, b) => a.score - b.score || a.s.name.length - b.s.name.length);
    return scored.slice(0, limit).map(({ s }) => ({ name: s.name, kind: s.kind, containerName: s.container, location: { uri: s.uri, range: s.range } }));
  }
}

function fuzzy(text: string, q: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < q.length; i++) if (text[i] === q[j]) j++;
  return j === q.length;
}

// ---------------------------------------------------------------- ADW compiler output (*.err)

const ERR_LINE = /^(.*?)\((\d+)\)\((\d+)\)\s*:\s*(\w+)\s*:\s*(.*)$/;

export function parseErrFile(errPath: string): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  let text: string;
  try { text = fs.readFileSync(errPath, 'latin1'); } catch { return out; }
  let errTime = 0;
  try { errTime = fs.statSync(errPath).mtimeMs; } catch { /* ignore */ }
  const dir = path.dirname(errPath);
  for (const line of text.split(/\r?\n/)) {
    const m = ERR_LINE.exec(line.trim());
    if (!m) continue;
    const file = path.resolve(dir, m[1]);
    // ignore results older than the source
    try { if (fs.statSync(file).mtimeMs > errTime + 1000) continue; } catch { continue; }
    const l = Math.max(0, Number(m[2]) - 1), c = Math.max(0, Number(m[3]) - 1);
    const kind = m[4].toLowerCase();
    const sev = kind.startsWith('warn') ? DiagnosticSeverity.Warning : kind.startsWith('info') || kind.startsWith('note') ? DiagnosticSeverity.Information : DiagnosticSeverity.Error;
    const uri = URI.file(file).toString();
    const list = out.get(uri) ?? [];
    list.push({ range: { start: { line: l, character: c }, end: { line: l, character: c + 1 } }, message: m[5].replace(/^(Warning|Error)\s*--\s*/, '').trim(), severity: sev, source: 'ADW m2e' });
    out.set(uri, list);
  }
  return out;
}
