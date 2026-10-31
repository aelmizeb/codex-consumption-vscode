import * as vscode from 'vscode'
import { periodStarts, periodTotals, scanPeriodCosts, summarize, TranscriptCache } from './costs'
import { readMemory } from './memory'
import { configDir, newestSession, TranscriptIndex } from './paths'
import { COMPARE_LABEL, COMPARE_PRICE, readPrices } from './pricing'
import { Session } from './session'
import { quotaFigures } from './status'
import { FleetMemory, FleetSnapshot } from './types'

const CACHE_KEY = 'codexConsumption.costCache-v1'
export class Monitor implements vscode.Disposable {
  private timer?: ReturnType<typeof setInterval>
  private index = new TranscriptIndex()
  private session?: Session
  private memory: FleetMemory = { entries: [], readAt: 0 }
  private cache: TranscriptCache = {}
  private lastScan = 0
  private scannedPeriod = ''
  private busy = false
  private generation = 0
  private lastJson = ''
  private forceScan = true
  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel,
    private readonly publish: (snapshot: FleetSnapshot) => void) {}
  private get config() { return vscode.workspace.getConfiguration('codexConsumption') }
  get root() { return configDir(this.config.get<string>('configDir')) }
  start() {
    this.stop()
    this.cache = this.context.globalState.get<TranscriptCache>(CACHE_KEY) ?? {}
    this.log.appendLine(`Codex home: ${this.root}`)
    void this.tick()
    this.timer = setInterval(() => void this.tick(), Math.max(1, this.config.get<number>('pollSeconds') ?? 2) * 1000)
  }
  private stop() { this.generation++; if (this.timer) clearInterval(this.timer); this.timer = undefined }
  restart() { this.session = undefined; this.index = new TranscriptIndex(); this.memory = { entries: [], readAt: 0 }; this.lastJson = ''; this.forceScan = true; this.start() }
  dispose() { this.stop() }
  async refresh() { this.lastJson = ''; await this.tick() }
  async rescanCosts() { this.forceScan = true; await this.tick() }
  private async tick() {
    if (this.busy) return
    this.busy = true
    const generation = this.generation
    try {
      const now = Date.now(), config = this.config, root = this.root
      const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
      const prices = readPrices(config.get('customPrices'))
      const comparison = readPrices({ compare: config.get('comparisonPrice') }).compare ?? COMPARE_PRICE
      const files = await this.index.scan(root)
      if (generation !== this.generation) return
      const candidate = newestSession(files, folders, config.get<string>('scope') === 'all')
      if (candidate && (candidate.id !== this.session?.id || candidate.file !== this.session?.descriptor.file)) {
        this.session = new Session(candidate)
        this.forceScan = true
        this.log.appendLine(`Following ${candidate.id} (${candidate.cwd})`)
      } else if (!candidate) this.session = undefined
      if (this.session) await this.session.refresh(files)
      if (generation !== this.generation) return
      if (now - this.memory.readAt > 60_000) this.memory = await readMemory(root, now)
      const period = JSON.stringify(periodStarts(now))
      if (this.forceScan || now - this.lastScan >= 5 * 60_000 || period !== this.scannedPeriod) {
        this.forceScan = false
        const result = await scanPeriodCosts(files, this.cache, now, prices, comparison)
        if (generation !== this.generation) return
        this.cache = result.cache; this.lastScan = now; this.scannedPeriod = period
        await this.context.globalState.update(CACHE_KEY, this.cache)
        this.log.appendLine(`Scanned ${files.length} rollouts${result.failed.length ? '; failures: ' + result.failed.slice(0, 5).join(' | ') : ''}`)
      }
      const session = this.session, main = session?.main
      const live = summarize(session?.events() ?? [], now, prices, comparison)
      const periods = periodTotals(this.cache, new Set(session?.entries.keys()))
      const forced = config.get<number>('contextWindow') ?? 0
      const window = forced > 0 ? forced : main?.contextWindow
      const contextPercent = window && main?.contextTokens !== undefined ? Math.min(100, main.contextTokens / window * 100) : undefined
      const quota = [...session?.entries.values() ?? []].map(one => one.tracker.quota).filter(one => one !== undefined).sort((a, b) => b.at - a.at)[0]
      const snapshot: FleetSnapshot = {
        loops: session?.loops(now, Math.max(30, config.get<number>('idleAfterSeconds') ?? 600) * 1000) ?? [],
        memory: this.memory, sessionId: session?.id, project: session?.project,
        figures: { contextPercent, sessionUsd: session ? live.session.usd : undefined, sessionEstimated: true,
          sessionUnpriced: live.session.unpriced > 0,
          weekUsd: periods.week.usd + live.week.usd, monthUsd: periods.month.usd + live.month.usd,
          periodsEstimated: 1, unpriced: periods.month.unpriced + live.month.unpriced,
          ...quotaFigures(quota, now) }
      }
      if (config.get<boolean>('compareWithDeepSeek')) Object.assign(snapshot.figures, { compareLabel: COMPARE_LABEL,
        compareSessionUsd: session ? live.session.compare : undefined, compareWeekUsd: periods.week.compare + live.week.compare,
        compareMonthUsd: periods.month.compare + live.month.compare })
      if (generation !== this.generation) return
      const json = JSON.stringify(snapshot)
      if (json !== this.lastJson) { this.lastJson = json; this.publish(snapshot) }
    } catch (error) { this.log.appendLine(`Read failed: ${error instanceof Error ? error.message : String(error)}`) }
    finally { this.busy = false }
  }
}
