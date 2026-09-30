// Name resolution: scopes, imports, DEF/MOD pairing, classes, records and designators.

import { builtinUnit, isSystemModule, systemMember, systemModule } from './builtins';
import { Op, Ref, Scope, Sym, TypeNode, Unit } from './model';
import { Workspace } from './workspace';

const MAX_DEPTH = 24;

export const symKey = (s: Sym) => `${s.unit.uri}#${s.nameStart}#${s.name}`;

export class Resolver {
  private cache = new WeakMap<Ref, { gen: number; sym: Sym | null }>();
  constructor(public ws: Workspace) {}

  // ---------------------------------------------------------------- modules
  moduleSym(name: string, from: Unit): Sym | undefined {
    const sys = systemModule(name);
    if (sys) return sys;
    const u = this.ws.interfaceUnit(name, from.path);
    if (u?.moduleSym) return u.moduleSym;
    const m = this.ws.implementationUnit(name, from.path);
    return m?.moduleSym;
  }

  /** exported member of a module symbol (compilation unit, local module or generic instance) */
  moduleMember(mod: Sym, name: string, depth = 0): Sym | undefined {
    if (depth > MAX_DEPTH) return undefined;
    if (isSystemModule(mod)) return systemMember(mod, name);
    if (mod.instanceOf) {
      const g = this.genericOf(mod, depth + 1);
      return g && this.moduleMember(g, name, depth + 1);
    }
    const scope = mod.scope;
    if (!scope) return undefined;
    const s = scope.syms.get(name);
    if (s) return s;
    if (mod === mod.unit.moduleSym) {
      // constants of an enumeration re-declared by alias (T = Other.T) are reachable as M.c
      const e = this.aliasedEnumMember(scope, name, depth + 1);
      if (e) return e;
      // names exported from a DEF also include re-exports of local modules and wildcard imports are not exported
      const r = scope.reexports.get(name);
      if (r) return this.moduleMember(r, name, depth + 1);
      return undefined;
    }
    // local module: its own imports may be exported
    return this.lookupInScope(scope, name, scope.end, depth + 1, false);
  }

  /** the generic module a `MODULE X = G(...)` instance refers to */
  genericOf(mod: Sym, depth = 0): Sym | undefined {
    const t = mod.instanceOf;
    if (!t || t.k !== 'named') return undefined;
    const g = mod === mod.unit.moduleSym ? undefined : this.resolveTypeName(t, depth + 1);
    if (g?.kind === 'module') return g;
    return this.moduleSym(t.names[t.names.length - 1], mod.unit);
  }

  // ---------------------------------------------------------------- scopes
  /** unqualified lookup starting at `scope` */
  lookup(name: string, scope: Scope, offset: number, depth = 0): Sym | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const r = this.lookupInScope(s, name, offset, depth, true);
      if (r) return r;
    }
    return builtinUnit.scope.syms.get(name);
  }

  private lookupInScope(s: Scope, name: string, offset: number, depth: number, withFrames: boolean): Sym | undefined {
    if (depth > MAX_DEPTH) return undefined;
    if (withFrames && s.withs.length) {
      let best: { start: number; end: number; ref: Ref } | undefined;
      for (const w of s.withs) if (w.start <= offset && offset <= w.end && (!best || w.start > best.start)) best = w;
      // nested WITHs: try innermost first, then the outer ones
      if (best) {
        const frames = s.withs.filter(w => w.start <= offset && offset <= w.end).sort((a, b) => b.start - a.start);
        for (const w of frames) {
          const f = this.fieldOfValue(this.resolveRef(w.ref, depth + 1), w.ops, name, depth + 1);
          if (f) return f;
        }
      }
    }
    const own = s.syms.get(name);
    if (own) return own;
    if (s.kind === 'class' && s.owner) {
      const m = this.classMember(s.owner, name, depth + 1);
      if (m) return m;
    }
    const fi = s.fromImports.get(name);
    if (fi) {
      const mod = this.moduleSym(fi.decl.module, s.unit);
      if (mod) {
        const m = this.moduleMember(mod, name, depth + 1);
        if (m) return m;
      }
    }
    const mi = s.moduleImports.get(name);
    if (mi) {
      // in a local module, IMPORT x imports x from the enclosing scope
      const mod = s.kind === 'module' && s.parent ? this.lookup(name, s.parent, s.start, depth + 1) : this.moduleSym(name, s.unit);
      if (mod) return mod;
    }
    const re = s.reexports.get(name);
    if (re) {
      const m = this.moduleMember(re, name, depth + 1);
      if (m) return m;
    }
    for (const w of s.wildcardImports) {
      const mod = this.moduleSym(w.module, s.unit);
      const m = mod && this.moduleMember(mod, name, depth + 1);
      if (m) return m;
    }
    if (s.kind === 'unit' || s.kind === 'module') {
      // enumeration constants of imported enumeration types are imported with the type
      const e = this.importedEnumMember(s, name, depth + 1) ?? this.aliasedEnumMember(s, name, depth + 1);
      if (e) return e;
    }
    if (s.kind === 'unit' && s.unit.kind === 'implementation') {
      const def = this.ws.interfaceUnit(s.unit.name, s.unit.path);
      if (def && def !== s.unit) {
        const d = this.lookupInScope(def.scope, name, 0, depth + 1, false);
        if (d) return d;
      }
    }
    return undefined;
  }

  private aliasCache = new WeakMap<Scope, { gen: number; map: Map<string, Sym> }>();
  private aliasedEnumMember(s: Scope, name: string, depth: number): Sym | undefined {
    let c = this.aliasCache.get(s);
    if (!c || c.gen !== this.ws.generation) {
      const map = new Map<string, Sym>();
      this.aliasCache.set(s, (c = { gen: this.ws.generation, map }));
      for (const t of s.syms.values()) {
        if (t.kind !== 'type' || t.type?.k !== 'named') continue;
        const rt = this.resolveType(t.type, depth);
        if (rt?.k === 'enum') for (const m of rt.members) if (!map.has(m.name)) map.set(m.name, m);
      }
    }
    return c.map.get(name);
  }

  private enumCache = new WeakMap<Scope, { gen: number; map: Map<string, Sym> }>();
  private importedEnumMember(s: Scope, name: string, depth: number): Sym | undefined {
    if (!s.fromImports.size) return undefined;
    let c = this.enumCache.get(s);
    if (!c || c.gen !== this.ws.generation) {
      const map = new Map<string, Sym>();
      this.enumCache.set(s, (c = { gen: this.ws.generation, map }));
      for (const [n, imp] of s.fromImports) {
        const mod = this.moduleSym(imp.decl.module, s.unit);
        const t = mod && this.moduleMember(mod, n, depth);
        if (t?.kind === 'type') {
          const rt = this.resolveType(t.type, depth);
          if (rt?.k === 'enum') for (const m of rt.members) if (!map.has(m.name)) map.set(m.name, m);
        }
      }
    }
    return c.map.get(name);
  }

  // ---------------------------------------------------------------- classes
  /** the same class in the counterpart unit (DEF <-> MOD) */
  classVariants(cls: Sym): Sym[] {
    const out = [cls];
    const other = this.ws.counterpart(cls.unit);
    if (other) {
      const c = other.scope.syms.get(cls.name) ?? this.findClassDeep(other, cls.name);
      if (c && c.kind === 'class' && c !== cls && !c.forward) out.push(c);
    }
    return out;
  }
  private findClassDeep(u: Unit, name: string): Sym | undefined {
    const visit = (list: Sym[] | undefined): Sym | undefined => {
      for (const s of list ?? []) {
        if (s.kind === 'class' && s.name === name && !s.forward) return s;
        if (s.kind === 'module') { const r = visit(s.children); if (r) return r; }
      }
      return undefined;
    };
    return visit(u.symbols);
  }

  baseClass(cls: Sym, depth = 0): Sym | undefined {
    for (const v of this.classVariants(cls)) {
      if (v.inherit) {
        const b = this.resolveTypeName(v.inherit, depth + 1);
        if (b?.kind === 'class') return b;
        if (b?.kind === 'type') {
          const t = this.resolveType(b.type, depth + 1);
          if (t?.k === 'class') return t.sym;
        }
      }
    }
    return undefined;
  }

  classMember(cls: Sym, name: string, depth = 0): Sym | undefined {
    const seen = new Set<Sym>();
    for (let c: Sym | undefined = cls; c && !seen.has(c) && depth < MAX_DEPTH; c = this.baseClass(c, ++depth)) {
      seen.add(c);
      for (const v of this.classVariants(c)) {
        const m = v.scope?.syms.get(name);
        if (m) return m;
      }
    }
    return undefined;
  }

  classMembers(cls: Sym): Sym[] {
    const out = new Map<string, Sym>();
    const seen = new Set<Sym>();
    let depth = 0;
    for (let c: Sym | undefined = cls; c && !seen.has(c) && depth < MAX_DEPTH; c = this.baseClass(c, ++depth)) {
      seen.add(c);
      for (const v of this.classVariants(c)) for (const [n, m] of v.scope?.syms ?? []) if (!out.has(n)) out.set(n, m);
    }
    return [...out.values()];
  }

  enclosingClass(scope: Scope): Sym | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) if (s.kind === 'class' && s.owner) return s.owner;
    return undefined;
  }

  // ---------------------------------------------------------------- types
  resolveTypeName(t: TypeNode, depth = 0): Sym | undefined {
    if (t.k !== 'named' || depth > MAX_DEPTH) return undefined;
    let s = this.lookup(t.names[0], t.scope, t.start, depth + 1);
    for (let i = 1; s && i < t.names.length; i++) s = this.member(s, [], t.names[i], depth + 1);
    return s;
  }

  /** structural type (follows named types and aliases) */
  resolveType(t: TypeNode | undefined, depth = 0): TypeNode | undefined {
    for (let d = depth; t && d < MAX_DEPTH; d++) {
      if (t.k === 'subrange') {
        if (t.base) { t = t.base; continue; }
        const lo = t.low && this.resolveRef(t.low, d + 1);
        if (lo?.kind === 'enumMember' && lo.type) { t = lo.type; continue; }
        return t;
      }
      if (t.k !== 'named') return t;
      const s = this.resolveTypeName(t, d + 1);
      if (!s) return undefined;
      if (s.kind === 'class') return { k: 'class', sym: s };
      if (s.kind !== 'type') return undefined;
      if (!s.type) {
        // opaque type in a DEF: look for the full declaration in the implementation module
        if (s.unit.kind === 'definition') {
          const impl = this.ws.counterpart(s.unit);
          const full = impl?.scope.syms.get(s.name);
          if (full?.kind === 'type' && full.type) { t = full.type; continue; }
        }
        return undefined;
      }
      t = s.type;
    }
    return undefined;
  }

  /** the type sym a type node names, for "go to type definition" */
  typeSymOf(sym: Sym): Sym | undefined {
    let t: TypeNode | undefined = sym.kind === 'procedure' ? sym.ret : sym.type;
    for (let d = 0; t && d < MAX_DEPTH; d++) {
      if (t.k === 'named') return this.resolveTypeName(t);
      if (t.k === 'pointer') t = t.to;
      else if (t.k === 'array') t = t.of;
      else if (t.k === 'class') return t.sym;
      else return undefined;
    }
    return undefined;
  }

  /** type of a value designated by `sym` after applying ops */
  valueType(sym: Sym, ops: Op[], depth = 0): TypeNode | undefined {
    let t: TypeNode | undefined;
    let i = 0;
    switch (sym.kind) {
      case 'var': case 'field': case 'param': case 'const': case 'enumMember':
        t = sym.type;
        if (sym.name === 'SELF' && sym.unit === builtinUnit) return undefined;
        break;
      case 'procedure':
        if (sym.instanceOf) { const target = this.resolveTypeName(sym.instanceOf, depth + 1); return target ? this.valueType(target, ops, depth + 1) : undefined; }
        t = sym.ret;
        if (ops[0] === '()') i = 1;
        break;
      case 'type': case 'class':
        // type conversion T(x)
        t = sym.kind === 'class' ? { k: 'class', sym } : sym.type;
        if (ops[0] === '()') i = 1;
        break;
      default:
        return undefined;
    }
    for (; i < ops.length; i++) {
      const r = this.resolveType(t, depth + 1);
      if (!r) return undefined;
      const op = ops[i];
      if (op === '^') t = r.k === 'pointer' ? r.to : r;
      else if (op === '[]') {
        if (r.k === 'array') t = r.of;
        else if (r.k === 'pointer') { const p = this.resolveType(r.to, depth + 1); t = p?.k === 'array' ? p.of : undefined; }
        else return undefined;
      } else if (op === '()') t = r.k === 'proc' ? r.ret : undefined;
    }
    return t;
  }

  /** record / class members reachable from a type, auto-dereferencing pointers */
  containerOf(t: TypeNode | undefined, depth = 0): { k: 'record'; fields: Map<string, Sym>; list: Sym[] } | { k: 'class'; sym: Sym } | undefined {
    let r = this.resolveType(t, depth);
    for (let d = 0; r && r.k === 'pointer' && d < 8; d++) r = this.resolveType(r.to, depth + 1);
    if (r?.k === 'record' || r?.k === 'class') return r;
    return undefined;
  }

  private fieldOfValue(base: Sym | undefined, ops: Op[], name: string, depth: number): Sym | undefined {
    if (!base) return undefined;
    const c = this.containerOf(this.valueType(base, ops, depth), depth);
    if (!c) return undefined;
    return c.k === 'record' ? c.fields.get(name) : this.classMember(c.sym, name, depth);
  }

  /** `base<ops>.name` */
  member(base: Sym, ops: Op[], name: string, depth = 0): Sym | undefined {
    if (depth > MAX_DEPTH) return undefined;
    if (base.kind === 'module' && !ops.length) return this.moduleMember(base, name, depth + 1);
    if ((base.kind === 'class') && !ops.length) return this.classMember(base, name, depth + 1);
    if (base.kind === 'type' && !ops.length) {
      const r = this.resolveType(base.type, depth + 1);
      if (r?.k === 'enum') return r.members.find(m => m.name === name);
      if (r?.k === 'class') return this.classMember(r.sym, name, depth + 1);
      if (r?.k === 'record') return r.fields.get(name); // e.g. OFFS(T.field)
      return undefined;
    }
    return this.fieldOfValue(base, ops, name, depth + 1);
  }

  // ---------------------------------------------------------------- refs
  resolveRef(ref: Ref, depth = 0): Sym | undefined {
    if (ref.decl) return ref.decl;
    const c = this.cache.get(ref);
    if (c && c.gen === this.ws.generation) return c.sym ?? undefined;
    if (depth > MAX_DEPTH) return undefined;
    let sym: Sym | undefined;
    const unit = ref.scope.unit;
    if (ref.importOf) {
      const d = ref.importOf;
      if (!d.from && ref.scope.kind === 'module' && ref.scope.parent) {
        sym = this.lookup(ref.name, ref.scope.parent, ref.start, depth + 1);
      } else {
        const mod = this.moduleSym(d.module, unit);
        if (ref.start === d.moduleStart) sym = mod;
        else sym = mod && this.moduleMember(mod, ref.name, depth + 1);
      }
    } else if (!ref.base) {
      if (ref.name === 'SELF') {
        const cls = this.enclosingClass(ref.scope);
        sym = cls ?? builtinUnit.scope.syms.get('SELF');
      } else {
        sym = this.lookup(ref.name, ref.scope, ref.start, depth + 1);
        // arguments of a unit-level generic instantiation name modules without importing them
        if (!sym && unit.moduleSym?.instanceOf && ref.scope === unit.scope) sym = this.moduleSym(ref.name, unit);
      }
    } else {
      const b = ref.base.ref;
      if (b.name === 'SELF' && !b.base && !ref.base.ops.length) {
        const cls = this.enclosingClass(b.scope);
        sym = cls && this.classMember(cls, ref.name, depth + 1);
      } else {
        const bs = this.resolveRef(b, depth + 1);
        if (bs) {
          // a class used as a value inside its own methods (SELF) or a class-typed value
          sym = this.member(bs, ref.base.ops, ref.name, depth + 1);
          if (!sym && bs.kind === 'class' && ref.base.ops.length) sym = this.classMember(bs, ref.name, depth + 1);
        }
      }
    }
    this.cache.set(ref, { gen: this.ws.generation, sym: sym ?? null });
    return sym;
  }

  /** ref or declaration at an offset */
  refAt(unit: Unit, offset: number): Ref | undefined {
    const refs = unit.refs;
    let lo = 0, hi = refs.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const r = refs[m];
      if (offset < r.start) hi = m - 1;
      else if (offset > r.end) lo = m + 1;
      else return r;
    }
    return undefined;
  }

  scopeAt(unit: Unit, offset: number): Scope {
    let s = unit.scope;
    for (;;) {
      const c = s.children.find(ch => ch.start <= offset && offset <= ch.end);
      if (!c) return s;
      s = c;
    }
  }

  /** all names visible at a scope (for completion) */
  visible(scope: Scope, offset: number): Sym[] {
    const out = new Map<string, Sym>();
    const add = (s: Sym) => { if (!out.has(s.name)) out.set(s.name, s); };
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      for (const w of s.withs) {
        if (w.start <= offset && offset <= w.end) {
          const b = this.resolveRef(w.ref);
          const c = b && this.containerOf(this.valueType(b, w.ops));
          if (c?.k === 'record') c.list.forEach(add);
          else if (c?.k === 'class') this.classMembers(c.sym).forEach(add);
        }
      }
      s.syms.forEach(add);
      if (s.kind === 'class' && s.owner) this.classMembers(s.owner).forEach(add);
      for (const [n, imp] of s.fromImports) {
        const mod = this.moduleSym(imp.decl.module, s.unit);
        const m = mod && this.moduleMember(mod, n);
        if (m) {
          add(m);
          const r = m.kind === 'type' ? this.resolveType(m.type) : undefined;
          if (r?.k === 'enum') r.members.forEach(add);
        }
      }
      for (const [n] of s.moduleImports) { const m = s.kind === 'module' && s.parent ? this.lookup(n, s.parent, s.start) : this.moduleSym(n, s.unit); if (m) add(m); }
      for (const w of s.wildcardImports) { const m = this.moduleSym(w.module, s.unit); m?.scope?.syms.forEach(add); }
      if (s.kind === 'unit' && s.unit.kind === 'implementation') {
        const def = this.ws.interfaceUnit(s.unit.name, s.unit.path);
        if (def && def !== s.unit) def.scope.syms.forEach(add);
      }
    }
    builtinUnit.scope.syms.forEach(add);
    return [...out.values()];
  }

  /** members of `base<ops>.` (for completion) */
  membersOf(base: Sym, ops: Op[]): Sym[] {
    if (base.kind === 'module' && !ops.length) {
      if (base.instanceOf) { const g = this.genericOf(base); return g ? this.membersOf(g, []) : []; }
      if (isSystemModule(base)) return [...base.unit.scope.syms.values()];
      return [...(base.scope?.syms.values() ?? [])].filter(s => base === base.unit.moduleSym || !base.exports || base.exports.includes(s.name));
    }
    if (base.kind === 'class' && !ops.length) return this.classMembers(base);
    if (base.kind === 'type' && !ops.length) {
      const r = this.resolveType(base.type);
      if (r?.k === 'enum') return r.members;
      if (r?.k === 'class') return this.classMembers(r.sym);
      if (r?.k === 'record') return r.list;
      return [];
    }
    const c = this.containerOf(this.valueType(base, ops));
    if (!c) return [];
    return c.k === 'record' ? c.list : this.classMembers(c.sym);
  }

  /** DEF heading <-> MOD body of the same procedure / class / type */
  counterpartSym(sym: Sym): Sym | undefined {
    const other = this.ws.counterpart(sym.unit);
    if (!other) return undefined;
    // path of names from the unit down to the symbol (e.g. class.method)
    const chain: string[] = [];
    for (let s: Sym | undefined = sym; s && s !== sym.unit.moduleSym; s = s.container) chain.unshift(s.name);
    if (sym === sym.unit.moduleSym) return other.moduleSym;
    let list: Sym[] | undefined = other.symbols;
    let found: Sym | undefined;
    for (const n of chain) {
      found = list?.find(s => s.name === n && s.kind !== 'enumMember');
      if (!found) return undefined;
      list = found.children;
    }
    return found;
  }
}
