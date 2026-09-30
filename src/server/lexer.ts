// Modula-2 lexer for the ADW (Stony Brook lineage) dialect.
//
// Handles nested (* *) comments, <* *> pragmas, ISO/ADW conditional compilation
// (<*IF c THEN*> ... <*ELSIF*> ... <*ELSE*> ... <*END*> and %IF c %THEN ... %END),
// strings, and PIM/ISO numeric literals (0FFH, 17B, 0C, 1.0E-3).
//
// Conditional compilation is evaluated against a set of defines. Tokens in
// inactive branches are not emitted; their ranges are recorded instead.

export const enum T {
  Ident,
  Keyword,
  Number,
  String,
  Op,
  EOF,
}

export interface Token {
  t: T;
  s: string; // text (for String: including quotes)
  start: number;
  end: number;
}

export interface Comment {
  start: number;
  end: number;
  text: string; // inner text without (* *)
}

export interface Range0 {
  start: number;
  end: number;
}

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
  inactive: Range0[]; // regions removed by conditional compilation
  pragmas: Range0[]; // all pragma / directive ranges (for highlighting)
  errors: { start: number; end: number; message: string }[];
}

export const KEYWORDS = new Set([
  // PIM / ISO
  'AND', 'ARRAY', 'BEGIN', 'BY', 'CASE', 'CONST', 'DEFINITION', 'DIV', 'DO', 'ELSE', 'ELSIF', 'END',
  'EXIT', 'EXPORT', 'FOR', 'FROM', 'IF', 'IMPLEMENTATION', 'IMPORT', 'IN', 'LOOP', 'MOD', 'MODULE',
  'NOT', 'OF', 'OR', 'POINTER', 'PROCEDURE', 'QUALIFIED', 'RECORD', 'REPEAT', 'RETURN', 'SET', 'THEN',
  'TO', 'TYPE', 'UNTIL', 'VAR', 'WHILE', 'WITH',
  // ISO additions
  'EXCEPT', 'FINALLY', 'FORWARD', 'PACKEDSET', 'REM', 'RETRY',
  // ISO OO / ADW extensions
  'ABSTRACT', 'AS', 'CLASS', 'GUARD', 'INHERIT', 'OVERRIDE', 'READONLY', 'REVEAL', 'TRACED', 'UNTRACED',
  'UNSAFEGUARDED', 'GENERIC', 'ASM',
  // ADW bitwise operators
  'BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR', 'SAR', 'ROL', 'ROR',
]);

export type Defines = Map<string, boolean>;

const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdChar = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHexDigit = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

interface CondFrame {
  parentActive: boolean;
  taken: boolean; // some branch already taken
  active: boolean;
  start: number; // start offset of current inactive region (if !active)
}

/** Evaluates a conditional-compilation expression: identifiers, TRUE/FALSE, NOT/AND/OR/~/&, parens, = / <>. */
export function evalCondition(text: string, defines: Defines): boolean {
  const toks = text.replace(/%/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*|<>|[()=#~&]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const orExpr = (): boolean => {
    let v = andExpr();
    while (peek() === 'OR') { i++; const r = andExpr(); v = v || r; }
    return v;
  };
  const andExpr = (): boolean => {
    let v = relExpr();
    while (peek() === 'AND' || peek() === '&') { i++; const r = relExpr(); v = v && r; }
    return v;
  };
  const relExpr = (): boolean => {
    const v = unary();
    if (peek() === '=' ) { i++; return v === unary(); }
    if (peek() === '<>' || peek() === '#') { i++; return v !== unary(); }
    return v;
  };
  const unary = (): boolean => {
    const t = toks[i++];
    if (t === undefined) return false;
    if (t === 'NOT' || t === '~') return !unary();
    if (t === '(') { const v = orExpr(); if (peek() === ')') i++; return v; }
    if (t === 'TRUE') return true;
    if (t === 'FALSE') return false;
    return defines.get(t) ?? defines.get(t.toUpperCase()) ?? false;
  };
  try { return orExpr(); } catch { return false; }
}

export function lex(src: string, defines: Defines = new Map()): LexResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const inactive: Range0[] = [];
  const pragmas: Range0[] = [];
  const errors: LexResult['errors'] = [];
  const conds: CondFrame[] = [];
  const localDefines = new Map(defines);
  let active = true;
  const n = src.length;
  let i = 0;
  // byte order mark, decoded either as UTF-8 (U+FEFF) or as Latin-1 (ï»¿)
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  else if (src.startsWith('ï»¿')) i = 3;

  const emit = (t: T, start: number, end: number) => {
    if (active) tokens.push({ t, s: src.slice(start, end), start, end });
  };

  const pushCond = (cond: boolean, at: number) => {
    const parentActive = active;
    const on = parentActive && cond;
    conds.push({ parentActive, taken: on, active: on, start: at });
    active = on;
  };
  const markInactiveEnd = (frame: CondFrame, at: number) => {
    if (!frame.active && frame.parentActive) inactive.push({ start: frame.start, end: at });
  };
  const elsif = (cond: boolean, start: number, end: number) => {
    const f = conds[conds.length - 1];
    if (!f) { errors.push({ start, end, message: 'ELSIF without IF' }); return; }
    markInactiveEnd(f, start);
    const on = f.parentActive && !f.taken && cond;
    if (on) f.taken = true;
    f.active = on;
    active = on;
    if (!on) f.start = end;
  };
  const elseBranch = (start: number, end: number) => {
    const f = conds[conds.length - 1];
    if (!f) { errors.push({ start, end, message: 'ELSE without IF' }); return; }
    markInactiveEnd(f, start);
    const on = f.parentActive && !f.taken;
    f.taken = true;
    f.active = on;
    active = on;
    if (!on) f.start = end;
  };
  const endCond = (start: number, end: number) => {
    const f = conds.pop();
    if (!f) { errors.push({ start, end, message: 'END without IF in conditional compilation' }); return; }
    markInactiveEnd(f, start);
    active = f.parentActive;
  };

  const handlePragma = (body: string, start: number, end: number) => {
    // body: text between <* and *>; may contain several /OPTIONS; directives start with a keyword
    const m = /^\s*([A-Za-z]+)\b([\s\S]*)$/.exec(body);
    if (!m) return;
    const kw = m[1].toUpperCase();
    const rest = m[2];
    switch (kw) {
      case 'IF': {
        const c = /^([\s\S]*?)\bTHEN\b/i.exec(rest);
        pushCond(evalCondition(c ? c[1] : rest, localDefines), end);
        if (!active) conds[conds.length - 1].start = end;
        break;
      }
      case 'ELSIF': {
        const c = /^([\s\S]*?)\bTHEN\b/i.exec(rest);
        elsif(evalCondition(c ? c[1] : rest, localDefines), start, end);
        break;
      }
      case 'ELSE': elseBranch(start, end); break;
      case 'END': endCond(start, end); break;
      case 'ENVIRON':
      case 'DEFINE':
      case 'ASSIGN': {
        if (!active) break;
        const d = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_]+)\s*\)/.exec(rest);
        if (d) {
          const name = d[1];
          const val = d[2].toUpperCase() === 'TRUE';
          if (kw !== 'ENVIRON' || !localDefines.has(name)) localDefines.set(name, val);
        }
        break;
      }
    }
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // whitespace
    if (c <= 32) { i++; continue; }
    // comment (* ... *) nested
    if (c === 40 /*(*/ && src.charCodeAt(i + 1) === 42 /***/) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const d = src.charCodeAt(i);
        if (d === 40 && src.charCodeAt(i + 1) === 42) { depth++; i += 2; }
        else if (d === 42 && src.charCodeAt(i + 1) === 41) { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) errors.push({ start, end: Math.min(start + 2, n), message: 'Unterminated comment' });
      if (active) comments.push({ start, end: i, text: src.slice(start + 2, depth > 0 ? i : i - 2) });
      continue;
    }
    // pragma <* ... *>
    if (c === 60 /*<*/ && src.charCodeAt(i + 1) === 42) {
      const start = i;
      const close = src.indexOf('*>', i + 2);
      const end = close < 0 ? n : close + 2;
      pragmas.push({ start, end });
      handlePragma(src.slice(start + 2, close < 0 ? n : close), start, end);
      i = end;
      continue;
    }
    // %IF-style conditional compilation
    if (c === 37 /*%*/ && isIdStart(src.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdChar(src.charCodeAt(j))) j++;
      const word = src.slice(i + 1, j);
      if (word === 'IF' || word === 'ELSIF') {
        const thenAt = src.indexOf('%THEN', j);
        const condEnd = thenAt < 0 ? j : thenAt;
        const end = thenAt < 0 ? j : thenAt + 5;
        const cond = evalCondition(src.slice(j, condEnd), localDefines);
        pragmas.push({ start: i, end });
        if (word === 'IF') { pushCond(cond, end); if (!active) conds[conds.length - 1].start = end; }
        else elsif(cond, i, end);
        i = end;
        continue;
      }
      if (word === 'ELSE') { pragmas.push({ start: i, end: j }); elseBranch(i, j); i = j; continue; }
      if (word === 'END') { pragmas.push({ start: i, end: j }); endCond(i, j); i = j; continue; }
      // unknown %WORD: treat '%' as operator
    }
    const start = i;
    if (isIdStart(c)) {
      i++;
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      const s = src.slice(start, i);
      if (active) tokens.push({ t: KEYWORDS.has(s) ? T.Keyword : T.Ident, s, start, end: i });
      continue;
    }
    if (isDigit(c)) {
      i++;
      while (i < n && isHexDigit(src.charCodeAt(i))) i++;
      const h = src.charCodeAt(i);
      if (h === 72 /*H*/ || h === 104 /*h*/) i++;
      else if (h === 46 /*.*/ && src.charCodeAt(i + 1) !== 46) {
        // real
        i++;
        while (i < n && isDigit(src.charCodeAt(i))) i++;
        if (src.charCodeAt(i) === 69 /*E*/ || src.charCodeAt(i) === 101) {
          const k = i + 1;
          const s1 = src.charCodeAt(k);
          const k2 = s1 === 43 || s1 === 45 ? k + 1 : k;
          if (isDigit(src.charCodeAt(k2))) {
            i = k2;
            while (i < n && isDigit(src.charCodeAt(i))) i++;
          }
        }
      }
      emit(T.Number, start, i);
      continue;
    }
    if (c === 39 || c === 34) {
      i++;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (d === c) { i++; break; }
        if (d === 10 || d === 13) {
          if (active) errors.push({ start, end: i, message: 'Unterminated string' });
          break;
        }
        i++;
      }
      // ADW typed string literals: "text"A (ACHAR), "text"U (UCHAR)
      const sfx = src.charCodeAt(i);
      if ((sfx === 65 || sfx === 85) && !isIdChar(src.charCodeAt(i + 1))) i++;
      emit(T.String, start, i);
      continue;
    }
    // operators
    const c2 = src.charCodeAt(i + 1);
    let len = 1;
    if ((c === 58 /*:*/ && c2 === 61) || (c === 60 && (c2 === 61 || c2 === 62)) || (c === 62 && c2 === 61) || (c === 46 && c2 === 46)) len = 2;
    i += len;
    emit(T.Op, start, i);
  }
  while (conds.length) {
    const f = conds.pop()!;
    markInactiveEnd(f, n);
    active = f.parentActive;
  }
  tokens.push({ t: T.EOF, s: '', start: n, end: n });
  return { tokens, comments, inactive, pragmas, errors };
}
