import * as fs from 'fs';
import * as path from 'path';
import {
    createConnection, TextDocuments, ProposedFeatures, InitializeParams, CompletionItem, CompletionItemKind,
    TextDocumentPositionParams, TextDocumentSyncKind, HoverParams, Hover, MarkupKind, SignatureHelpParams,
    SignatureHelp, SignatureInformation, ParameterInformation, SymbolKind, DocumentSymbol, Range, Definition, 
    Location
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let workspaceRoot: string | undefined;
const documentScopes: Map<string, Promise<Scope>> = new Map();
const externalModules: Map<string, Scope> = new Map();
const failedModules: Set<string> = new Set(); // Negative cache to prevent filesystem lag
const workspaceFileMap: Map<string, string> = new Map();

let isMapBuilding = false;
let activeProcessingTasks = 0;
let globalProgress: any = null;

// --- DATA STRUCTURES ---
interface SymbolInfo {
    name: string;
    kind: CompletionItemKind;
    detail: string;
    type?: string;
    signature?: string;
    parameters?: string[];
    line: number;
    character?: number;
    isImport?: boolean;
    isParameter?: boolean;
    isOverride?: boolean;
}
interface Scope {
    name: string; kind: 'Module' | 'Procedure' | 'Class' | 'Record' | 'Global';
    parent: Scope | null; children: Scope[]; symbols: Map<string, SymbolInfo>;
    importedScopes: Map<string, Scope>; startLine: number; endLine: number;
    startColumn?: number;
}

async function indexWorkspace() {
    if (isMapBuilding) return;
    if (!workspaceRoot) {
        connection.console.log("[INDEX] No workspace root found. Skipping index.");
        return;
    }
    isMapBuilding = true;
    
    connection.console.log("[INDEX] Building workspace file map...");
    
    function walk(dir: string) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                if (!['.git', 'node_modules', 'out'].includes(file)) walk(fullPath);
            } else if (file.toLowerCase().endsWith('.def') || file.toLowerCase().endsWith('.mod')) {
                workspaceFileMap.set(file.toLowerCase(), fullPath);
            }
        }
    }
    
    walk(workspaceRoot);
    isMapBuilding = false;
    connection.console.log(`[INDEX] Indexed ${workspaceFileMap.size} definition files.`);
}

async function updateProgress(moduleName: string, increment: boolean) {
    if (increment) {
        activeProcessingTasks++;
    } else {
        activeProcessingTasks--;
    }

    if (activeProcessingTasks > 0) {
        if (!globalProgress) {
            globalProgress = await connection.window.createWorkDoneProgress();
            globalProgress.begin('ADW Modula-2', 0, `Analyzing ${moduleName}...`, false);
        } else {
            globalProgress.report(`Loading ${moduleName} (${activeProcessingTasks} left)`);
        }
    } else if (globalProgress) {
        globalProgress.done();
        globalProgress = null;
        connection.console.log("[STATUS] All symbols loaded.");
    }
}

// --- URI TO PATH CONVERTER ---
function uriToPath(uri: string): string {
    let p = uri.replace(/^file:\/\//, '');
    p = decodeURIComponent(p);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.substring(1); // Fix Windows /C:/path
    return path.normalize(p);
}

// --- INITIALIZATION ---
connection.onInitialize((params: InitializeParams) => {
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
        workspaceRoot = uriToPath(params.workspaceFolders[0].uri);
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
            hoverProvider: true,
            signatureHelpProvider: { triggerCharacters: ['(', ','] },
            documentSymbolProvider: true,
            definitionProvider: true,
            implementationProvider: true,
            window: {
                workDoneProgress: true
            },
            semanticTokensProvider: {
                legend: {
                    // Use standard VS Code token names
                    tokenTypes: [
                        'namespace',  // for Modules
                        'class',      // for Classes
                        'method',     // for Procedures/Functions
                        'variable',   // for Variables
                        'parameter',  // for Procedure Arguments
                        'property',    // for Constants or Fields
                        'type',
                        'enumMember'
                    ],
                    tokenModifiers: ['declaration', 'readonly', 'static']
                },
                full: true
            }
        }
    };
});

connection.onInitialized(async () => {
    await indexWorkspace();

    documents.all().forEach((doc) => {
        const isDef = doc.uri.toLowerCase().endsWith('.def');
        const scopePromise = parseTextToScope(doc.getText(), 'Global', isDef);
        documentScopes.set(doc.uri, scopePromise);
    });
});

function injectSystemModule() {
    const sysScope: Scope = { name: 'SYSTEM', kind: 'Module', parent: null, children: [], symbols: new Map(), importedScopes: new Map(), startLine: 0, endLine: 0 };
    const sysSymbols = [
        { name: 'LOC', kind: CompletionItemKind.Struct, detail: 'TYPE LOC' },
        { name: 'BYTE', kind: CompletionItemKind.Struct, detail: 'TYPE BYTE' },
        { name: 'WORD', kind: CompletionItemKind.Struct, detail: 'TYPE WORD' },
        { name: 'DWORD', kind: CompletionItemKind.Struct, detail: 'TYPE DWORD' },
        { name: 'ADDRESS', kind: CompletionItemKind.Struct, detail: 'TYPE ADDRESS' },
        { name: 'ADRCARD', kind: CompletionItemKind.Struct, detail: 'TYPE ADRCARD' },
        { name: 'ADRINT', kind: CompletionItemKind.Struct, detail: 'TYPE ADRINT' },
        { name: 'MAKEADR', kind: CompletionItemKind.Function, detail: 'PROCEDURE MAKEADR(offs: ADRCARD): ADDRESS', signature: '(offs: ADRCARD)', parameters: ['offs: ADRCARD'] },
        { name: 'CAST', kind: CompletionItemKind.Function, detail: 'PROCEDURE CAST(TypeName, expression)', signature: '(TypeName, expression)', parameters: ['TypeName', 'expression'] },
        { name: 'ADR', kind: CompletionItemKind.Function, detail: 'PROCEDURE ADR(VAR VarOrProc): ADDRESS', signature: '(VAR VarOrProc)', parameters: ['VAR VarOrProc'] }
    ];
    sysSymbols.forEach(s => sysScope.symbols.set(s.name, { ...s, line: 0 } as SymbolInfo));
    externalModules.set('SYSTEM', sysScope);
}
injectSystemModule();

// --- WORKSPACE FILE READER ---
function findFileInWorkspace(dir: string, fileName: string): string | null {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                if (file.startsWith('.') || file === 'node_modules' || file === 'out') continue;
                const found = findFileInWorkspace(filePath, fileName);
                if (found) return found;
            } else {
                if (file.toLowerCase() === fileName.toLowerCase()) return filePath;
            }
        }
    } catch (e) { }
    return null;
}

async function loadExternalModule(moduleName: string, isMod: boolean = false): Promise<Scope | null> {
    // 1. Create a unique cache key (e.g., "Output.def" or "Output.mod")
    const cacheKey = `${moduleName.toLowerCase()}${isMod ? '.mod' : '.def'}`;
    
    if (externalModules.has(cacheKey)) return externalModules.get(cacheKey)!;
    if (failedModules.has(cacheKey) || !workspaceRoot) return null;

    // Notify UI we are working
    await updateProgress(moduleName, true);

    // 2. Find the correct file path from your map
    const filePath = workspaceFileMap.get(cacheKey);
    
    if (filePath && fs.existsSync(filePath)) {
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            // 3. Parse. If it's a .mod, isDefFile is false so we get nested scopes
            const scope = await parseTextToScope(text, moduleName, !isMod);
            
            externalModules.set(cacheKey, scope);
            await updateProgress(moduleName, false);
            return scope;
        } catch (e) {
            connection.console.error(`Failed to parse ${cacheKey}: ${e}`);
        }
    }
    
    failedModules.add(cacheKey);
    await updateProgress(moduleName, false);
    return null;
}

// --- BULLETPROOF CODE SANITIZER ---
function sanitizeModula2Code(text: string): string {
    let result = '';
    let i = 0;
    let commentDepth = 0;
    let inString = false;
    let stringChar = '';
    let inPragma = false;

    while (i < text.length) {
        const c = text[i];
        const nextC = i + 1 < text.length ? text[i + 1] : '';

        // Helper to preserve newlines while stripping content
        const placeholder = (char: string) => (char === '\n' || char === '\r' ? char : ' ');

        // 1. String handling
        if (inString) {
            if (c === stringChar) {
                inString = false;
                result += ' '; // Close quote placeholder
            } else {
                result += placeholder(c);
            }
            i++; continue;
        }

        // 2. Pragma handling <* ... *>
        if (inPragma) {
            if (c === '*' && nextC === '>') {
                inPragma = false;
                result += '  '; // Placeholder for *>
                i += 2; continue;
            }
            result += placeholder(c);
            i++; continue;
        }

        // 3. Comment handling (* ... *)
        if (commentDepth > 0) {
            if (c === '(' && nextC === '*') {
                commentDepth++;
                result += '  ';
                i += 2; continue;
            }
            if (c === '*' && nextC === ')') {
                commentDepth--;
                result += '  ';
                i += 2; continue;
            }
            result += placeholder(c);
            i++; continue;
        }

        // --- Start Triggers ---
        
        // String Start
        if (c === '"' || c === "'") {
            inString = true;
            stringChar = c;
            result += ' ';
            i++; continue;
        }
        
        // Pragma Start
        if (c === '<' && nextC === '*') {
            inPragma = true;
            result += '  ';
            i += 2; continue;
        }
        
        // Comment Start
        if (c === '(' && nextC === '*') {
            commentDepth++;
            result += '  ';
            i += 2; continue;
        }
        
        // 4. Strip %IF, %ELSE etc (Keep the newline if it exists)
        if (c === '%') {
            result += ' ';
            i++;
            while (i < text.length && /[a-zA-Z_]/.test(text[i])) {
                result += ' ';
                i++;
            }
            continue;
        }

        result += c;
        i++;
    }
    return result;
}

// --- PARSER ---
async function parseTextToScope(text: string, scopeName: string = 'Global', isDefFile: boolean = false): Promise<Scope> {
    let currentScope: Scope = {
        name: scopeName, 
        kind: 'Global', 
        parent: null, 
        children: [],
        symbols: new Map(), 
        importedScopes: new Map(), 
        startLine: 0, // Ensure this is 0
        startColumn: 0,
        endLine: text.split(/\r?\n/).length + 1 // Ensure this covers everything
    };
    const rootScope = currentScope;

    connection.console.log(`[PARSER] Parsing scope: ${scopeName}`);
    const cleanText = sanitizeModula2Code(text);

    // 1. FAST TOKEN-BASED IMPORT EXTRACTOR
    // This captures words, commas, and semicolons. Everything else is ignored.
    const tokens = Array.from(cleanText.matchAll(/[a-zA-Z_]\w*|[;,]/g)).map(m => m[0]);
    const stopWords = new Set(['VAR', 'CONST', 'TYPE', 'PROCEDURE', 'BEGIN', 'MODULE', 'END', 'CLASS', 'TRACED', 'IMPLEMENTATION', 'DEFINITION', 'INHERIT', 'REVEAL', 'OVERRIDE']);

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token === 'FROM') {
            const modName = tokens[i + 1];
            if (modName && tokens[i + 2] === 'IMPORT') {
                i += 3;
                // Just advance the index, don't add to symbols yet
                while (i < tokens.length && tokens[i] !== ';') {
                    if (stopWords.has(tokens[i].toUpperCase())) { i--; break; }
                    i++;
                }
                // Just load it into memory/cache
                await loadExternalModule(modName, false);
            }
        } else if (token === 'IMPORT') {
            i++;
            while (i < tokens.length && tokens[i] !== ';') {
                const mod = tokens[i];
                if (stopWords.has(mod.toUpperCase())) { i--; break; }
                if (mod !== ',') await loadExternalModule(mod, false);
                i++;
            }
        } else if (token === 'INHERIT') {
            const baseClassName = tokens[i + 1];
            if (baseClassName && !stopWords.has(baseClassName.toUpperCase())) {
                connection.console.log(`[OOP] Class ${scopeName} inherits from ${baseClassName}`);
                
                // Set the type of the current class symbol in the parent scope if possible
                if (currentScope.parent) {
                    const classSym = currentScope.parent.symbols.get(currentScope.name);
                    if (classSym) classSym.type = baseClassName;
                }

                // Load the base class definition as an imported scope
                const baseScope = await loadExternalModule(baseClassName);
                if (baseScope) {
                    // This allows findSymbol to look inside the base class
                    currentScope.importedScopes.set(baseClassName, baseScope);
                    connection.console.log(`[OOP] Successfully linked base class: ${baseClassName}`);
                }
            }
            i++; // Skip the baseClassName token
        }
        i++;
    }

    // 2. LOCAL SYMBOL PARSER
    const lines = text.split(/\r?\n/);
    let inVarBlock = false;
    let inTypeBlock = false;
    let inConstBlock = false;

    const moduleRegex = /^\s*(?:IMPLEMENTATION\s+|DEFINITION\s+)?MODULE\s+([a-zA-Z_]\w*)/i;
    const classRegex = /^\s*(?:TRACED\s+|ABSTRACT\s+)?CLASS\s+([a-zA-Z_]\w*)/i;
    const procRegex = /^\s*(?:OVERRIDE\s+)?PROCEDURE\s+([a-zA-Z_]\w*)\s*(\(.*\))?\s*(?::\s*[a-zA-Z_]\w*)?\s*[;]?/i;
    const endRegex = /^\s*END\s+([a-zA-Z_]\w*)\b/i;
    const varKeywordRegex = /^\s*VAR\b/i;
    const blockEndRegex = /^\s*(BEGIN|TYPE|CONST|PROCEDURE|MODULE|CLASS|END)\b/i;
    const varDeclRegex = /^\s*([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*:\s*([a-zA-Z_]\w*)/;
    const fromImportRegex = /^\s*FROM\s+([a-zA-Z_]\w*)\s+IMPORT/i;
    const standardImportRegex = /^\s*IMPORT\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*;/i;
    const typeKeywordRegex = /^\s*TYPE\b/i;
    const constKeywordRegex = /^\s*CONST\b/i;
    const typeOrConstDeclRegex = /^\s*([a-zA-Z_]\w*)\s*=/; // Matches "Name ="

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Replace your existing block trigger logic with this:
        if (typeKeywordRegex.test(line)) { inTypeBlock = true; inVarBlock = false; inConstBlock = false; continue; }
        if (constKeywordRegex.test(line)) { inConstBlock = true; inVarBlock = false; inTypeBlock = false; continue; }
        if (varKeywordRegex.test(line)) { inVarBlock = true; inTypeBlock = false; inConstBlock = false; continue; }
        
        // If we hit any other block keyword, turn off assignment modes
        if (blockEndRegex.test(line) && !/^(VAR|TYPE|CONST)$/i.test(line.trim())) {
            inVarBlock = false; inTypeBlock = false; inConstBlock = false;
        }

        // --- ADDED: Track IMPORT lines for Outline/GoToDefinition ---
        const fromMatch = line.match(fromImportRegex);
        if (fromMatch) {
            const modName = fromMatch[1];
            // Look for the .def in our new cache format
            const extScope = externalModules.get(modName.toLowerCase() + '.def');

            // 1. Register the Module itself
            currentScope.symbols.set(modName, { 
                name: modName, kind: CompletionItemKind.Module, 
                detail: `MODULE ${modName}`, type: modName, 
                line: i, character: line.indexOf(modName), 
                isImport: true 
            });

            if (extScope) {
                currentScope.importedScopes.set(modName, extScope);
                
                // 2. Extract the specific symbols from the line (e.g., "WriteInt, ReadInt")
                const symPart = line.split(/IMPORT/i)[1] || '';
                const importedSymNames = symPart.replace(';', '').split(',').map(s => s.trim());
                
                for (const sName of importedSymNames) {
                    const original = extScope.symbols.get(sName);
                    if (original) {
                        currentScope.symbols.set(sName, { 
                            ...original, 
                            line: i, 
                            character: line.indexOf(sName),
                            isImport: true,
                            type: modName // CRITICAL: Store the source module name here!
                        });
                    }
                }
            }
            continue;
        }

        const stdImportMatch = line.match(standardImportRegex);
        if (stdImportMatch) {
            const mods = stdImportMatch[1].split(',').map(m => m.trim());
            for (const mod of mods) {
                currentScope.symbols.set(mod, { 
                    name: mod, kind: CompletionItemKind.Module, 
                    detail: `Imported MODULE ${mod}`, type: mod, 
                    line: i, character: line.indexOf(mod), 
                    isImport: true 
                });
            }
            continue;
        }
        // ------------------------------------------------------------

        const procMatch = line.match(procRegex);
        if (procMatch) {
            const name = procMatch[1];
            const signature = procMatch[2] || "()";
            const charPos = line.indexOf("PROCEDURE"); 
            const namePos = line.indexOf(name); // Specific start of the name

            // Check for OVERRIDE keyword in the line
            const isOverride = line.toUpperCase().includes('OVERRIDE');

            if (!isDefFile && currentScope.kind === 'Procedure') {
                const parentStartCol = currentScope.startColumn ?? 0;
                if (charPos <= parentStartCol) { 
                    currentScope.endLine = i - 1;
                    currentScope = currentScope.parent || rootScope;
                }
            }

            currentScope.symbols.set(name, { 
                name, 
                kind: CompletionItemKind.Method, 
                detail: `${isOverride ? '[OVERRIDE] ' : ''}PROCEDURE ${name}${signature}`, 
                line: i, 
                character: namePos >= 0 ? namePos : charPos, // Precision for Go to Definition
                isOverride: isOverride, // CRITICAL: Save this flag
                isParameter: false 
            });
            
            if (!isDefFile) {
                const newScope: Scope = { 
                    name, kind: 'Procedure', parent: currentScope, children: [], 
                    symbols: new Map(), importedScopes: new Map(), 
                    startLine: i, endLine: lines.length,
                    startColumn: charPos 
                };

                // --- THE PARAMETER PARSING LOGIC ---
                const paramContent = signature.match(/\((.*)\)/);
                if (paramContent && paramContent[1]) {
                    const groups = paramContent[1].split(';');
                    groups.forEach(group => {
                        const parts = group.match(/(?:VAR\s+|CONST\s+)?(.*?)\s*:\s*(.*)/i);
                        if (parts) {
                            const pNames = parts[1].split(',').map(n => n.trim());
                            const pType = parts[2].trim();
                            pNames.forEach(pName => {
                                newScope.symbols.set(pName, {
                                    name: pName,
                                    kind: CompletionItemKind.Variable,
                                    detail: `(Parameter) ${pName} : ${pType}`,
                                    type: pType,
                                    line: i,
                                    character: line.indexOf(pName), // Help Go to Definition for params
                                    isParameter: true 
                                });
                            });
                        }
                    });
                }
                currentScope.children.push(newScope);
                currentScope = newScope;
            }
            inVarBlock = false;
            continue;
        }

        const modMatch = line.match(moduleRegex);
        const classMatch = line.match(classRegex);
        if (modMatch || classMatch) {
            const name = modMatch ? modMatch[1] : classMatch![1];
            const kind = modMatch ? 'Module' : 'Class';
            const compKind = modMatch ? CompletionItemKind.Module : CompletionItemKind.Class;
            const namePos = line.indexOf(name); // FIX: Capture column for Module names

            currentScope.symbols.set(name, { 
                name, 
                kind: compKind, 
                detail: `${kind} ${name}`, 
                type: name, 
                line: i,
                character: namePos >= 0 ? namePos : 0 // FIX: Precise jump for modules
            });
            
            if (!isDefFile) {
                const newScope: Scope = { 
                    name, 
                    kind: kind as any, 
                    parent: currentScope, 
                    children: [], 
                    symbols: new Map(), 
                    importedScopes: new Map(), 
                    startLine: i, 
                    endLine: lines.length,
                    startColumn: line.indexOf(kind.toUpperCase()) // Track indentation for classes
                };
                currentScope.children.push(newScope);
                currentScope = newScope;
            }
            inVarBlock = false;
            continue;
        }

        if (varKeywordRegex.test(line)) inVarBlock = true;
        if (blockEndRegex.test(line) && !line.match(varKeywordRegex)) inVarBlock = false;

        if (inTypeBlock || inConstBlock) {
            const tcMatch = line.match(typeOrConstDeclRegex);
            if (tcMatch) {
                const name = tcMatch[1];
                const charPos = line.indexOf(name);
                
                currentScope.symbols.set(name, {
                    name: name,
                    // Map to Struct (for Type) or Constant (for Const)
                    kind: inTypeBlock ? CompletionItemKind.Struct : CompletionItemKind.Constant,
                    detail: line.trim(), // Shows the definition in hover
                    line: i,
                    character: charPos,
                    isImport: false
                });
            }
        }

        if (inVarBlock) {
            const varMatch = line.match(varDeclRegex);
            if (varMatch) {
                const varNamesPart = varMatch[1];
                const typeName = varMatch[2];
                const varNames = varNamesPart.split(',').map(v => v.trim());
                
                for (const vName of varNames) {
                    // Calculate character offset of this specific variable name
                    const charPos = line.indexOf(vName); 
                    currentScope.symbols.set(vName, {
                        name: vName,
                        kind: CompletionItemKind.Variable,
                        detail: `${vName} : ${typeName}`,
                        type: typeName,
                        line: i,
                        character: charPos >= 0 ? charPos : 0,
                        isImport: false
                    });
                }
            }
        }

        const endMatch = line.match(endRegex);
        if (!isDefFile && endMatch) {
            const endName = endMatch[1];
            let tempScope: Scope | null = currentScope;
            while (tempScope && tempScope.parent) {
                if (tempScope.name.toLowerCase() === endName.toLowerCase()) {
                    // Set the end line of the scope we just found
                    tempScope.endLine = i; 
                    // Move the 'active' pointer back to the parent
                    currentScope = tempScope.parent;
                    break;
                }
                tempScope = tempScope.parent;
            }
        }
    }
    return rootScope;
}

documents.onDidChangeContent(async change => { 
    const isDef = change.document.uri.toLowerCase().endsWith('.def');
    documentScopes.set(change.document.uri, parseTextToScope(change.document.getText(), 'Global', isDef));
});

// --- HELPER LOGIC ---
function findScopeAtLine(scope: Scope, line: number): Scope {
    for (const child of scope.children) {
        if (line >= child.startLine && line <= child.endLine) return findScopeAtLine(child, line); 
    }
    return scope;
}

function findSymbol(scope: Scope | null, name: string, rootScope: Scope): SymbolInfo | null {
    // Handle qualified names like "Output.BeginOutputToWindow"
    if (name.includes('.')) {
        const [modName, symName] = name.split('.');
        const targetScope = findScopeByName(rootScope, modName) || externalModules.get(modName);
        if (targetScope && targetScope.symbols.has(symName)) {
            return targetScope.symbols.get(symName)!;
        }
    }

    while (scope !== null) {
        if (scope.symbols.has(name)) return scope.symbols.get(name)!;
        
        // Search through modules imported into this specific scope
        for (const [modName, extScope] of scope.importedScopes.entries()) {
            if (modName === name) return { 
                name: modName, kind: CompletionItemKind.Module, 
                detail: `MODULE ${modName}`, type: modName, line: 0, character: 0 
            };
            if (extScope.symbols.has(name)) return extScope.symbols.get(name)!;
        }
        scope = scope.parent;
    }
    return null;
}

function findScopeByName(scope: Scope, name: string): Scope | null {
    if (scope.name === name) return scope;
    if (scope.importedScopes.has(name)) return scope.importedScopes.get(name)!;
    for (const child of scope.children) {
        const found = findScopeByName(child, name);
        if (found) return found;
    }
    return null;
}

// --- COMPLETION ---
connection.onCompletion(async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    const doc = documents.get(pos.textDocument.uri);
    if (!doc) return [];
    
    const scopePromise = documentScopes.get(pos.textDocument.uri);
    if (!scopePromise) return [];
    const rootScope = await scopePromise;

    const lines = doc.getText().split(/\r?\n/);
    const textBeforeCursor = lines[pos.position.line].substring(0, pos.position.character);
    let activeScope = findScopeAtLine(rootScope, pos.position.line);
    const completionItems: CompletionItem[] = [];

    const dotMatch = textBeforeCursor.match(/([a-zA-Z_]\w*)\.$/);
    if (dotMatch) {
        const parentName = dotMatch[1];
        const parentSymbol = findSymbol(activeScope, parentName, rootScope);
        let targetScopeName = parentSymbol?.type || parentName; 
        const targetScope = findScopeByName(rootScope, targetScopeName) || externalModules.get(targetScopeName);
        
        if (targetScope) {
            for (const [name, info] of targetScope.symbols.entries()) {
                completionItems.push({ label: name, kind: info.kind, detail: info.detail });
            }
        }
        return completionItems; 
    }

    const seenSymbols = new Set<string>();
    let current: Scope | null = activeScope;
    while (current !== null) {
        for (const [name, info] of current.symbols.entries()) {
            if (!seenSymbols.has(name)) {
                seenSymbols.add(name);
                completionItems.push({ label: name, kind: info.kind, detail: info.detail });
            }
        }
        for (const [modName, extScope] of current.importedScopes.entries()) {
            for (const [name, info] of extScope.symbols.entries()) {
                if (!seenSymbols.has(name)) {
                    seenSymbols.add(name);
                    completionItems.push({ label: name, kind: info.kind, detail: `[${modName}] ${info.detail}` });
                }
            }
        }
        current = current.parent;
    }
    return completionItems;
});
connection.onCompletionResolve((item: CompletionItem): CompletionItem => item);

// --- SIGNATURE HELP ---
connection.onSignatureHelp(async (pos: SignatureHelpParams): Promise<SignatureHelp | null> => {
    const doc = documents.get(pos.textDocument.uri);
    if (!doc) return null;

    const scopePromise = documentScopes.get(pos.textDocument.uri);
    if (!scopePromise) return null;
    const rootScope = await scopePromise;

    const line = doc.getText().split(/\r?\n/)[pos.position.line];
    const textBeforeCursor = line.substring(0, pos.position.character);
    const funcMatch = textBeforeCursor.match(/(?:([a-zA-Z_]\w*)\.)?([a-zA-Z_]\w*)\s*\([^)]*$/);
    
    if (funcMatch) {
        const moduleName = funcMatch[1]; 
        const funcName = funcMatch[2];
        const activeScope = findScopeAtLine(rootScope, pos.position.line);
        let symbol: SymbolInfo | null = null;

        if (moduleName) {
            const targetScope = findScopeByName(rootScope, moduleName) || externalModules.get(moduleName);
            if (targetScope) symbol = targetScope.symbols.get(funcName) || null;
        } else {
            symbol = findSymbol(activeScope, funcName, rootScope);
        }

        if (symbol && symbol.parameters) {
            const argsString = textBeforeCursor.substring(textBeforeCursor.lastIndexOf('(') + 1);
            const activeParameter = (argsString.match(/,/g) || []).length;
            const signature: SignatureInformation = {
                label: `${symbol.name}${symbol.signature || '()'}`,
                documentation: symbol.detail,
                parameters: symbol.parameters.map(p => ParameterInformation.create(p))
            };
            return { signatures: [signature], activeSignature: 0, activeParameter };
        }
    }
    return null;
});

// --- HOVER ---
connection.onHover(async (pos: HoverParams): Promise<Hover | null> => {
    const doc = documents.get(pos.textDocument.uri);
    if (!doc) return null;

    const scopePromise = documentScopes.get(pos.textDocument.uri);
    if (!scopePromise) return null;
    const rootScope = await scopePromise;

    const line = doc.getText().split(/\r?\n/)[pos.position.line];
    
    // Improved regex to capture "Module.Symbol" or "Symbol"
    const textUpToCursor = line.substring(0, pos.position.character);
    const textAfterCursor = line.substring(pos.position.character);
    
    const leftMatch = textUpToCursor.match(/[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/);
    const rightMatch = textAfterCursor.match(/^[a-zA-Z_]\w*/);
    
    if (!leftMatch) return null;
    const word = leftMatch[0] + (rightMatch ? rightMatch[0] : '');

    const activeScope = findScopeAtLine(rootScope, pos.position.line);
    const symbol = findSymbol(activeScope, word, rootScope);

    if (symbol) {
        return { contents: { kind: MarkupKind.Markdown, value: [`**${symbol.name}**`, '```modula2', symbol.detail, '```'].join('\n') } };
    }
    return null;
});

// --- OUTLINE ---
// Map our CompletionItemKind to SymbolKind for the Outline
function getSymbolKind(kind: CompletionItemKind): SymbolKind {
    switch (kind) {
        case CompletionItemKind.Module: return SymbolKind.Module;
        case CompletionItemKind.Class: return SymbolKind.Class;
        case CompletionItemKind.Function: return SymbolKind.Method;
        case CompletionItemKind.Variable: return SymbolKind.Variable;
        case CompletionItemKind.Struct: return SymbolKind.Struct;
        case CompletionItemKind.Constant: return SymbolKind.Constant;
        default: return SymbolKind.Field;
    }
}

async function waitForLoading() {
    while (activeProcessingTasks > 0) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Sleep 100ms
    }
}

connection.onDocumentSymbol(async (params): Promise<DocumentSymbol[]> => {
    const scopePromise = documentScopes.get(params.textDocument.uri);
    if (!scopePromise) return [];
    
    const rootScope = await scopePromise;

    function buildSymbolTree(scope: Scope): DocumentSymbol[] {
        const symbols: DocumentSymbol[] = [];
        const SAFE_WIDTH = 5000;

        // 1. Imports Branch
        if (scope.kind === 'Global') {
            const importSymbols: DocumentSymbol[] = [];
            for (const [name, info] of scope.symbols.entries()) {
                if (info.isImport) {
                    const line = info.line;
                    const char = info.character ?? 0;
                    
                    const range = Range.create(line, 0, line, SAFE_WIDTH);
                    const selectionRange = Range.create(line, char, line, char + name.length);
                    
                    importSymbols.push({
                        name: name,
                        detail: 'Imported Module',
                        kind: SymbolKind.Module,
                        range: range,
                        selectionRange: selectionRange
                    });
                }
            }
            if (importSymbols.length > 0) {
                const maxLine = Math.max(...importSymbols.map(s => s.range.end.line));
                symbols.push({
                    name: "Imports",
                    detail: "External Modules",
                    kind: SymbolKind.Package,
                    range: Range.create(0, 0, maxLine, SAFE_WIDTH),
                    selectionRange: Range.create(0, 0, 0, SAFE_WIDTH),
                    children: importSymbols
                });
            }
        }

        // 2. Process Nested Scopes
        const sortedChildren = [...scope.children].sort((a, b) => a.startLine - b.startLine);
        for (const child of sortedChildren) {
            const startLine = child.startLine;
            const endLine = Math.max(startLine, child.endLine); 
            
            // Ensure fullRange strictly contains the selectionRange
            const fullRange = Range.create(startLine, 0, endLine, SAFE_WIDTH);
            const selectionRange = Range.create(startLine, 0, startLine, SAFE_WIDTH);

            const symInfo = scope.symbols.get(child.name);
            const label = symInfo?.isOverride ? `Override: ${child.name}` : child.name;

            symbols.push({
                name: label,
                detail: child.kind,
                kind: child.kind === 'Procedure' ? SymbolKind.Method : (child.kind === 'Class' ? SymbolKind.Class : SymbolKind.Module),
                range: fullRange,
                selectionRange: selectionRange,
                children: buildSymbolTree(child)
            });
        }

        // 3. Process Local Variables
        const localSymbols = Array.from(scope.symbols.values())
            .filter(s => {
                const isLocal = s.line >= scope.startLine && s.line <= scope.endLine;
                const isScopeName = scope.children.some(child => child.name === s.name);
                return !s.isImport && !s.isParameter && isLocal && !isScopeName;
            })
            .sort((a, b) => a.line - b.line);

        for (const info of localSymbols) {
            const line = info.line;
            const char = info.character ?? 0;
            
            const varRange = Range.create(line, 0, line, SAFE_WIDTH);
            const varSelection = Range.create(line, char, line, char + info.name.length);
            
            symbols.push({
                name: info.name,
                detail: info.type || '',
                kind: getSymbolKind(info.kind),
                range: varRange,
                selectionRange: varSelection
            });
        }

        return symbols;
    }

    return buildSymbolTree(rootScope);
});

// --- SYNTAX HIGHLIGHT UPGRADE ---

connection.languages.semanticTokens.on(async (params) => {
    const scopePromise = documentScopes.get(params.textDocument.uri);
    if (!scopePromise) return { data: [] };
    
    // 1. Wait for the parser to finish building the symbol tree
    const rootScope = await scopePromise;

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };

    const data: number[] = [];
    let lastLine = 0;
    let lastChar = 0;

    const fullText = doc.getText();
    const lines = fullText.split(/\r?\n/);
    
    // 2. Sanitize the text so we can tell if a word is inside a comment
    // We must use the exact same sanitizer used by the parser
    const cleanText = sanitizeModula2Code(fullText);
    const cleanLines = cleanText.split(/\r?\n/);

    // Legend Mapping: 0:namespace, 1:class, 2:method, 3:variable, 4:parameter, 5:property
    const typeMap: Record<number, number> = {
        [CompletionItemKind.Module]: 0,
        [CompletionItemKind.Class]: 1,
        [CompletionItemKind.Function]: 2,
        [CompletionItemKind.Variable]: 3,
        [CompletionItemKind.TypeParameter]: 4,
        [CompletionItemKind.Constant]: 5, // property
        [CompletionItemKind.Struct]: 6,   // type
        [CompletionItemKind.EnumMember]: 7
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cleanLine = cleanLines[i];
        
        // Regex to find identifiers (e.g., "MyModule" or "MyModule.MyProc")
        const regex = /\b([a-zA-Z_]\w*)(?:\.([a-zA-Z_]\w*))?\b/g;
        let match;

        while ((match = regex.exec(line)) !== null) {
            const startChar = match.index;
            const part1 = match[1];
            const part2 = match[2];

            // 3. CHECK: Is this word "empty" in the sanitized version?
            // If the sanitized line has spaces where this word is, it's a COMMENT/STRING.
            const checkPart = cleanLine.substring(startChar, startChar + part1.length).trim();
            if (checkPart === "") continue; 

            const activeScope = findScopeAtLine(rootScope, i);

            if (part2) {
                // CASE: Module.Procedure (e.g., Output.WriteInt)
                const parentSymbol = findSymbol(activeScope, part1, rootScope);
                
                // Color the Module part
                addToken(i, startChar, part1.length, 0); // 0 = namespace

                // Look up the member inside that module's scope
                let targetScopeName = parentSymbol?.type || part1;
                const targetScope = findScopeByName(rootScope, targetScopeName) || externalModules.get(targetScopeName);
                
                if (targetScope) {
                    const sym = targetScope.symbols.get(part2);
                    if (sym) {
                        const tokenType = typeMap[sym.kind] ?? 5;
                        addToken(i, startChar + part1.length + 1, part2.length, tokenType);
                    }
                }
            } else {
                // CASE: Standalone variable/procedure
                const sym = findSymbol(activeScope, part1, rootScope);
                if (sym && typeMap[sym.kind] !== undefined) {
                    addToken(i, startChar, part1.length, typeMap[sym.kind]);
                }
            }
        }
    }

    // This helper creates the "Delta" format VS Code requires
    function addToken(line: number, char: number, length: number, type: number) {
        const deltaLine = line - lastLine;
        const deltaChar = deltaLine === 0 ? char - lastChar : char;
        
        data.push(deltaLine, deltaChar, length, type, 0); // 0 = no modifiers
        
        lastLine = line;
        lastChar = char;
    }

    return { data };
});

connection.onDefinition(async (params): Promise<Definition | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const scopePromise = documentScopes.get(params.textDocument.uri);
    if (!scopePromise) return null;
    const rootScope = await scopePromise;

    const lineText = doc.getText().split(/\r?\n/)[params.position.line];
    const textUpToCursor = lineText.substring(0, params.position.character);
    const textAfterCursor = lineText.substring(params.position.character);
    
    const leftMatch = textUpToCursor.match(/[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/);
    const rightMatch = textAfterCursor.match(/^[a-zA-Z_]\w*/);
    
    if (!leftMatch) return null;
    const word = leftMatch[0] + (rightMatch ? rightMatch[0] : '');

    const activeScope = findScopeAtLine(rootScope, params.position.line);
    const symbol = findSymbol(activeScope, word, rootScope);

    if (!symbol) return null;

    let targetUri = params.textDocument.uri;
    let targetLine = symbol.line;
    let targetChar = symbol.character ?? 0;

    // --- CASE 1: Qualified Names (Output.WriteInt) ---
    if (word.includes('.')) {
        const [modName, symName] = word.split('.');
        const cacheKey = modName.toLowerCase() + '.def';
        const defPath = workspaceFileMap.get(cacheKey);
        const extScope = externalModules.get(cacheKey); // FIX: Added .def

        if (defPath && extScope) {
            const originalSym = extScope.symbols.get(symName);
            return Location.create(
                `file:///${defPath.replace(/\\/g, '/')}`,
                Range.create(
                    originalSym ? originalSym.line : 0,
                    originalSym?.character ?? 0,
                    originalSym ? originalSym.line : 0,
                    (originalSym?.character ?? 0) + symName.length
                )
            );
        }
    } 
    // --- CASE 2: Imported Symbols (WriteInt) ---
    else if (symbol.isImport && symbol.kind !== CompletionItemKind.Module) {
        const modName = symbol.type; 
        if (modName) {
            const cacheKey = modName.toLowerCase() + '.def';
            const extScope = externalModules.get(cacheKey);
            const defPath = workspaceFileMap.get(cacheKey);
            
            if (extScope && defPath) {
                const originalSym = extScope.symbols.get(word);
                if (originalSym) {
                    return Location.create(
                        `file:///${defPath.replace(/\\/g, '/')}`,
                        Range.create(
                            originalSym.line, 
                            originalSym.character ?? 0, 
                            originalSym.line, 
                            (originalSym.character ?? 0) + word.length
                        )
                    );
                }
            }
        }
    }
    // --- CASE 3: Module Names (IMPORT Output) ---
    else if (symbol.kind === CompletionItemKind.Module) {
        const cacheKey = word.toLowerCase() + '.def';
        const defPath = workspaceFileMap.get(cacheKey);
        if (defPath) {
            const fullDefPath = `file:///${defPath.replace(/\\/g, '/')}`;
            const normalizedCurrent = params.textDocument.uri.toLowerCase();
            const normalizedTarget = fullDefPath.toLowerCase();

            // If we are clicking on the IMPORT line itself, go to the file.
            // If we are already in the external file, stay on the local symbol line.
            if (normalizedCurrent.includes(cacheKey)) {
                 return Location.create(params.textDocument.uri, Range.create(symbol.line, symbol.character ?? 0, symbol.line, (symbol.character ?? 0) + word.length));
            } else {
                 return Location.create(fullDefPath, Range.create(0, 0, 0, 0));
            }
        }
    }

    // --- CASE 4: Local Symbols ---
    return Location.create(
        targetUri, 
        Range.create(targetLine, targetChar, targetLine, targetChar + word.split('.').pop()!.length)
    );
});

connection.onImplementation(async (params): Promise<Definition | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const scopePromise = documentScopes.get(params.textDocument.uri);
    if (!scopePromise) return null;
    const rootScope = await scopePromise;

    // 1. Get the word under cursor
    const lineText = doc.getText().split(/\r?\n/)[params.position.line];
    const wordMatch = lineText.substring(0, params.position.character).match(/[a-zA-Z_]\w*$/);
    const wordRest = lineText.substring(params.position.character).match(/^\w*/);
    if (!wordMatch) return null;
    const word = wordMatch[0] + (wordRest ? wordRest[0] : '');

    // 2. Identify the Module Context
    const fileName = path.basename(params.textDocument.uri);
    const moduleName = fileName.replace(/\.(def|mod)$/i, '');

    // 3. Find the .mod file
    const modPath = workspaceFileMap.get(`${moduleName.toLowerCase()}.mod`);
    if (!modPath) return null;

    const targetUri = `file:///${modPath.replace(/\\/g, '/')}`;

    // 4. Load/Parse the .mod file to find the specific symbol line
    // We reuse your loadExternalModule logic but point it to the .mod
    const modScope = await loadExternalModule(moduleName, true);
    
    if (modScope) {
        // Look for the specific procedure/variable implementation
        const symbol = modScope.symbols.get(word);
        if (symbol) {
            const modPath = workspaceFileMap.get(`${moduleName.toLowerCase()}.mod`);
            if (modPath) {
                return Location.create(
                    `file:///${modPath.replace(/\\/g, '/')}`,
                    Range.create(symbol.line, symbol.character ?? 0, symbol.line, (symbol.character ?? 0) + symbol.name.length)
                );
            }
        }
    }
    return null;
});

documents.listen(connection);
connection.listen();