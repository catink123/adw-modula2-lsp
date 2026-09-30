// Pervasive identifiers and the compiler-provided SYSTEM module (ADW Modula-2).

import { Scope, Sym, SymKind, Unit } from './model';

type B = [name: string, kind: SymKind, sig: string, doc: string];

const PERVASIVE: B[] = [
  // types
  ['BOOLEAN', 'type', 'BOOLEAN', 'Boolean type: FALSE, TRUE.'],
  ['CHAR', 'type', 'CHAR', 'Character type (ACHAR or UCHAR depending on the compiler Unicode setting).'],
  ['ACHAR', 'type', 'ACHAR', '8-bit ANSI character.'],
  ['UCHAR', 'type', 'UCHAR', '16-bit Unicode character.'],
  ['INTEGER', 'type', 'INTEGER', 'Signed integer of the natural machine size.'],
  ['CARDINAL', 'type', 'CARDINAL', 'Unsigned integer of the natural machine size.'],
  ['LONGINT', 'type', 'LONGINT', 'Long signed integer.'],
  ['LONGCARD', 'type', 'LONGCARD', 'Long unsigned integer.'],
  ['SHORTINT', 'type', 'SHORTINT', 'Short signed integer.'],
  ['SHORTCARD', 'type', 'SHORTCARD', 'Short unsigned integer.'],
  ['INTEGER8', 'type', 'INTEGER8', '8-bit signed integer.'],
  ['INTEGER16', 'type', 'INTEGER16', '16-bit signed integer.'],
  ['INTEGER32', 'type', 'INTEGER32', '32-bit signed integer.'],
  ['INTEGER64', 'type', 'INTEGER64', '64-bit signed integer.'],
  ['CARDINAL8', 'type', 'CARDINAL8', '8-bit unsigned integer.'],
  ['CARDINAL16', 'type', 'CARDINAL16', '16-bit unsigned integer.'],
  ['CARDINAL32', 'type', 'CARDINAL32', '32-bit unsigned integer.'],
  ['CARDINAL64', 'type', 'CARDINAL64', '64-bit unsigned integer.'],
  ['REAL', 'type', 'REAL', 'Single precision floating point.'],
  ['LONGREAL', 'type', 'LONGREAL', 'Double precision floating point.'],
  ['SHORTREAL', 'type', 'SHORTREAL', 'Short floating point.'],
  ['COMPLEX', 'type', 'COMPLEX', 'Complex number of REAL components.'],
  ['LONGCOMPLEX', 'type', 'LONGCOMPLEX', 'Complex number of LONGREAL components.'],
  ['BITSET', 'type', 'BITSET', 'Set of 0 .. word size - 1.'],
  ['PROC', 'type', 'PROC', 'Parameterless procedure type.'],
  ['PROTECTION', 'type', 'PROTECTION', 'Interrupt protection type.'],
  // constants
  ['TRUE', 'const', 'TRUE', 'Boolean true.'],
  ['FALSE', 'const', 'FALSE', 'Boolean false.'],
  ['NIL', 'const', 'NIL', 'Null pointer value, compatible with all pointer types.'],
  ['EMPTY', 'const', 'EMPTY', 'Empty class instance value.'],
  ['INTERRUPTIBLE', 'const', 'INTERRUPTIBLE', 'Protection value.'],
  ['UNINTERRUPTIBLE', 'const', 'UNINTERRUPTIBLE', 'Protection value.'],
  // procedures
  ['ABS', 'procedure', 'ABS(x) : <type of x>', 'Absolute value.'],
  ['CAP', 'procedure', 'CAP(ch : CHAR) : CHAR', 'Upper case of a letter.'],
  ['CHR', 'procedure', 'CHR(x : CARDINAL) : CHAR', 'Character with ordinal x.'],
  ['CMPLX', 'procedure', 'CMPLX(re, im : REAL) : COMPLEX', 'Construct a complex number.'],
  ['DEC', 'procedure', 'DEC(VAR v [; n])', 'v := v - n (n defaults to 1).'],
  ['DISPOSE', 'procedure', 'DISPOSE(VAR p)', 'Release storage of p (calls DEALLOCATE).'],
  ['EXCL', 'procedure', 'EXCL(VAR s; e)', 's := s - {e}.'],
  ['FLOAT', 'procedure', 'FLOAT(x) : REAL', 'Convert to REAL.'],
  ['HALT', 'procedure', 'HALT[(status)]', 'Terminate the program.'],
  ['HIGH', 'procedure', 'HIGH(a) : CARDINAL', 'Highest index of an (open) array.'],
  ['IM', 'procedure', 'IM(z) : REAL', 'Imaginary part.'],
  ['INC', 'procedure', 'INC(VAR v [; n])', 'v := v + n (n defaults to 1).'],
  ['INCL', 'procedure', 'INCL(VAR s; e)', 's := s + {e}.'],
  ['INT', 'procedure', 'INT(x) : INTEGER', 'Convert to INTEGER.'],
  ['LENGTH', 'procedure', 'LENGTH(s : ARRAY OF CHAR) : CARDINAL', 'Length of a string.'],
  ['LFLOAT', 'procedure', 'LFLOAT(x) : LONGREAL', 'Convert to LONGREAL.'],
  ['MAX', 'procedure', 'MAX(T) : T', 'Largest value of type T.'],
  ['MIN', 'procedure', 'MIN(T) : T', 'Smallest value of type T.'],
  ['NEW', 'procedure', 'NEW(VAR p)', 'Allocate storage for p^ (calls ALLOCATE).'],
  ['ODD', 'procedure', 'ODD(x) : BOOLEAN', 'x is odd.'],
  ['ORD', 'procedure', 'ORD(x) : CARDINAL', 'Ordinal number of x.'],
  ['RE', 'procedure', 'RE(z) : REAL', 'Real part.'],
  ['SIZE', 'procedure', 'SIZE(v | T) : CARDINAL', 'Storage size of a variable or type.'],
  ['TRUNC', 'procedure', 'TRUNC(r) : CARDINAL', 'Truncate a real number.'],
  ['VAL', 'procedure', 'VAL(T, x) : T', 'Convert x to type T.'],
  ['CREATE', 'procedure', 'CREATE(VAR obj)', 'Create a class instance (ISO OO).'],
  ['DESTROY', 'procedure', 'DESTROY(obj)', 'Destroy a class instance (ISO OO).'],
  ['ISMEMBER', 'procedure', 'ISMEMBER(obj, Class) : BOOLEAN', 'Class membership test (ISO OO).'],
  ['CLONE', 'procedure', 'CLONE(obj) : <class>', 'Copy a class instance.'],
  ['SELF', 'var', 'SELF', 'The current object inside a class.'],
  ['ACHR', 'procedure', 'ACHR(x : CARDINAL) : ACHAR', 'ANSI character with ordinal x (ADW).'],
  ['UCHR', 'procedure', 'UCHR(x : CARDINAL) : UCHAR', 'Unicode character with ordinal x (ADW).'],
  ['NILPROC', 'const', 'NILPROC', 'Null procedure value (ADW).'],
  ['BREAK', 'procedure', 'BREAK', 'Leave the innermost loop (ADW).'],
  ['CONTINUE', 'procedure', 'CONTINUE', 'Continue with the next loop iteration (ADW).'],
  ['LONG', 'procedure', 'LONG(x)', 'Widen a value to its long type.'],
  ['SHORT', 'procedure', 'SHORT(x)', 'Narrow a value to its short type.'],
  ['ORD8', 'procedure', 'ORD8(x) : CARDINAL8', 'Ordinal value as a 8-bit cardinal (ADW).'],
  ['INT8', 'procedure', 'INT8(x) : INTEGER8', 'Convert to a 8-bit integer (ADW).'],
  ['CARD8', 'procedure', 'CARD8(x) : CARDINAL8', 'Convert to a 8-bit cardinal (ADW).'],
  ['ORD16', 'procedure', 'ORD16(x) : CARDINAL16', 'Ordinal value as a 16-bit cardinal (ADW).'],
  ['INT16', 'procedure', 'INT16(x) : INTEGER16', 'Convert to a 16-bit integer (ADW).'],
  ['CARD16', 'procedure', 'CARD16(x) : CARDINAL16', 'Convert to a 16-bit cardinal (ADW).'],
  ['ORD32', 'procedure', 'ORD32(x) : CARDINAL32', 'Ordinal value as a 32-bit cardinal (ADW).'],
  ['INT32', 'procedure', 'INT32(x) : INTEGER32', 'Convert to a 32-bit integer (ADW).'],
  ['CARD32', 'procedure', 'CARD32(x) : CARDINAL32', 'Convert to a 32-bit cardinal (ADW).'],
  ['ORD64', 'procedure', 'ORD64(x) : CARDINAL64', 'Ordinal value as a 64-bit cardinal (ADW).'],
  ['INT64', 'procedure', 'INT64(x) : INTEGER64', 'Convert to a 64-bit integer (ADW).'],
  ['CARD64', 'procedure', 'CARD64(x) : CARDINAL64', 'Convert to a 64-bit cardinal (ADW).'],
];

const SYSTEM: B[] = [
  ['ADDRESS', 'type', 'ADDRESS', 'Untyped pointer.'],
  ['BYTE', 'type', 'BYTE', 'Storage unit (8 bits).'],
  ['WORD', 'type', 'WORD', 'Machine word.'],
  ['LOC', 'type', 'LOC', 'Smallest addressable unit.'],
  ['DWORD', 'type', 'DWORD', 'Double word.'],
  ['ADR', 'procedure', 'ADR(v) : ADDRESS', 'Address of a variable.'],
  ['CAST', 'procedure', 'CAST(T, x) : T', 'Reinterpret the bits of x as type T.'],
  ['TSIZE', 'procedure', 'TSIZE(T) : CARDINAL', 'Size of type T.'],
  ['ADDADR', 'procedure', 'ADDADR(a : ADDRESS; offs : CARDINAL) : ADDRESS', 'Address arithmetic.'],
  ['SUBADR', 'procedure', 'SUBADR(a : ADDRESS; offs : CARDINAL) : ADDRESS', 'Address arithmetic.'],
  ['DIFADR', 'procedure', 'DIFADR(a, b : ADDRESS) : INTEGER', 'Difference of two addresses.'],
  ['MAKEADR', 'procedure', 'MAKEADR(value) : ADDRESS', 'Build an address from a value.'],
  ['ADRCARD', 'type', 'ADRCARD', 'Unsigned integer of address size.'],
  ['ADRINT', 'type', 'ADRINT', 'Signed integer of address size.'],
  ['SHIFT', 'procedure', 'SHIFT(val, n) : <type of val>', 'Bit shift.'],
  ['ROTATE', 'procedure', 'ROTATE(val, n) : <type of val>', 'Bit rotation.'],
  ['FUNC', 'procedure', 'FUNC f(args)', 'Call a function procedure and discard its result.'],
  ['UNREFERENCED_PARAMETER', 'procedure', 'UNREFERENCED_PARAMETER(p)', 'Suppress the unused-parameter warning.'],
  ['FIXME', 'procedure', 'FIXME(msg)', 'Emit a compiler FIXME warning.'],
  ['SWAPENDIAN', 'procedure', 'SWAPENDIAN(VAR v)', 'Swap byte order.'],
  ['FILL', 'procedure', 'FILL(addr : ADDRESS; val : BYTE; count : CARDINAL)', 'Fill memory.'],
  ['MOVE', 'procedure', 'MOVE(src, dst : ADDRESS; count : CARDINAL)', 'Copy memory.'],
  ['OFFS', 'procedure', 'OFFS(Record.field) : CARDINAL', 'Offset of a record field.'],
  ['SOURCEFILE', 'const', 'SOURCEFILE', 'Current source file name.'],
  ['SOURCELINE', 'const', 'SOURCELINE', 'Current source line number.'],
  ['VA_START', 'procedure', 'VA_START(VAR args)', 'Start variable argument processing.'],
  ['VA_ARG', 'procedure', 'VA_ARG(VAR args; T) : T', 'Next variable argument.'],
  ['CPUCOUNT', 'procedure', 'CPUCOUNT() : CARDINAL', 'Number of processors.'],
  ['EXITCODE', 'var', 'EXITCODE', 'Program exit code.'],
];

function makeUnit(uri: string, name: string): Unit {
  const u = {
    uri, path: '', kind: 'definition', generic: false, name, text: '',
    tokens: [], comments: [], inactive: [], pragmas: [], symbols: [], refs: [], imports: [],
    folds: [], diags: [], version: 0,
  } as unknown as Unit;
  u.scope = new Scope('unit', u, undefined, 0, 0);
  return u;
}

function fill(u: Unit, list: B[]) {
  for (const [name, kind, sig, doc] of list) {
    const s: Sym = { name, kind, unit: u, start: 0, end: 0, nameStart: 0, nameEnd: 0, detail: sig, doc };
    if (kind === 'type') s.type = { k: 'builtin', name };
    u.scope.add(s);
    u.symbols.push(s);
  }
}

export const builtinUnit = makeUnit('modula2-builtin:pervasive', '(pervasive)');
fill(builtinUnit, PERVASIVE);

const SYSTEM_MODULES = new Map<string, Unit>();

function makeSystemModule(name: string, list: B[], doc: string) {
  const u = makeUnit(`modula2-builtin:${name}`, name);
  fill(u, list);
  u.moduleSym = {
    name, kind: 'module', unit: u, start: 0, end: 0, nameStart: 0, nameEnd: 0,
    detail: `DEFINITION MODULE ${name}`, doc, scope: u.scope,
  };
  SYSTEM_MODULES.set(name, u);
  return u;
}

export const systemUnit = makeSystemModule('SYSTEM', SYSTEM, 'Compiler-provided low-level module.');
makeSystemModule('EXCEPTIONS', [
  ['ExceptionSource', 'type', 'ExceptionSource', 'Identifies the source of an exception.'],
  ['ExceptionNumber', 'type', 'ExceptionNumber', 'Exception number.'],
  ['AllocateSource', 'procedure', 'AllocateSource(VAR newSource : ExceptionSource)', 'Allocate a unique exception source.'],
  ['RAISE', 'procedure', 'RAISE(source : ExceptionSource; number : ExceptionNumber; message : ARRAY OF CHAR)', 'Raise an exception.'],
  ['CurrentNumber', 'procedure', 'CurrentNumber(source : ExceptionSource) : ExceptionNumber', 'Number of the current exception.'],
  ['GetMessage', 'procedure', 'GetMessage(VAR text : ARRAY OF CHAR)', 'Message of the current exception.'],
  ['IsCurrentSource', 'procedure', 'IsCurrentSource(source : ExceptionSource) : BOOLEAN', 'The current exception comes from source.'],
  ['IsExceptionalExecution', 'procedure', 'IsExceptionalExecution() : BOOLEAN', 'Executing in an exception handler.'],
], 'ISO exception handling (compiler-provided).');
makeSystemModule('M2EXCEPTION', [
  ['M2Exceptions', 'type', 'M2Exceptions', 'Language exceptions.'],
  ['M2Exception', 'procedure', 'M2Exception() : M2Exceptions', 'The current language exception.'],
  ['IsM2Exception', 'procedure', 'IsM2Exception() : BOOLEAN', 'The current exception is a language exception.'],
], 'ISO language exceptions (compiler-provided).');
makeSystemModule('TERMINATION', [
  ['IsTerminating', 'procedure', 'IsTerminating() : BOOLEAN', 'Program termination has started.'],
  ['HasHalted', 'procedure', 'HasHalted() : BOOLEAN', 'HALT has been called.'],
], 'ISO termination (compiler-provided).');
makeSystemModule('COROUTINES', [], 'ISO coroutines (compiler-provided).');

export function systemModule(name: string): Sym | undefined {
  return SYSTEM_MODULES.get(name)?.moduleSym;
}
export function isSystemModule(s: Sym): boolean {
  return SYSTEM_MODULES.get(s.unit.name) === s.unit;
}

/** members of compiler-provided modules that are not in the table still resolve */
export function systemMember(mod: Sym, name: string): Sym {
  const u = mod.unit;
  const s = u.scope.syms.get(name);
  if (s) return s;
  const n: Sym = { name, kind: 'procedure', unit: u, start: 0, end: 0, nameStart: 0, nameEnd: 0, detail: name, doc: `${u.name} identifier.` };
  u.scope.add(n);
  return n;
}

export const isBuiltin = (s: Sym) => s.unit === builtinUnit || SYSTEM_MODULES.get(s.unit.name) === s.unit;
