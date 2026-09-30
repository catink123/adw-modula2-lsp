// Symbol, scope and type model produced by the parser and consumed by the resolver.

import type { Comment, Range0, Token } from './lexer';

export type SymKind =
  | 'module'      // compilation unit, local module, generic instance
  | 'const'
  | 'type'
  | 'class'
  | 'var'
  | 'field'
  | 'param'
  | 'procedure'
  | 'enumMember'
  | 'genericParam';

export type TypeNode =
  | { k: 'named'; names: string[]; scope: Scope; start: number; end: number }
  | { k: 'record'; fields: Map<string, Sym>; list: Sym[] }
  | { k: 'pointer'; to: TypeNode }
  | { k: 'array'; of: TypeNode; open: boolean }
  | { k: 'set'; of?: TypeNode }
  | { k: 'enum'; members: Sym[] }
  | { k: 'subrange'; base?: TypeNode; low?: Ref }
  | { k: 'proc'; ret?: TypeNode; params: string[] }
  | { k: 'class'; sym: Sym }
  | { k: 'builtin'; name: string };

export interface Sym {
  name: string;
  kind: SymKind;
  unit: Unit;
  start: number;       // whole declaration
  end: number;
  nameStart: number;
  nameEnd: number;
  detail: string;      // one-line signature
  doc?: string;
  type?: TypeNode;     // declared type (var/field/param/type/const-with-type)
  ret?: TypeNode;      // procedure return type
  params?: Sym[];      // procedure parameters
  children?: Sym[];    // outline children
  scope?: Scope;       // procedures, classes, modules
  container?: Sym;
  varParam?: boolean;
  readonly?: boolean;
  override?: boolean;
  abstract?: boolean;
  forward?: boolean;
  hasBody?: boolean;
  inherit?: TypeNode;  // class base
  instanceOf?: TypeNode; // MODULE X = Generic(...)
  exportQualified?: boolean;
  exports?: string[];  // local module EXPORT list
}

export interface WithFrame {
  start: number;
  end: number;
  ref: Ref;   // last identifier of the WITH designator
  ops: Op[];  // selectors applied after it, e.g. WITH a[i]^ DO
}

export class Scope {
  syms = new Map<string, Sym>();
  children: Scope[] = [];
  /** FROM M IMPORT x  → x -> {module M, name x} */
  fromImports = new Map<string, ImportName>();
  /** IMPORT M → M */
  moduleImports = new Map<string, ImportDecl>();
  withs: WithFrame[] = [];
  /** FROM M IMPORT * */
  wildcardImports: ImportDecl[] = [];
  /** names exported unqualified by a local module / generic instance declared here */
  reexports = new Map<string, Sym>();
  constructor(
    public kind: 'unit' | 'procedure' | 'class' | 'module' | 'guard',
    public unit: Unit,
    public parent: Scope | undefined,
    public start: number,
    public end: number,
    public owner?: Sym,
  ) {
    if (parent) parent.children.push(this);
  }
  add(sym: Sym) {
    const old = this.syms.get(sym.name);
    // a full declaration replaces a FORWARD one
    if (!old || (old.forward && !sym.forward)) this.syms.set(sym.name, sym);
  }
}

export interface ImportName {
  name: string;
  start: number;
  end: number;
  decl: ImportDecl;
}

export interface ImportDecl {
  module: string;
  moduleStart: number;
  moduleEnd: number;
  from: boolean;      // FROM M IMPORT ...
  wildcard?: boolean; // FROM M IMPORT *
  names: ImportName[];
  start: number;
  end: number;
}

export type Op = '^' | '[]' | '()';

/** One identifier occurrence. Qualified accesses chain through `base`. */
export interface Ref {
  name: string;
  start: number;
  end: number;
  scope: Scope;
  base?: { ref: Ref; ops: Op[] };
  /** set when this identifier is the name of a declaration */
  decl?: Sym;
  /** identifier is inside an import list or module header */
  importOf?: ImportDecl;
}

export interface Fold {
  start: number;
  end: number;
  kind?: 'comment' | 'region' | 'imports';
}

export interface Diag {
  start: number;
  end: number;
  message: string;
  severity: 1 | 2 | 3 | 4;
}

export interface Unit {
  uri: string;
  path: string;
  kind: 'definition' | 'implementation' | 'program' | 'unknown';
  generic: boolean;
  name: string;
  moduleSym?: Sym;
  text: string;
  tokens: Token[];
  comments: Comment[];
  inactive: Range0[];
  pragmas: Range0[];
  scope: Scope;
  symbols: Sym[];       // top-level outline
  refs: Ref[];          // sorted by start
  imports: ImportDecl[];
  folds: Fold[];
  diags: Diag[];
  version: number;
}
