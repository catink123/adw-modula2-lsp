// Tolerant recursive-descent parser for ADW Modula-2 (PIM/ISO + ISO OO classes + generics).
//
// Declarations are parsed fully (they feed the outline, scopes and hovers).
// Statement bodies are scanned at token level: block keywords are matched to
// find END, and every designator (a.b[i]^.c(x)) is recorded as a chain of Refs
// that the resolver can follow through modules, records and classes.

import { Defines, lex, T, Token } from './lexer';
import { Diag, Fold, ImportDecl, Op, Ref, Scope, Sym, SymKind, TypeNode, Unit, WithFrame } from './model';

interface Ctx {
  inDef: boolean;
  cls?: Sym;          // enclosing class
  container?: Sym;
}

const DECL_SYNC = new Set([
  'CONST', 'TYPE', 'VAR', 'PROCEDURE', 'BEGIN', 'END', 'CLASS', 'MODULE', 'OVERRIDE', 'ABSTRACT',
  'EXCEPT', 'FINALLY', 'INHERIT', 'REVEAL', 'TRACED', 'UNTRACED', 'FROM', 'IMPORT', 'EXPORT',
]);
const STMT_BLOCK = new Set(['IF', 'CASE', 'WHILE', 'FOR', 'LOOP', 'WITH', 'GUARD', 'ASM', 'RECORD']);
const NOT_IN_EXPR = new Set(['END', 'BEGIN', 'PROCEDURE', 'CONST', 'TYPE', 'VAR', 'THEN', 'DO', 'ELSE', 'ELSIF', 'UNTIL', 'EXCEPT', 'FINALLY', 'MODULE', 'CLASS']);

export function parse(text: string, uri: string, path: string, defines: Defines, version = 0): Unit {
  const lx = lex(text, defines);
  const unit: Unit = {
    uri, path, kind: 'unknown', generic: false, name: '', text,
    tokens: lx.tokens, comments: lx.comments, inactive: lx.inactive, pragmas: lx.pragmas,
    scope: undefined as unknown as Scope, symbols: [], refs: [], imports: [], folds: [], diags: [], version,
  };
  unit.scope = new Scope('unit', unit, undefined, 0, text.length);
  for (const e of lx.errors) unit.diags.push({ ...e, severity: 1 });
  new Parser(unit).parseUnit();
  unit.refs.sort((a, b) => a.start - b.start);
  attachDocs(unit);
  buildFolds(unit);
  return unit;
}

class Parser {
  toks: Token[];
  p = 0;
  constructor(private u: Unit) {
    this.toks = u.tokens;
  }

  // ---------------------------------------------------------------- helpers
  get cur(): Token { return this.toks[this.p]; }
  la(k: number): Token { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  kw(s: string, t = this.cur) { return t.t === T.Keyword && t.s === s; }
  op(s: string, t = this.cur) { return t.t === T.Op && t.s === s; }
  isId(t = this.cur) { return t.t === T.Ident; }
  eof() { return this.cur.t === T.EOF; }
  isAssert() { return this.cur.s === 'ASSERT' && this.op('(', this.la(1)); }
  prevEnd() { return this.p > 0 ? this.toks[this.p - 1].end : 0; }

  err(message: string, t = this.cur, severity: 1 | 2 = 1) {
    const d = this.u.diags;
    // avoid cascades at the same place
    if (d.length && d[d.length - 1].start === t.start) return;
    d.push({ start: t.start, end: Math.max(t.end, t.start + 1), message, severity });
  }
  expectOp(s: string): boolean {
    if (this.op(s)) { this.p++; return true; }
    this.err(`'${s}' expected`, this.cur.t === T.EOF ? this.toks[Math.max(0, this.p - 1)] : this.cur);
    return false;
  }
  expectKw(s: string): boolean {
    if (this.kw(s)) { this.p++; return true; }
    this.err(`${s} expected`);
    return false;
  }
  ident(): Token | undefined {
    if (this.isId()) return this.toks[this.p++];
    this.err('Identifier expected');
    return undefined;
  }
  /** skip a balanced bracket group starting at current '(' '[' or '{' */
  skipGroup() {
    const open = this.cur.s;
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    while (!this.eof()) {
      const t = this.cur;
      if (t.t === T.Op && t.s === open) depth++;
      else if (t.t === T.Op && t.s === close) { depth--; if (depth === 0) { this.p++; return; } }
      this.p++;
    }
  }
  syncDecl() {
    const start = this.p;
    while (!this.eof() && !(this.cur.t === T.Keyword && DECL_SYNC.has(this.cur.s))) this.p++;
    if (this.p === start && !this.eof()) this.p++;
  }
  text(i: number, j: number): string {
    // human-readable token text for tokens [i, j)
    let out = '';
    for (let k = i; k < j; k++) {
      const t = this.toks[k];
      const prev = k > i ? this.toks[k - 1] : undefined;
      if (prev) {
        const noSpaceBefore = t.t === T.Op && (/^([,;)\]^.}]|\.\.)$/.test(t.s) || ((t.s === '(' || t.s === '[' || t.s === '{') && prev.t === T.Ident));
        const noSpaceAfter = prev.t === T.Op && /^([(\[.{^]|\.\.)$/.test(prev.s);
        const colon = (t.t === T.Op && t.s === ':') || (prev.t === T.Op && prev.s === ':');
        if (colon || (!noSpaceBefore && !noSpaceAfter)) out += ' ';
        else if (t.t === T.Op && t.s === '(' && prev.t === T.Keyword) out += ' ';
      }
      out += t.s;
    }
    return out;
  }

  newSym(kind: SymKind, nameTok: Token, start: number, container?: Sym): Sym {
    return {
      name: nameTok.s, kind, unit: this.u, start, end: nameTok.end,
      nameStart: nameTok.start, nameEnd: nameTok.end, detail: nameTok.s, container,
    };
  }
  declRef(sym: Sym, tok: Token, scope: Scope) {
    this.u.refs.push({ name: tok.s, start: tok.start, end: tok.end, scope, decl: sym });
  }
  mkRef(tok: Token, scope: Scope, base?: { ref: Ref; ops: Op[] }): Ref {
    const r: Ref = { name: tok.s, start: tok.start, end: tok.end, scope, base };
    this.u.refs.push(r);
    return r;
  }

  // ---------------------------------------------------------------- unit
  parseUnit() {
    const u = this.u;
    const scope = u.scope;
    const start = this.cur.start;
    while (this.kw('UNSAFEGUARDED') || this.kw('GENERIC')) {
      if (this.kw('GENERIC')) u.generic = true;
      this.p++;
    }
    if (this.kw('DEFINITION')) { u.kind = 'definition'; this.p++; }
    else if (this.kw('IMPLEMENTATION')) { u.kind = 'implementation'; this.p++; }
    else u.kind = 'program';
    if (!this.expectKw('MODULE')) { u.kind = 'unknown'; return; }
    const nameTok = this.ident();
    if (!nameTok) return;
    u.name = nameTok.s;
    const msym = this.newSym('module', nameTok, start);
    msym.scope = scope;
    msym.children = u.symbols;
    scope.owner = msym;
    u.moduleSym = msym;
    this.declRef(msym, nameTok, scope);
    if (this.op('(')) this.genericParams(scope, u.symbols);
    if (this.op('[')) this.skipGroup();
    if (this.op('=')) {
      // generic instantiation as a compilation unit
      this.p++;
      msym.instanceOf = this.parseType(scope, msym);
      if (this.op('(')) this.scanGroup(scope);
    }
    this.expectOp(';');
    const kindWord = u.kind === 'definition' ? 'DEFINITION MODULE' : u.kind === 'implementation' ? 'IMPLEMENTATION MODULE' : 'MODULE';
    msym.detail = `${u.generic ? 'GENERIC ' : ''}${kindWord} ${u.name}`;
    this.imports(scope);
    const ctx: Ctx = { inDef: u.kind === 'definition', container: undefined };
    this.block(scope, u.symbols, msym, ctx);
    if (this.op('.')) this.p++;
    else if (!this.eof()) this.err(`'.' expected after END ${u.name}`, this.toks[Math.max(0, this.p - 1)]);
    msym.end = this.prevEnd();
  }

  genericParams(scope: Scope, out: Sym[]) {
    this.p++; // (
    while (!this.eof() && !this.op(')')) {
      const names: Token[] = [];
      while (this.isId()) { names.push(this.cur); this.p++; if (this.op(',')) this.p++; else break; }
      if (!names.length) { this.p++; continue; }
      let type: TypeNode | undefined;
      let isType = false;
      if (this.op(':')) {
        this.p++;
        if (this.kw('TYPE')) { isType = true; this.p++; }
        else type = this.parseType(scope);
      }
      for (const n of names) {
        const s = this.newSym('genericParam', n, n.start);
        s.type = type;
        s.detail = `${n.s} : ${isType ? 'TYPE' : '…'}`;
        if (isType) s.kind = 'type';
        scope.add(s);
        out.push(s);
        this.declRef(s, n, scope);
      }
      if (this.op(';')) this.p++;
    }
    if (this.op(')')) this.p++;
  }

  imports(scope: Scope) {
    for (;;) {
      if (this.kw('IMPORT')) {
        const start = this.cur.start;
        this.p++;
        while (this.isId()) {
          const t = this.cur;
          this.p++;
          const d: ImportDecl = { module: t.s, moduleStart: t.start, moduleEnd: t.end, from: false, names: [], start, end: t.end };
          this.u.imports.push(d);
          scope.moduleImports.set(t.s, d);
          this.u.refs.push({ name: t.s, start: t.start, end: t.end, scope, importOf: d });
          if (this.op(',')) this.p++;
          else break;
        }
        this.expectOp(';');
      } else if (this.kw('FROM')) {
        const start = this.cur.start;
        this.p++;
        const m = this.ident();
        if (!m) { this.syncDecl(); continue; }
        const d: ImportDecl = { module: m.s, moduleStart: m.start, moduleEnd: m.end, from: true, names: [], start, end: m.end };
        this.u.imports.push(d);
        this.u.refs.push({ name: m.s, start: m.start, end: m.end, scope, importOf: d });
        this.expectKw('IMPORT');
        if (this.op('*')) { d.wildcard = true; this.p++; scope.wildcardImports.push(d); }
        while (this.isId()) {
          const t = this.cur;
          this.p++;
          const n = { name: t.s, start: t.start, end: t.end, decl: d };
          d.names.push(n);
          if (!scope.fromImports.has(t.s)) scope.fromImports.set(t.s, n);
          this.u.refs.push({ name: t.s, start: t.start, end: t.end, scope, importOf: d });
          if (this.op(',')) this.p++;
          else break;
        }
        d.end = this.cur.end;
        this.expectOp(';');
      } else break;
    }
  }

  // ---------------------------------------------------------------- blocks
  /** Declarations [BEGIN stmts] [EXCEPT stmts] [FINALLY stmts] END [name] */
  block(scope: Scope, out: Sym[], owner: Sym, ctx: Ctx) {
    this.declarations(scope, out, ctx);
    if (this.kw('ASM')) { // PUREASM / ASSEMBLER procedure body
      while (!this.eof() && !this.kw('END')) this.p++;
    }
    if (this.kw('BEGIN') || this.kw('EXCEPT') || this.kw('FINALLY')) {
      this.p++;
      this.statements(scope);
    }
    if (this.kw('END')) {
      this.p++;
      if (this.isId()) {
        const t = this.cur;
        this.p++;
        if (t.s !== owner.name) this.err(`END ${t.s} does not match '${owner.name}'`, t);
        else this.declRef(owner, t, scope.parent ?? scope);
      }
    } else {
      this.err(`END ${owner.name} expected`);
    }
  }

  declarations(scope: Scope, out: Sym[], ctx: Ctx) {
    for (;;) {
      const t = this.cur;
      if (t.t === T.EOF) return;
      if (t.t === T.Keyword) {
        switch (t.s) {
          case 'CONST':
            this.p++;
            while (this.isId() && !this.isAssert()) this.constDecl(scope, out, ctx);
            continue;
          case 'TYPE':
            this.p++;
            while (this.isId() && !this.isAssert()) this.typeDecl(scope, out, ctx);
            continue;
          case 'VAR':
            this.p++;
            while (this.isId() && !this.isAssert()) this.varDecl(scope, out, ctx);
            continue;
          case 'PROCEDURE':
            this.procDecl(scope, out, ctx, t.start, false, false);
            continue;
          case 'OVERRIDE':
          case 'ABSTRACT':
          case 'TRACED':
          case 'UNTRACED': {
            let override = false, abstract = false;
            const start = t.start;
            while (this.kw('OVERRIDE') || this.kw('ABSTRACT') || this.kw('TRACED') || this.kw('UNTRACED')) {
              if (this.kw('OVERRIDE')) override = true;
              if (this.kw('ABSTRACT')) abstract = true;
              this.p++;
            }
            if (this.kw('PROCEDURE')) this.procDecl(scope, out, ctx, start, override, abstract);
            else if (this.kw('CLASS')) this.classDecl(scope, out, ctx, start, abstract);
            else { this.err('PROCEDURE or CLASS expected'); this.syncDecl(); }
            continue;
          }
          case 'CLASS':
            this.classDecl(scope, out, ctx, t.start, false);
            continue;
          case 'MODULE':
            this.localModule(scope, out, ctx);
            continue;
          case 'INHERIT':
            this.p++;
            if (ctx.cls) ctx.cls.inherit = this.parseType(scope);
            else this.parseType(scope);
            this.expectOp(';');
            continue;
          case 'REVEAL':
            this.p++;
            while (!this.eof() && !this.op(';')) {
              if (this.isId()) this.mkRef(this.cur, scope);
              else if (!(this.kw('READONLY') || this.op(','))) break;
              this.p++;
            }
            this.expectOp(';');
            continue;
          case 'EXPORT':
            // ADW: EXPORT list in an implementation module (DLL exports)
            this.p++;
            if (this.kw('QUALIFIED')) this.p++;
            while (this.isId() || this.op(',')) { if (this.isId()) this.mkRef(this.cur, scope); this.p++; }
            this.expectOp(';');
            continue;
          case 'FROM':
          case 'IMPORT':
            this.err('Imports must precede declarations', t, 2);
            this.imports(scope);
            continue;
          case 'BEGIN':
          case 'END':
          case 'EXCEPT':
          case 'FINALLY':
          case 'ASM':
            return;
        }
      }
      if (this.op(';')) { this.p++; continue; }
      if (t.t === T.Ident && t.s === 'ASSERT' && this.op('(', this.la(1))) {
        // ADW compile-time assertion
        this.p++;
        this.scanGroup(scope);
        this.expectOp(';');
        continue;
      }
      this.err(`Unexpected '${t.s}' in declarations`);
      this.syncDecl();
    }
  }

  constDecl(scope: Scope, out: Sym[], ctx: Ctx) {
    const n = this.cur;
    this.p++;
    const s = this.newSym('const', n, n.start, ctx.cls ?? ctx.container);
    this.declRef(s, n, scope);
    let typed = '';
    if (this.op(':')) { // ADW typed constant
      this.p++;
      const tf = this.p;
      s.type = this.parseType(scope);
      typed = ` : ${this.text(tf, this.p)}`;
    }
    if (!this.expectOp('=')) { this.syncDecl(); return; }
    const from = this.p;
    // typed set/record constructor: T{...}
    if (this.isId() && !s.type) {
      let k = this.p;
      while (this.toks[k].t === T.Ident && this.op('.', this.toks[k + 1]) && this.toks[k + 2].t === T.Ident) k += 2;
      if (this.op('{', this.toks[k + 1])) {
        const names: string[] = [];
        for (let q = this.p; q <= k; q += 2) names.push(this.toks[q].s);
        s.type = { k: 'named', names, scope, start: this.cur.start, end: this.toks[k].end };
      }
    }
    this.scanExprUntil(scope, ';');
    const val = this.text(from, this.p);
    s.detail = `${n.s}${typed} = ${val.length > 200 ? val.slice(0, 200) + ' …' : val}`;
    this.expectOp(';');
    s.end = this.prevEnd();
    scope.add(s);
    out.push(s);
  }

  typeDecl(scope: Scope, out: Sym[], ctx: Ctx) {
    const n = this.cur;
    this.p++;
    const s = this.newSym('type', n, n.start, ctx.cls ?? ctx.container);
    this.declRef(s, n, scope);
    scope.add(s);
    out.push(s);
    if (this.op('=')) {
      this.p++;
      const from = this.p;
      s.type = this.parseType(scope, s);
      const body = this.text(from, this.p);
      s.detail = `${n.s} = ${body.length > 200 ? body.slice(0, 200) + ' …' : body}`;
    } else {
      s.detail = `${n.s} (opaque)`;
    }
    this.expectOp(';');
    s.end = this.prevEnd();
  }

  identList(): Token[] {
    const names: Token[] = [];
    while (this.isId()) {
      names.push(this.cur);
      this.p++;
      if (this.op('[')) this.skipGroup(); // absolute address / external name
      if (this.op(',')) this.p++;
      else break;
    }
    return names;
  }

  varDecl(scope: Scope, out: Sym[], ctx: Ctx) {
    const start = this.cur.start;
    const names = this.identList();
    if (!this.expectOp(':')) { this.syncVar(); return; }
    const from = this.p;
    const type = this.parseType(scope);
    const tt = this.text(from, this.p);
    if (this.op('=')) { this.p++; this.scanExprUntil(scope, ';'); } // ADW initialized variable
    const kind: SymKind = ctx.cls ? 'field' : 'var';
    for (const n of names) {
      const s = this.newSym(kind, n, names.length === 1 ? start : n.start, ctx.cls ?? ctx.container);
      s.type = type;
      s.detail = `${n.s} : ${tt}`;
      this.declRef(s, n, scope);
      scope.add(s);
      out.push(s);
    }
    this.expectOp(';');
    const end = this.prevEnd();
    for (const s of out.slice(out.length - names.length)) s.end = end;
  }
  syncVar() {
    while (!this.eof() && !this.op(';') && !(this.cur.t === T.Keyword && DECL_SYNC.has(this.cur.s))) this.p++;
    if (this.op(';')) this.p++;
  }

  // ---------------------------------------------------------------- types
  qualident(scope: Scope): TypeNode | undefined {
    if (!this.isId()) return undefined;
    const first = this.cur;
    const names = [first.s];
    let r = this.mkRef(first, scope);
    this.p++;
    while (this.op('.') && this.la(1).t === T.Ident) {
      const t = this.la(1);
      r = this.mkRef(t, scope, { ref: r, ops: [] });
      names.push(t.s);
      this.p += 2;
    }
    return { k: 'named', names, scope, start: first.start, end: this.prevEnd() };
  }

  parseType(scope: Scope, owner?: Sym): TypeNode {
    const t = this.cur;
    if (t.t === T.Ident) {
      const q = this.qualident(scope)!;
      if (this.op('[')) { this.p++; this.scanGroupBody(scope, ']'); return { k: 'subrange', base: q }; }
      return q;
    }
    if (t.t === T.Op && t.s === '(') {
      // enumeration
      this.p++;
      const members: Sym[] = [];
      while (this.isId()) {
        const n = this.cur;
        this.p++;
        const m = this.newSym('enumMember', n, n.start, owner);
        m.detail = owner ? `${n.s} (${owner.name})` : n.s;
        this.declRef(m, n, scope);
        members.push(m);
        scope.add(m);
        if (this.op('=')) { this.p++; this.scanExprUntil(scope, ',', ')'); } // explicit values (ADW)
        if (this.op(',')) this.p++;
        else break;
      }
      this.expectOp(')');
      if (this.isId() && /^(BIG|SMALL|NORMAL)$/.test(this.cur.s)) this.p++; // ADW enumeration size
      const en: TypeNode = { k: 'enum', members };
      for (const m of members) m.type = owner ? { k: 'named', names: [owner.name], scope, start: owner.nameStart, end: owner.nameEnd } : en;
      if (owner) owner.children = members;
      return en;
    }
    if (t.t === T.Op && t.s === '[') {
      this.p++;
      const first = this.u.refs.length;
      this.scanGroupBody(scope, ']');
      // [lo..hi]: the bound's type gives the base type (enumeration subranges)
      const low = this.u.refs[first];
      return { k: 'subrange', low: low && !low.base ? low : undefined };
    }
    if (t.t === T.Keyword) {
      switch (t.s) {
        case 'ARRAY': {
          this.p++;
          let open = false;
          if (this.kw('OF')) open = true;
          else {
            while (!this.eof() && !this.kw('OF')) {
              if (this.op(',')) { this.p++; continue; }
              const before = this.p;
              this.parseType(scope);
              if (this.p === before) break;
            }
          }
          this.expectKw('OF');
          return { k: 'array', of: this.parseType(scope), open };
        }
        case 'RECORD': {
          this.p++;
          const fields = new Map<string, Sym>();
          const list: Sym[] = [];
          this.fieldListSeq(scope, fields, list, owner);
          this.expectKw('END');
          if (owner) owner.children = list;
          return { k: 'record', fields, list };
        }
        case 'SET':
        case 'PACKEDSET':
          this.p++;
          this.expectKw('OF');
          return { k: 'set', of: this.parseType(scope) };
        case 'POINTER':
          this.p++;
          this.expectKw('TO');
          return { k: 'pointer', to: this.parseType(scope) };
        case 'PROCEDURE': {
          this.p++;
          const params: string[] = [];
          if (this.op('(')) {
            this.p++;
            while (!this.eof() && !this.op(')')) {
              const from = this.p;
              if (this.kw('VAR') || this.kw('CONST')) this.p++;
              // ISO allows named formal parameters in procedure types
              if (this.isId() && (this.op(':', this.la(1)) || this.op(',', this.la(1)) && this.op(':', this.la(3)))) {
                this.identList();
                this.expectOp(':');
              }
              const before = this.p;
              this.parseType(scope);
              params.push(this.text(from, this.p));
              if (this.op(',') || this.op(';')) this.p++;
              else if (this.p === before) break;
            }
            this.expectOp(')');
          }
          let ret: TypeNode | undefined;
          if (this.op(':')) { this.p++; ret = this.qualident(scope); }
          if (this.op('[')) this.skipGroup(); // calling convention [WINDOWS]
          return { k: 'proc', ret, params };
        }
      }
    }
    this.err('Type expected');
    return { k: 'subrange' };
  }

  fieldListSeq(scope: Scope, fields: Map<string, Sym>, list: Sym[], owner?: Sym) {
    for (;;) {
      if (this.isId() && this.cur.s === 'BITFIELDS' && this.la(1).t === T.Ident) {
        this.p++;
        this.fieldListSeq(scope, fields, list, owner);
        this.expectKw('END');
      } else if (this.isId()) {
        const start = this.cur.start;
        const names = this.identList();
        if (!this.expectOp(':')) { this.syncField(); continue; }
        const from = this.p;
        const type = this.parseType(scope);
        const tt = this.text(from, this.p);
        if (this.kw('BY')) { this.p++; this.scanExprUntil(scope, ';'); } // bit field width
        for (const n of names) {
          const s = this.newSym('field', n, names.length === 1 ? start : n.start, owner);
          s.type = type;
          s.detail = `${n.s} : ${tt}`;
          s.end = this.prevEnd();
          this.declRef(s, n, scope);
          if (!fields.has(n.s)) fields.set(n.s, s);
          list.push(s);
        }
      } else if (this.kw('CASE')) {
        this.p++;
        // CASE [tag] : T OF | CASE tag : T OF | CASE T OF
        if (this.isId() && this.op(':', this.la(1))) {
          const n = this.cur;
          this.p += 2;
          const s = this.newSym('field', n, n.start, owner);
          s.type = this.parseType(scope);
          s.detail = `${n.s} : ${s.type.k === 'named' ? s.type.names.join('.') : '…'}`;
          s.end = this.prevEnd();
          this.declRef(s, n, scope);
          fields.set(n.s, s);
          list.push(s);
        } else {
          if (this.op(':')) this.p++;
          this.parseType(scope);
        }
        this.expectKw('OF');
        while (!this.eof() && !this.kw('END')) {
          if (this.op('|') || this.op('!')) { this.p++; continue; }
          if (this.kw('ELSE')) { this.p++; this.fieldListSeq(scope, fields, list, owner); continue; }
          // case labels
          this.scanExprUntil(scope, ':');
          if (!this.expectOp(':')) break;
          this.fieldListSeq(scope, fields, list, owner);
        }
        this.expectKw('END');
      }
      if (this.op(';')) { this.p++; continue; }
      if (this.kw('END') || this.op('|') || this.op('!') || this.kw('ELSE') || this.eof()) return;
      this.err(`Unexpected '${this.cur.s}' in record`);
      this.syncField();
      if (this.kw('END') || this.eof()) return;
    }
  }
  syncField() {
    while (!this.eof() && !this.op(';') && !this.kw('END')) this.p++;
  }

  // ---------------------------------------------------------------- procedures, classes, modules
  procDecl(scope: Scope, out: Sym[], ctx: Ctx, start: number, override: boolean, abstract: boolean) {
    const headFrom = this.p;
    this.p++; // PROCEDURE
    const n = this.ident();
    if (!n) { this.syncDecl(); return; }
    if (this.op('[')) this.skipGroup(); // external name
    const s = this.newSym('procedure', n, start, ctx.cls ?? ctx.container);
    if (this.op('=')) {
      // ADW procedure alias: PROCEDURE A = B;
      this.p++;
      const from = this.p;
      s.instanceOf = this.parseType(scope);
      s.detail = `PROCEDURE ${n.s} = ${this.text(from, this.p)}`;
      this.expectOp(';');
      s.end = this.prevEnd();
      this.declRef(s, n, scope);
      scope.add(s);
      out.push(s);
      return;
    }
    s.override = override;
    s.abstract = abstract;
    const ps = new Scope('procedure', this.u, scope, start, start, s);
    s.scope = ps;
    s.params = [];
    s.children = [];
    this.declRef(s, n, scope);
    scope.add(s);
    out.push(s);
    if (this.op('(')) {
      this.p++;
      while (!this.eof() && !this.op(')')) {
        let isVar = false;
        if (this.kw('VAR') || this.kw('CONST')) { isVar = this.cur.s === 'VAR'; this.p++; }
        // ADW parameter modes: VAR INOUT x, VAR OUT x, VAR IN x
        if ((this.cur.s === 'INOUT' || this.cur.s === 'OUT' || this.cur.s === 'IN') && this.la(1).t === T.Ident) this.p++;
        const names = this.identList();
        if (!names.length) { this.err('Parameter expected'); while (!this.eof() && !this.op(')') && !this.op(';')) this.p++; if (this.op(';')) this.p++; continue; }
        if (!this.expectOp(':')) { while (!this.eof() && !this.op(')') && !this.op(';')) this.p++; if (this.op(';')) this.p++; continue; }
        const from = this.p;
        if (this.cur.s === 'VALUE' && this.la(1).t === T.Ident) this.p++; // ADW by-value for large types
        if (this.cur.s === 'NOHIGH' && this.kw('ARRAY', this.la(1))) this.p++;
        const type = this.parseType(ps);
        const tt = this.text(from, this.p);
        for (const pn of names) {
          const q = this.newSym('param', pn, pn.start, s);
          q.type = type;
          q.varParam = isVar;
          q.detail = `${isVar ? 'VAR ' : ''}${pn.s} : ${tt}`;
          q.end = this.prevEnd();
          this.declRef(q, pn, ps);
          ps.add(q);
          s.params.push(q);
        }
        if (this.op(';')) this.p++;
        else if (!this.op(')')) { this.err("';' or ')' expected"); while (!this.eof() && !this.op(')') && !this.op(';')) this.p++; if (this.op(';')) this.p++; }
      }
      this.expectOp(')');
      if (this.op(':')) { this.p++; s.ret = this.qualident(scope); }
    }
    if (this.op('[')) this.skipGroup(); // attributes, e.g. [Cdecl]
    const headEnd = this.p;
    const prefix = `${abstract ? 'ABSTRACT ' : ''}${override ? 'OVERRIDE ' : ''}`;
    s.detail = prefix + this.text(headFrom, headEnd);
    this.expectOp(';');
    s.end = this.prevEnd();
    ps.end = s.end;
    if (this.kw('FORWARD')) {
      this.p++;
      s.forward = true;
      this.expectOp(';');
      return;
    }
    let macro = false;
    // ADW procedure directives
    while (this.isId() && /^(MACRO|PUREASM|ASSEMBLER)$/.test(this.cur.s) && this.op(';', this.la(1))) {
      if (this.cur.s === 'MACRO') macro = true;
      s.detail += '; ' + this.cur.s;
      this.p += 2;
    }
    if ((ctx.inDef && !macro) || abstract) return;
    s.hasBody = true;
    this.block(ps, s.children, s, { inDef: false, cls: undefined, container: s });
    // fields of the enclosing class stay visible through scope chaining
    this.expectOp(';');
    s.end = this.prevEnd();
    ps.end = s.end;
  }

  classDecl(scope: Scope, out: Sym[], ctx: Ctx, start: number, abstract: boolean) {
    this.p++; // CLASS
    const n = this.ident();
    if (!n) { this.syncDecl(); return; }
    const s = this.newSym('class', n, start, ctx.container);
    s.abstract = abstract;
    s.children = [];
    s.type = { k: 'class', sym: s };
    const cs = new Scope('class', this.u, scope, start, start, s);
    s.scope = cs;
    this.declRef(s, n, scope);
    scope.add(s);
    out.push(s);
    if (this.kw('FORWARD')) { this.p++; this.expectOp(';'); s.forward = true; return; }
    this.expectOp(';');
    if (this.kw('FORWARD')) { this.p++; this.expectOp(';'); s.forward = true; return; }
    const inner: Ctx = { inDef: ctx.inDef, cls: s, container: s };
    this.block(cs, s.children, s, inner);
    this.expectOp(';');
    s.end = this.prevEnd();
    cs.end = s.end;
    s.detail = `${abstract ? 'ABSTRACT ' : ''}CLASS ${n.s}${s.inherit?.k === 'named' ? ` (INHERIT ${s.inherit.names.join('.')})` : ''}`;
  }

  localModule(scope: Scope, out: Sym[], ctx: Ctx) {
    const start = this.cur.start;
    this.p++; // MODULE
    const n = this.ident();
    if (!n) { this.syncDecl(); return; }
    const s = this.newSym('module', n, start, ctx.container);
    this.declRef(s, n, scope);
    scope.add(s);
    out.push(s);
    if (this.op('=')) {
      this.p++;
      const from = this.p;
      s.instanceOf = this.parseType(scope);
      if (this.op('(')) this.scanGroup(scope);
      s.detail = `MODULE ${n.s} = ${this.text(from, this.p)}`;
      this.expectOp(';');
      if (this.kw('EXPORT')) {
        while (this.kw('EXPORT')) this.exportList(s, scope);
        if (this.kw('END')) {
          this.p++;
          if (this.isId()) { if (this.cur.s === n.s) this.declRef(s, this.cur, scope); this.p++; }
          this.expectOp(';');
        }
      }
      s.end = this.prevEnd();
      return;
    }
    s.detail = `MODULE ${n.s}`;
    if (this.op('[')) this.skipGroup();
    this.expectOp(';');
    const ms = new Scope('module', this.u, scope, start, start, s);
    s.scope = ms;
    s.children = [];
    this.imports(ms);
    while (this.kw('EXPORT')) this.exportList(s, ms);
    this.imports(ms);
    while (this.kw('EXPORT')) this.exportList(s, ms);
    this.block(ms, s.children, s, { inDef: false, container: s });
    this.expectOp(';');
    s.end = this.prevEnd();
    ms.end = s.end;
    for (const [e, m] of scope.reexports) {
      if (m !== s) continue;
      const inner = ms.syms.get(e);
      if (inner) scope.add(inner);
    }
  }

  exportList(s: Sym, scope: Scope) {
    this.p++; // EXPORT
    let qualified = false;
    if (this.kw('QUALIFIED')) { qualified = true; s.exportQualified = true; this.p++; }
    s.exports ??= [];
    const names: string[] = [];
    while (this.isId()) {
      names.push(this.cur.s);
      if (s.scope) this.mkRef(this.cur, s.scope);
      this.p++;
      if (this.op(',')) this.p++;
      else break;
    }
    s.exports.push(...names);
    this.expectOp(';');
    // unqualified exports are visible in the enclosing scope (resolved lazily for instances and imports)
    const outer = s.scope?.parent ?? scope;
    if (!qualified) for (const e of names) outer.reexports.set(e, s);
  }

  // ---------------------------------------------------------------- expressions & statements
  /** Record designator chain starting at an identifier. Returns the last ref and the selectors after it. */
  designator(scope: Scope): { ref: Ref; ops: Op[] } {
    let last = this.mkRef(this.cur, scope);
    this.p++;
    let ops: Op[] = [];
    for (;;) {
      const t = this.cur;
      if (t.t !== T.Op) break;
      if (t.s === '.' && this.la(1).t === T.Ident) {
        last = this.mkRef(this.la(1), scope, { ref: last, ops });
        ops = [];
        this.p += 2;
      } else if (t.s === '^') { ops.push('^'); this.p++; }
      else if (t.s === '[') { this.p++; this.scanGroupBody(scope, ']'); ops.push('[]'); }
      else if (t.s === '(') { this.p++; this.scanGroupBody(scope, ')'); ops.push('()'); }
      else if (t.s === '{') { this.p++; this.scanGroupBody(scope, '}'); break; }
      else break;
    }
    return { ref: last, ops };
  }

  scanGroup(scope: Scope) {
    const open = this.cur.s;
    this.p++;
    this.scanGroupBody(scope, open === '(' ? ')' : open === '[' ? ']' : '}');
  }
  /** scan expression tokens up to and including `close` */
  scanGroupBody(scope: Scope, close: string) {
    while (!this.eof()) {
      const t = this.cur;
      if (t.t === T.Op) {
        if (t.s === close) { this.p++; return; }
        if (t.s === ';') return;
        if (t.s === '(' || t.s === '[' || t.s === '{') { this.scanGroup(scope); continue; }
        if (t.s === ')' || t.s === ']' || t.s === '}') return; // mismatched
        this.p++;
      } else if (t.t === T.Ident) {
        this.designator(scope);
      } else if (t.t === T.Keyword && NOT_IN_EXPR.has(t.s)) {
        return;
      } else this.p++;
    }
  }
  /** scan expression tokens until one of the stop ops at depth 0 (not consumed) */
  scanExprUntil(scope: Scope, ...stops: string[]) {
    while (!this.eof()) {
      const t = this.cur;
      if (t.t === T.Op) {
        if (stops.includes(t.s) || t.s === ';') return;
        if (t.s === '(' || t.s === '[' || t.s === '{') { this.scanGroup(scope); continue; }
        if (t.s === ')' || t.s === ']' || t.s === '}') return;
        this.p++;
      } else if (t.t === T.Ident) {
        this.designator(scope);
      } else if (t.t === T.Keyword && (NOT_IN_EXPR.has(t.s) || DECL_SYNC.has(t.s))) {
        return;
      } else this.p++;
    }
  }

  statements(scope: Scope) {
    interface Frame { kw: string; tok: Token; scope: Scope; with?: WithFrame }
    const stack: Frame[] = [];
    let cur = scope;
    const folds = this.u.folds;
    for (;;) {
      const t = this.cur;
      if (t.t === T.EOF) { this.err('END expected (unterminated block)', this.toks[Math.max(0, this.p - 1)]); return; }
      if (t.t === T.Ident) { this.designator(cur); continue; }
      if (t.t === T.Keyword) {
        const s = t.s;
        if (s === 'END') {
          const f = stack.pop();
          if (!f) return;
          this.p++;
          if (f.with) { f.with.end = t.start; scope.withs.push(f.with); }
          if (f.kw === 'GUARD') { cur.end = t.end; cur = f.scope; }
          folds.push({ start: f.tok.start, end: t.start });
          continue;
        }
        if (s === 'REPEAT') { stack.push({ kw: s, tok: t, scope: cur }); this.p++; continue; }
        if (s === 'UNTIL') {
          const f = stack[stack.length - 1];
          if (f && f.kw === 'REPEAT') { stack.pop(); folds.push({ start: f.tok.start, end: t.start }); }
          this.p++;
          continue;
        }
        if (s === 'ASM') {
          stack.push({ kw: s, tok: t, scope: cur });
          this.p++;
          while (!this.eof() && !this.kw('END')) this.p++;
          continue;
        }
        if (s === 'WITH') {
          this.p++;
          const d = this.isId() ? this.designator(cur) : undefined;
          const f: Frame = { kw: s, tok: t, scope: cur };
          if (d) f.with = { start: this.cur.start, end: this.cur.start, ref: d.ref, ops: d.ops };
          stack.push(f);
          continue;
        }
        if (s === 'GUARD') {
          this.p++;
          const f: Frame = { kw: s, tok: t, scope: cur };
          stack.push(f);
          cur = new Scope('guard', this.u, cur, t.start, t.end);
          if (this.isId()) this.designator(f.scope);
          continue;
        }
        if ((s === 'AS') && stack.length && stack[stack.length - 1].kw === 'GUARD') {
          this.p++;
          if (this.op('|')) this.p++;
          this.guardVar(cur);
          continue;
        }
        if (STMT_BLOCK.has(s)) { stack.push({ kw: s, tok: t, scope: cur }); this.p++; continue; }
        if (s === 'PROCEDURE' || s === 'CONST' || s === 'TYPE' || s === 'VAR' || s === 'BEGIN' || s === 'MODULE' || s === 'CLASS') {
          // a block END is missing somewhere; let the declaration parser recover
          this.err(`Unexpected ${s} in statements (missing END?)`, stack.length ? stack[stack.length - 1].tok : t);
          while (stack.length) { const f = stack.pop()!; if (f.kw === 'GUARD') cur = f.scope; }
          return;
        }
        this.p++;
        continue;
      }
      if (t.t === T.Op && t.s === '|' && stack.length && stack[stack.length - 1].kw === 'GUARD') {
        this.p++;
        this.guardVar(cur);
        continue;
      }
      if (t.t === T.Op && (t.s === '(' || t.s === '[' || t.s === '{')) { this.scanGroup(cur); continue; }
      this.p++;
    }
  }

  /** GUARD branch `v : T DO` declares v; `T DO` just references T */
  guardVar(scope: Scope) {
    if (this.isId() && this.op(':', this.la(1))) {
      const n = this.cur;
      this.p += 2;
      const s = this.newSym('var', n, n.start);
      s.type = this.qualident(scope);
      s.detail = `${n.s} : ${s.type && s.type.k === 'named' ? s.type.names.join('.') : '?'}`;
      s.end = this.prevEnd();
      this.declRef(s, n, scope);
      scope.add(s);
    }
  }
}

// ---------------------------------------------------------------- documentation comments

function lineOf(text: string, off: number, from = 0): number {
  let n = 0;
  for (let i = from; i < off; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function firstTokenAtOrAfter(tokens: Token[], off: number): number {
  let lo = 0, hi = tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < off) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function cleanComment(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.replace(/^\s*\*(?!\))\s?/, '').replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // de-indent
  const ind = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length));
  return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n');
}

function attachDocs(u: Unit) {
  const { comments, tokens, text } = u;
  if (!comments.length) return;
  const cstarts = comments.map(c => c.start);
  const commentAtOrAfter = (off: number) => {
    let lo = 0, hi = cstarts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cstarts[m] < off) lo = m + 1; else hi = m; }
    return lo;
  };
  const visit = (s: Sym) => {
    if (s.kind !== 'module' || s.container) {
      let doc: string | undefined;
      // 1. comment right after the declaration (same line, or following lines before next token)
      const ci = commentAtOrAfter(s.end);
      if (ci < comments.length) {
        const c = comments[ci];
        let ti = firstTokenAtOrAfter(tokens, s.end);
        if (tokens[ti].s === ';' && tokens[ti].t === T.Op) ti++; // comment after the terminating ';'
        const nt = tokens[ti];
        const sameLine = lineOf(text, c.start, s.end) === 0;
        const headerStyle = s.kind === 'procedure' || s.kind === 'class' || s.kind === 'module';
        if (c.start < nt.start && (sameLine || (headerStyle && lineOf(text, c.start, s.end) <= 1))) {
          // collect consecutive comments
          const parts = [c.text];
          for (let k = ci + 1; k < comments.length && comments[k].start < nt.start && lineOf(text, comments[k].start, comments[k - 1].end) <= 1; k++) parts.push(comments[k].text);
          doc = parts.map(cleanComment).join('\n');
        }
      }
      // 2. comment immediately before the declaration
      if (!doc) {
        const pi = commentAtOrAfter(s.start) - 1;
        if (pi >= 0) {
          const c = comments[pi];
          const ti = firstTokenAtOrAfter(tokens, c.end);
          if (tokens[ti].start >= s.start && lineOf(text, s.start, c.end) <= 2) {
            // skip file banner comments
            if (c.start > 0 || s.kind !== 'module') doc = cleanComment(c.text);
          }
        }
      }
      if (doc && doc.trim()) s.doc = doc;
    }
    if (s.params) s.params.forEach(visit);
    if (s.children) s.children.forEach(visit);
  };
  u.symbols.forEach(visit);
  if (u.moduleSym) {
    // module doc: first comment after the header, typical banner style
    const c = comments.find(c => c.start > u.moduleSym!.nameEnd);
    if (c && lineOf(text, c.start, u.moduleSym.nameEnd) <= 3) u.moduleSym.doc = cleanComment(c.text);
  }
}

function buildFolds(u: Unit) {
  const folds: Fold[] = u.folds;
  const visit = (s: Sym) => {
    if (s.kind === 'procedure' || s.kind === 'class' || s.kind === 'module' || (s.kind === 'type' && s.children?.length)) {
      if (s.end > s.start) folds.push({ start: s.start, end: s.end });
    }
    s.children?.forEach(visit);
  };
  u.symbols.forEach(visit);
  for (const c of u.comments) folds.push({ start: c.start, end: c.end, kind: 'comment' });
  for (const r of u.inactive) folds.push({ start: r.start, end: r.end, kind: 'region' });
  if (u.imports.length > 1) folds.push({ start: u.imports[0].start, end: u.imports[u.imports.length - 1].end, kind: 'imports' });
}

export type { Diag };
