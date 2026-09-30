# Changelog

## 1.1.0

- New language server, rewritten from scratch: hand-written lexer and tolerant parser for the full ADW dialect
  (ISO OO classes, generics and generic instances, local modules, `MACRO`/`PUREASM` procedures, `BITFIELDS`,
  typed constants, initialized variables, `BAND`/`BOR`/`SHL` operators, `"text"A` strings, `%IF` and `<*IF*>`
  conditional compilation evaluated against `modula2.defines`).
- Semantic name resolution across modules: record fields through pointers/arrays, `WITH`, class members across
  DEF/MOD and `INHERIT`, `SELF`, `GUARD`, enumeration constants imported with their type.
- New: references, rename, completion, signature help, call hierarchy, type definition, semantic highlighting,
  document highlights, folding, diagnostics, ADW `.err` compiler messages, `$adw-m2` problem matcher,
  DEF/MOD switch (`Alt+O`), snippets, ADW library DEFs indexed from the installation folder.
- Replaces the tree-sitter based 0.1.0 implementation and the `.sbp` project loading command (modules are now
  found by scanning the workspace, `modula2.searchPaths` and the ADW installation).

## 1.0.0

- Internal build: ADW Modula-2 language server (outline, workspace symbols, go to definition / declaration /
  implementation / type definition, references, rename, hover, completion, signature help, document highlights,
  call hierarchy, folding, semantic highlighting, diagnostics, ADW `.err` compiler messages), TextMate grammar,
  snippets and a DEF/MOD switch command.
