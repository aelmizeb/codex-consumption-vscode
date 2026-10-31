import * as vscode from 'vscode'
import { Monitor } from './monitor'
import { FleetViewProvider } from './panel'

const VIEW_OWN = 'codexConsumption.fleet'
const VIEW_CODEX = 'codexConsumption.fleetInCodex'
function dock(): 'codex' | 'own' {
  return vscode.workspace.getConfiguration('codexConsumption').get<string>('dock') !== 'own' && vscode.extensions.getExtension('openai.chatgpt') ? 'codex' : 'own'
}
function applyDock() { void vscode.commands.executeCommand('setContext', 'codexConsumption.dock', dock()) }
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Codex Consumption')
  const provider = new FleetViewProvider(context.extensionUri)
  const monitor = new Monitor(context, log, snapshot => provider.update(snapshot))
  applyDock()
  context.subscriptions.push(log, monitor,
    vscode.window.registerWebviewViewProvider(VIEW_OWN, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(VIEW_CODEX, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.extensions.onDidChange(applyDock),
    vscode.workspace.onDidChangeWorkspaceFolders(() => monitor.restart()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codexConsumption')) { applyDock(); monitor.restart() }
    }),
    vscode.commands.registerCommand('codexConsumption.open', () => vscode.commands.executeCommand(`${dock() === 'codex' ? VIEW_CODEX : VIEW_OWN}.focus`)),
    vscode.commands.registerCommand('codexConsumption.refresh', () => monitor.refresh()),
    vscode.commands.registerCommand('codexConsumption.rescanCosts', () => monitor.rescanCosts()),
    vscode.commands.registerCommand('codexConsumption.showLog', () => log.show()))
  monitor.start()
}
export function deactivate() {}
