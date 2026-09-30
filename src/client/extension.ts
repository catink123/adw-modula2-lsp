// VS Code client for the Modula-2 language server.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

function createClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--max-old-space-size=4096'] } },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6019', '--max-old-space-size=4096'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'modula2', scheme: 'file' }, { language: 'modula2', scheme: 'untitled' }],
    synchronize: {
      configurationSection: 'modula2',
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{def,mod,DEF,MOD,Def,Mod,err,ERR}'),
    },
    outputChannelName: 'Modula-2',
  };
  return new LanguageClient('modula2', 'Modula-2 Language Server', serverOptions, clientOptions);
}

export async function activate(context: vscode.ExtensionContext) {
  client = createClient(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('modula2.switchDefMod', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !client) return;
      const target = await client.sendRequest<string | null>('modula2/counterpart', { uri: editor.document.uri.toString() });
      if (!target) {
        vscode.window.showInformationMessage('No matching DEFINITION/IMPLEMENTATION module found.');
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.parse(target), { viewColumn: editor.viewColumn });
    }),
    vscode.commands.registerCommand('modula2.reindex', async () => {
      if (!client) return;
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Modula-2: re-indexing' },
        () => client!.sendRequest<{ files: number }>('modula2/reindex'),
      );
      vscode.window.showInformationMessage(`Modula-2: indexed ${r.files} files.`);
    }),
    vscode.commands.registerCommand('modula2.restartServer', async () => {
      if (!client) return;
      await client.restart();
    }),
    vscode.commands.registerCommand('modula2.showOutput', () => client?.outputChannel.show()),
  );

  await client.start();
}

export async function deactivate() {
  await client?.stop();
}
