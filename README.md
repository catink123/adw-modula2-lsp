# ADW Modula-2 for VS Code

Language support for **ADW / Stony Brook Modula-2**: ISO Modula-2 plus the ADW extensions (ISO OO classes, generics, `UNSAFEGUARDED`, `<* *>` pragmas, `%IF` conditional compilation,
`MACRO` / `PUREASM` procedures, `BAND`/`BOR`/`SHL` operators, typed string literals `"x"A`, and so on).

## Features

| Feature | Notes |
| --- | --- |
| Syntax highlighting | TextMate grammar with nested comments, pragmas and directives, plus semantic highlighting (modules, types, classes, procedures, methods, fields, parameters, constants, enumeration constants; inactive `<*IF*>` branches dimmed). |
| Outline / breadcrumbs | Module → constants, types (record fields, enumeration constants), variables, classes (members), procedures (nested procedures), local modules. |
| Go to Definition (F12) | Works through `FROM M IMPORT x`, `M.x`, record fields (`p^.a[i].b`), `WITH` blocks, class members (inherited through `INHERIT`, across DEF and MOD), `SELF`, `GUARD` variables, generic instances, enumeration constants imported with their type. On a declaration it jumps to the counterpart (DEF heading ↔ MOD body). |
| Go to Declaration / Implementation | Declaration = DEF heading; Implementation (Ctrl+F12) = MOD body. |
| Go to Type Definition | The declared type of a variable, field, parameter or function result. |
| Find All References (Shift+F12) | Workspace-wide, semantic (not text search): only occurrences that resolve to the same symbol, DEF and MOD declarations included. |
| Rename (F2) | Uses references; refuses keywords, built-ins, library symbols and module names. |
| Hover | Signature plus the doc comment (the comment after a DEF heading, a trailing field comment, or the comment before a declaration). MOD bodies show the DEF comment. |
| Completion | Scope-aware names, `Module.` exports, record / class members after `.`, `FROM M IMPORT` lists, module names after `IMPORT`/`FROM`, keywords, snippets. |
| Signature help | Parameters of procedures and procedure-typed variables. |
| Call hierarchy | Incoming and outgoing calls. |
| Workspace symbols (Ctrl+T) | Background index of all modules. |
| Folding | Procedures, classes, records, statement blocks, comments, imports, conditional-compilation regions. |
| Diagnostics | Syntax errors, `END` name mismatches, unknown modules, names not exported by the imported module, undeclared identifiers (configurable), inactive branches, and messages from ADW compiler `*.err` files. |
| DEF ↔ MOD | `Alt+O` / context menu: *Switch Between DEFINITION and IMPLEMENTATION Module*. |
| Tasks | Problem matcher `$adw-m2` for `file(line)(col) : error: message` compiler output. |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `modula2.adwPath` | `C:\Program Files (x86)\ADW Software Modula-2` | Its `*def` folders are indexed as libraries (WIN32, Storage, …). |
| `modula2.searchPaths` | `[]` | Extra folders with `.def`/`.mod` files. |
| `modula2.defines` | `{}` | Conditional compilation symbols, e.g. `{ "VIEWER": false, "DEBUG": true }`. `AMD64` is `true` unless set. |
| `modula2.exclude` | `.svn`, `.git`, `node_modules` | Globs not indexed. |
| `modula2.diagnostics.unresolvedIdentifiers` | `information` | `off` / `hint` / `information` / `warning` / `error`. |
| `modula2.diagnostics.compilerErrors` | `true` | Show ADW `*.err` messages (skipped when older than the source). |
| `modula2.index.onStartup` | `true` | Build the workspace symbol index in the background. |
| `modula2.cacheSize` | `400` | Parsed modules kept in memory. |

Files are opened as Windows-1252 by default (`files.encoding` for `[modula2]`), matching the ADW sources.

## How it works

`src/server` is a self-contained language server:

- `lexer.ts` — tokens, nested comments, pragmas; evaluates `<*IF*>` / `%IF` against the defines (and `<*ENVIRON*>`).
- `parser.ts` — tolerant recursive-descent parser. Declarations are parsed fully; statement bodies are scanned for
  block structure and designators (`a.b[i]^.c(x)`), each identifier recorded as a `Ref` chained to its base.
- `resolver.ts` — scope chains, imports, DEF/MOD pairing, class inheritance, record/pointer/array/class
  member resolution, `WITH`, generics.
- `workspace.ts` — module file index (case-insensitive, nearest path wins for duplicates) and an LRU parse cache.
- `features.ts` / `server.ts` — LSP features and transport.

Measured on a large production ADW code base (1,683 files, 56 MB): all files parse without errors in ~4 s;
99.86% of the 3.1 M identifier occurrences resolve (the rest are mostly fields reached through generic type
parameters). Opening a module and resolving its names takes well under a second; the startup scan ~1 s.

## Development

```
npm install
npm run build        # dist/extension.js + dist/server.js
npm test             # feature tests (set M2_SMOKE_ROOT=<project> to add a real-project smoke test)
npm run typecheck
npm run package      # modula2-adw-1.0.0.vsix
node out/test/parse-corpus.js <root>      # parse every file, report errors
node out/test/resolve-corpus.js <root>    # resolve every identifier, report failures
node out/test/lsp-e2e.js <root> <file>    # talk LSP to dist/server.js
```

Press F5 in VS Code (`Run Extension`) to launch an Extension Development Host, then open an ADW project folder;
`Attach to Server` debugs the language server on port 6019.

## License

MIT
