// Module file index and parsed-unit cache.

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { Defines } from './lexer';
import { Unit } from './model';
import { parse } from './parser';

export interface Settings {
  searchPaths: string[];
  adwPath: string;
  exclude: string[];
  defines: Record<string, boolean>;
  cacheSize: number;
}

export const defaultSettings: Settings = {
  searchPaths: [],
  adwPath: 'C:\\Program Files (x86)\\ADW Software Modula-2',
  exclude: ['**/.svn/**', '**/node_modules/**', '**/.git/**'],
  defines: {},
  cacheSize: 400,
};

export const norm = (p: string) => path.resolve(p).toLowerCase();

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

interface CacheEntry { unit: Unit; mtime: number }

export class Workspace {
  roots: string[] = [];
  settings: Settings = defaultSettings;
  defines: Defines = new Map();
  /** lower-case module name -> file paths */
  defs = new Map<string, string[]>();
  mods = new Map<string, string[]>();
  files = new Set<string>(); // normalized paths of all indexed files
  filePaths = new Map<string, string>(); // normalized -> real path
  private open = new Map<string, { text: string; version: number; uri: string }>();
  private cache = new Map<string, CacheEntry>();
  private excludes: RegExp[] = [];
  /** bumped whenever any unit changes; invalidates resolution caches */
  generation = 0;

  configure(roots: string[], settings: Partial<Settings>) {
    this.roots = roots;
    const given = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null));
    this.settings = { ...defaultSettings, ...given };
    // compiler-predefined target symbols, overridable through modula2.defines
    this.defines = new Map(Object.entries({ AMD64: true, IA32: false, ...(this.settings.defines ?? {}) }));
    this.excludes = this.settings.exclude.map(globToRegExp);
    this.cache.clear();
    this.generation++;
    this.scan();
  }

  libraryRoots(): string[] {
    const out: string[] = [];
    const adw = this.settings.adwPath;
    if (adw && fs.existsSync(adw)) {
      for (const e of fs.readdirSync(adw, { withFileTypes: true })) {
        if (e.isDirectory() && /def$/i.test(e.name)) out.push(path.join(adw, e.name));
      }
    }
    return out;
  }

  isLibrary(p: string): boolean {
    const n = norm(p);
    return !this.roots.some(r => n.startsWith(norm(r) + path.sep) || n === norm(r));
  }

  private excluded(p: string): boolean {
    const s = p.replace(/\\/g, '/');
    return this.excludes.some(r => r.test(s));
  }

  scan() {
    this.defs.clear();
    this.mods.clear();
    this.files.clear();
    this.filePaths.clear();
    const all = [...this.roots, ...this.settings.searchPaths, ...this.libraryRoots()];
    const seen = new Set<string>();
    for (const r of all) this.walk(r, seen, 0);
  }

  private walk(dir: string, seen: Set<string>, depth: number) {
    const key = norm(dir);
    if (seen.has(key) || depth > 25) return;
    seen.add(key);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!this.excluded(p + '/')) this.walk(p, seen, depth + 1);
      } else if (/\.(def|mod)$/i.test(e.name) && !this.excluded(p)) {
        this.addFile(p);
      }
    }
  }

  addFile(p: string) {
    const n = norm(p);
    if (this.files.has(n)) return;
    this.files.add(n);
    this.filePaths.set(n, p);
    const ext = path.extname(p).toLowerCase();
    const name = path.basename(p, path.extname(p)).toLowerCase();
    const map = ext === '.def' ? this.defs : this.mods;
    const list = map.get(name) ?? [];
    list.push(p);
    map.set(name, list);
  }

  removeFile(p: string) {
    const n = norm(p);
    if (!this.files.delete(n)) return;
    this.filePaths.delete(n);
    const ext = path.extname(p).toLowerCase();
    const name = path.basename(p, path.extname(p)).toLowerCase();
    const map = ext === '.def' ? this.defs : this.mods;
    const list = (map.get(name) ?? []).filter(x => norm(x) !== n);
    if (list.length) map.set(name, list);
    else map.delete(name);
    this.invalidate(p);
  }

  invalidate(p: string) {
    this.cache.delete(norm(p));
    this.generation++;
  }

  // ---------------------------------------------------------------- documents
  setOpen(uri: string, text: string, version: number) {
    const p = URI.parse(uri).fsPath;
    this.open.set(norm(p), { text, version, uri });
    if (/\.(def|mod)$/i.test(p)) this.addFile(p);
    this.generation++;
  }
  close(uri: string) {
    const p = URI.parse(uri).fsPath;
    this.open.delete(norm(p));
    this.cache.delete(norm(p));
    this.generation++;
  }
  isOpen(p: string) { return this.open.has(norm(p)); }

  readText(p: string): string | undefined {
    const o = this.open.get(norm(p));
    if (o) return o.text;
    try {
      const buf = fs.readFileSync(p);
      // UTF-8 with BOM is decoded as UTF-8 so offsets match the editor; everything else is ANSI
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1);
      return buf.toString('latin1');
    } catch {
      return undefined;
    }
  }

  unitForUri(uri: string): Unit | undefined {
    return this.unit(URI.parse(uri).fsPath);
  }

  unit(p: string): Unit | undefined {
    const n = norm(p);
    const o = this.open.get(n);
    const hit = this.cache.get(n);
    if (o) {
      if (hit && hit.mtime === -o.version) return this.touch(n, hit).unit;
      const unit = parse(o.text, o.uri, p, this.defines, o.version);
      this.put(n, { unit, mtime: -o.version });
      return unit;
    }
    // disk files are invalidated through file-watcher events (invalidate / removeFile)
    if (hit && hit.mtime >= 0) return this.touch(n, hit).unit;
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch { return undefined; }
    const text = this.readText(p);
    if (text === undefined) return undefined;
    const unit = parse(text, URI.file(this.filePaths.get(n) ?? p).toString(), this.filePaths.get(n) ?? p, this.defines);
    unit.tokens = []; // keep memory down for files not open in the editor
    this.put(n, { unit, mtime });
    if (hit) this.generation++;
    return unit;
  }

  private touch(n: string, e: CacheEntry) {
    this.cache.delete(n);
    this.cache.set(n, e);
    return e;
  }
  private put(n: string, e: CacheEntry) {
    this.cache.delete(n);
    this.cache.set(n, e);
    const max = Math.max(50, this.settings.cacheSize);
    if (this.cache.size > max) {
      for (const k of this.cache.keys()) {
        if (this.cache.size <= max) break;
        if (!this.open.has(k)) this.cache.delete(k);
      }
    }
  }

  // ---------------------------------------------------------------- module lookup
  private best(cands: string[] | undefined, from?: string): string | undefined {
    if (!cands || !cands.length) return undefined;
    if (cands.length === 1 || !from) return cands[0];
    const f = norm(from);
    let best = cands[0], score = -1;
    for (const c of cands) {
      const n = norm(c);
      let i = 0;
      while (i < n.length && i < f.length && n[i] === f[i]) i++;
      // prefer workspace files over library files on ties
      const s = i * 2 + (this.isLibrary(c) ? 0 : 1);
      if (s > score) { score = s; best = c; }
    }
    return best;
  }
  defPath(module: string, from?: string) { return this.best(this.defs.get(module.toLowerCase()), from); }
  modPath(module: string, from?: string) { return this.best(this.mods.get(module.toLowerCase()), from); }

  /** the unit that defines the interface of `module` (DEF, or the program module when there is none) */
  interfaceUnit(module: string, from?: string): Unit | undefined {
    const d = this.defPath(module, from);
    if (d) return this.unit(d);
    return undefined;
  }
  implementationUnit(module: string, from?: string): Unit | undefined {
    const m = this.modPath(module, from);
    return m ? this.unit(m) : undefined;
  }
  counterpart(u: Unit): Unit | undefined {
    if (!u.name) return undefined;
    if (u.kind === 'definition') return this.implementationUnit(u.name, u.path);
    if (u.kind === 'implementation') return this.interfaceUnit(u.name, u.path);
    return undefined;
  }
  counterpartPath(p: string): string | undefined {
    const name = path.basename(p, path.extname(p));
    return /\.def$/i.test(p) ? this.modPath(name, p) : this.defPath(name, p);
  }

  allFiles(): string[] {
    return [...this.filePaths.values()];
  }
  workspaceFiles(): string[] {
    return this.allFiles().filter(p => !this.isLibrary(p));
  }
}
