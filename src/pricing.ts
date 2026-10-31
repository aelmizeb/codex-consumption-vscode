import { FleetUsage, isRecord, num } from './types'

export type Price = { input: number; output: number; cacheRead: number; cacheWrite?: number }
export type Prices = Record<string, Price>
/** Standard, short-context API rates checked 2026-10-31. See README for sources and limitations. */
export const PRICES: Prices = {
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1 },
  'gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4 },
  'gpt-5.6': { input: 4, output: 20, cacheRead: 0.4 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175 },
}
export function normalizeModel(model: string) { return model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '') }
export function readPrices(value: unknown): Prices {
  if (!isRecord(value)) return {}
  const result: Prices = {}
  for (const [key, p] of Object.entries(value)) {
    if (!isRecord(p) || !['input', 'output', 'cacheRead'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0)) continue
    result[normalizeModel(key)] = { input: num(p.input), output: num(p.output), cacheRead: num(p.cacheRead),
      cacheWrite: typeof p.cacheWrite === 'number' && Number.isFinite(p.cacheWrite) && p.cacheWrite >= 0 ? p.cacheWrite : undefined }
  }
  return result
}
export function priceFor(model: string | undefined, overrides: Prices = {}): Price | undefined {
  if (!model) return undefined
  const key = normalizeModel(model)
  return overrides[key] ?? PRICES[key]
}
export function costAt(usage: FleetUsage, price: Price): number {
  return (usage.input * price.input + usage.cacheRead * price.cacheRead + usage.output * price.output +
    usage.cacheWrite * (price.cacheWrite ?? price.input * 1.25)) / 1_000_000
}
export function estimateUsd(usage: FleetUsage, model: string | undefined, overrides: Prices = {}): number | undefined {
  const price = priceFor(model, overrides)
  return price ? costAt(usage, price) : undefined
}
// Preserves the comparison offered by the reference extension; configurable independently.
export const COMPARE_PRICE: Price = { input: 1.32, output: 3.96, cacheRead: 0.044 }
export const COMPARE_LABEL = 'DEEPSEEK'
export function compareUsd(usage: FleetUsage, price: Price = COMPARE_PRICE) {
  return costAt(usage, { ...price, cacheWrite: price.input })
}
