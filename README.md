# ADW Modula-2 Language Server (LSP)

A high-performance implementation of the Language Server Protocol for the ADW Modula-2 dialect, featuring full support for Object-Oriented extensions including CLASS, INHERIT, and OVERRIDE.

## Core Functionality

### 1. Semantic Analysis
* **Contextual Highlighting**: Distinguished rendering for Types, Constants, Variables, and Procedures.
* **Comment Handling**: Robust parsing of nested comments `(* (* ... *) *)` and complex strings to prevent highlighting bleed.

### 2. Navigation Logic
* **Go to Definition**: Resolution of local symbols and cross-file navigation to `.def` headers.
* **Go to Implementation**: Direct mapping from procedure signatures in `.def` files to the corresponding bodies in `.mod` files.
* **Symbol Lookup**: Comprehensive workspace-wide symbol indexing and search.

### 3. ADW OOP Support
* **Inheritance Mapping**: Resolution of `INHERIT` chains to provide accurate member completion for base classes.
* **Override Identification**: Explicit marking of `OVERRIDE` methods within the Document Outline.

### 4. Technical Architecture
* **Indentation-Aware Scoping**: Deterministic scope resolution for nested procedures and modules based on block indentation.
* **Asynchronous Indexing**: Background processing of all workspace `.def` and `.mod` files for non-blocking cross-reference resolution.

## Installation

### VSIX Package
1. Obtain the `adw-modula2-lsp.vsix` file.
2. In VS Code, navigate to the Extensions view (`Ctrl+Shift+X`).
3. Select **Install from VSIX...** from the local menu and select the file.

### Source Build
1. Clone the repository.
2. Execute `npm install` in the root, `/client`, and `/server` directories.
3. Execute `npm run compile`.
4. Launch the Extension Development Host via `F5`.



## Project Structure

* `client/`: VS Code extension client-side activation and lifecycle management.
* `server/`: LSP Server implementation containing the Modula-2 parser and symbol engine.
* `logo.png`: Extension identifier icon.

## License

This project is licensed under the MIT License. See the `LICENSE` file for full text.