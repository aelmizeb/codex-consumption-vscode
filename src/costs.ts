import { createReadStream } from 'node:fs'
import * as readline from 'node:readline'
import { Rollout } from './paths'
import { Prices, Price, COMPARE_PRICE, compareUsd, estimateUsd } from './pricing'
import { LoopTracker, UsageEvent } from './tracker'
import { totalTokens } from './types'

export function periodStarts(now: number) {
  const d = new Date(now)
  return { week: new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime(),
    month: new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
}
export type Totals = { usd: number; unpriced: number; compare: number }
export type CostSummary = { session: Totals; week: Totals; month: Totals }
export function summarize(events: readonly UsageEvent[], now: number, prices: Prices = {}, comparison: Price = COMPARE_PRICE): CostSummary {
  const starts = periodStarts(now)
  const blank = (): Totals => ({ usd: 0, unpriced: 0, compare: 0 })
  const result = { session: blank(), week: blank(), month: blank() }
  for (const event of events) {
    if (!totalTokens(event.usage)) continue
    const usd = estimateUsd(event.usage, event.model, prices)
    const targets = [result.session]
    if (event.at >= starts.week && event.at <= now) targets.push(result.week)
    if (event.at >= starts.month && event.at <= now) targets.push(result.month)
    for (const target of targets) { target.usd += usd ?? 0; target.unpriced += usd === undefined ? 1 : 0; target.compare += compareUsd(event.usage, comparison) }
  }
  return result
}
export type TranscriptCacheEntry = { size: number; mtimeMs: number; ino: number; signature: string; week: Totals; month: Totals }
export type TranscriptCache = Record<string, TranscriptCacheEntry>
export async function readTranscript(file: string): Promise<LoopTracker> {
  const tracker = new LoopTracker()
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try { for await (const line of lines) tracker.apply(line) }
  finally { lines.close(); stream.destroy() }
  return tracker
}
/** Cache period totals, never conversation text. The live family replaces its cached rows at draw time. */
export async function scanPeriodCosts(files: readonly Rollout[], cache: TranscriptCache, now: number, prices: Prices = {}, comparison: Price = COMPARE_PRICE) {
  const signature = JSON.stringify([periodStarts(now), prices, comparison])
  const next: TranscriptCache = {}, failed: string[] = []
  for (const file of files) {
    const known = cache[file.id]
    if (known && known.size === file.size && known.mtimeMs === file.mtimeMs && known.ino === file.ino && known.signature === signature) { next[file.id] = known; continue }
    try {
      const totals = summarize((await readTranscript(file.file)).events, now, prices, comparison)
      next[file.id] = { size: file.size, mtimeMs: file.mtimeMs, ino: file.ino, signature, week: totals.week, month: totals.month }
    } catch (error) { failed.push(`${file.id}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { cache: next, failed }
}
export function periodTotals(cache: TranscriptCache, exclude: ReadonlySet<string>) {
  const week: Totals = { usd: 0, unpriced: 0, compare: 0 }, month = { ...week }
  for (const [id, entry] of Object.entries(cache)) {
    if (exclude.has(id)) continue
    for (const [target, source] of [[week, entry.week], [month, entry.month]] as const) {
      target.usd += source.usd; target.unpriced += source.unpriced; target.compare += source.compare
    }
  }
  return { week, month }
}
