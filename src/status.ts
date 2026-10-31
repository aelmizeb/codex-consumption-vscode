import { isRecord } from './types'

export type QuotaWindow = { used: number; minutes: number; resetsAt?: number }
export type Quota = { at: number; primary?: QuotaWindow; secondary?: QuotaWindow }
function windowOf(raw: unknown): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined
  const used = raw.used_percent ?? raw.usedPercent
  const minutes = raw.window_minutes ?? raw.windowDurationMins
  const reset = raw.resets_at ?? raw.resetsAt
  if (typeof used !== 'number' || !Number.isFinite(used) || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return undefined
  return { used: Math.max(0, Math.min(100, used)), minutes,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) ? reset * 1000 : undefined }
}
export function parseQuota(raw: unknown, at: number): Quota | undefined {
  if (!isRecord(raw)) return undefined
  // Other model buckets must not replace Codex's subscription quota.
  if (raw.limit_id && raw.limit_id !== 'codex') return undefined
  const primary = windowOf(raw.primary), secondary = windowOf(raw.secondary)
  return primary || secondary ? { at, primary, secondary } : undefined
}
export function windowLabel(minutes: number) {
  return minutes % 1440 === 0 ? `${minutes / 1440}D` : minutes % 60 === 0 ? `${minutes / 60}H` : `${minutes}M`
}
export function quotaFigures(quota: Quota | undefined, now: number) {
  const fresh = (w: QuotaWindow | undefined) => w && now - (quota?.at ?? 0) <= 15 * 60_000 && (!w.resetsAt || now < w.resetsAt) ? w : undefined
  const primary = fresh(quota?.primary), secondary = fresh(quota?.secondary)
  return { fiveHourPercent: primary?.used, sevenDayPercent: secondary?.used,
    quotaLabel: quota ? `QUOTA ${quota.primary ? windowLabel(quota.primary.minutes) : '--'} / ${quota.secondary ? windowLabel(quota.secondary.minutes) : '--'}` : 'QUOTA',
    quotaAt: quota?.at }
}
