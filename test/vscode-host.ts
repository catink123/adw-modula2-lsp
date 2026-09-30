// Runs inside a real VS Code Extension Host (see README). Opens main/MOD/DrawDoc.mod of the opened project and exercises the providers
// through VS Code's command API, which goes client -> language server -> client.
import * as path from 'path';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const doc = await vscode.workspace.openTextDocument(path.join(root, 'main', 'MOD', 'DrawDoc.mod'));
  await vscode.window.showTextDocument(doc);
  const lines: string[] = [];
  const check = (name: string, ok: boolean, info: string) => { lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${info}`); if (!ok) process.exitCode = 1; };
  check('language id', doc.languageId === 'modula2', doc.languageId);

  const ext = vscode.extensions.getExtension('catink123.adw-modula2-lsp')!;
  await ext.activate();
  const pos = doc.positionAt(doc.getText().indexOf('ActDevice'));

  let defs: vscode.Location[] = [];
  for (let i = 0; i < 60 && !defs.length; i++) {
    defs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, pos)) ?? [];
    if (!defs.length) await new Promise(r => setTimeout(r, 500));
  }
  check('definition', defs.length === 1 && /grout2\.def$/i.test(defs[0].uri.fsPath), defs.map(d => `${path.basename(d.uri.fsPath)}:${d.range.start.line + 1}`).join(','));

  const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
  check('outline', syms?.[0]?.name === 'DrawDoc' && syms[0].children.length > 50, `${syms?.[0]?.name} ${syms?.[0]?.children.length}`);

  const hov = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
  const hoverText = hov?.map(h => h.contents.map(c => (c as vscode.MarkdownString).value ?? String(c)).join(' ')).join(' ') ?? '';
  check('hover', hoverText.includes('ActDevice'), hoverText.slice(0, 80).replace(/\n/g, ' '));

  const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, pos);
  check('references', (refs?.length ?? 0) > 5, `${refs?.length}`);

  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
  check('semantic tokens', (tokens?.data.length ?? 0) > 1000, `${tokens?.data.length}`);

  const comp = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(doc.getText().indexOf('GrOut2.') + 7), '.');
  check('completion', (comp?.items.length ?? 0) > 20, `${comp?.items.length} items`);

  await new Promise(r => setTimeout(r, 1500));
  const diags = vscode.languages.getDiagnostics(doc.uri).filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
  check('diagnostics', diags.length === 0, `${diags.length} errors/warnings`);

  await vscode.commands.executeCommand('modula2.switchDefMod');
  const active = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
  check('switch DEF/MOD', /drawdoc\.def$/i.test(active), path.basename(active));

  const out = lines.join('\n');
  require('fs').writeFileSync(process.env.M2_HOST_RESULT ?? path.join(root, '..', 'm2-host-result.txt'), out);
}
