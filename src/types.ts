export type FleetStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** Disjoint token categories. Reasoning is already included in output. */
export type FleetUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
export type FleetLoop = {
  id: string; type: string; description: string; status: FleetStatus
  startedAt: number; endedAt?: number; steps: number; usage: FleetUsage
  tool?: string; parentId?: string; model?: string
}
export type FleetMemory = { entries: string[]; path?: string; readAt: number }
export type Figures = {
  contextPercent?: number; sessionUsd?: number; sessionEstimated?: boolean
  weekUsd?: number; monthUsd?: number; periodsEstimated?: number; unpriced?: number
  sessionUnpriced?: boolean
  fiveHourPercent?: number; sevenDayPercent?: number; quotaLabel?: string; quotaAt?: number
  compareLabel?: string; compareSessionUsd?: number; compareWeekUsd?: number; compareMonthUsd?: number
}
export type FleetSnapshot = {
  loops: FleetLoop[]; memory: FleetMemory; figures: Figures; sessionId?: string; project?: string
}
export const MAIN = 'main'
export function emptyUsage(): FleetUsage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
export function addUsage(a: FleetUsage, b: FleetUsage): FleetUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning }
}
export function totalTokens(u: FleetUsage) { return u.input + u.output + u.cacheRead + u.cacheWrite }
export function isOver(status: FleetStatus) { return status === 'completed' || status === 'failed' || status === 'killed' }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
