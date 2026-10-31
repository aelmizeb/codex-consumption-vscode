import * as vscode from 'vscode'
import { scene, sceneAlt } from './scene'
import { FleetSnapshot, MAIN, isOver } from './types'

type Size = { width: number; height: number }

/**
 * The panel: a webview that shows nothing but the SVG scene, at the size the side bar leaves it.
 * The webview measures its box and reports it; the extension draws the scene at the right ratio and sends it.
 */
export class FleetViewProvider implements vscode.WebviewViewProvider {
  private readonly views = new Map<vscode.WebviewView, Size>()
  private snapshot?: FleetSnapshot

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }
    view.webview.html = this.html(view.webview)
    this.views.set(view, { width: 560, height: 220 })

    view.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== 'object' || message === null) return

      const data = message as { type?: string; width?: number; height?: number }

      if (data.type === 'size' && typeof data.width === 'number' && typeof data.height === 'number' && data.width > 0 && data.height > 0) {
        this.views.set(view, { width: data.width, height: data.height })
        this.render(view)
      } else if (data.type === 'ready') {
        this.render(view)
      }
    })
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render(view)
    })
    view.onDidDispose(() => this.views.delete(view))
    this.render(view)
  }

  update(snapshot: FleetSnapshot) {
    this.snapshot = snapshot

    for (const view of this.views.keys()) this.render(view)
  }

  private render(view: vscode.WebviewView) {
    const size = this.views.get(view)

    if (!size || !view.visible) return

    const snapshot = this.snapshot ?? { loops: [], memory: { entries: [], readAt: 0 }, figures: {} }
    const aspect = Math.max(1.4, size.width / size.height)
    const svg = scene(snapshot.loops, snapshot.memory, snapshot.figures, aspect)
    const alt = sceneAlt(snapshot.loops, snapshot.memory, snapshot.figures)
    const agents = snapshot.loops.filter(one => one.id !== MAIN)
    const active = agents.filter(one => !isOver(one.status)).length

    view.description = snapshot.sessionId ? `${snapshot.sessionId.slice(0, 8)} · ${active}/${agents.length} agents` : 'no session'
    void view.webview.postMessage({ type: 'scene', svg, alt })
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex Consumption</title>
<style nonce="${nonce}">
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1c1656; }
  #scene { width: 100%; height: 100%; display: block; }
  #scene svg { width: 100%; height: 100%; display: block; }
  #empty { color: #b8b0e0; font: 12px monospace; padding: 12px; }
</style>
</head>
<body>
<div id="scene" role="img" aria-label="Codex Consumption"><div id="empty">Waiting for a Codex session…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const scene = document.getElementById('scene');
  let last = { width: 0, height: 0 };
  function measure() {
    const width = Math.round(scene.clientWidth || window.innerWidth);
    const height = Math.round(scene.clientHeight || window.innerHeight);
    if (width > 0 && height > 0 && (width !== last.width || height !== last.height)) {
      last = { width, height };
      vscode.postMessage({ type: 'size', width, height });
    }
  }
  new ResizeObserver(measure).observe(document.body);
  window.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'scene' && typeof data.svg === 'string') {
      scene.innerHTML = data.svg;
      scene.setAttribute('aria-label', data.alt || 'Codex Consumption');
      scene.title = data.alt || '';
    }
  });
  measure();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`
  }
}
