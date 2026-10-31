import { FleetStatus, FleetUsage, addUsage, emptyUsage, isRecord, num, totalTokens } from './types'
import { parseQuota, Quota } from './status'

export type UsageEvent = { at: number; model: string; usage: FleetUsage }
export type SpawnInfo = { type: string; description: string; startedAt: number; status: FleetStatus }

/** Codex input includes cached input, and output includes reasoning. Keep both disjoint. */
export function toUsage(raw: unknown): FleetUsage {
  if (!isRecord(raw)) return emptyUsage()
  const input = num(raw.input_tokens), cacheRead = Math.min(input, num(raw.cached_input_tokens))
  const cacheWrite = Math.min(input - cacheRead, num(raw.cache_write_input_tokens))
  return { input: input - cacheRead - cacheWrite, cacheRead, cacheWrite,
    output: num(raw.output_tokens), reasoning: Math.min(num(raw.output_tokens), num(raw.reasoning_output_tokens)) }
}
function difference(current: FleetUsage, previous: FleetUsage): FleetUsage {
  return { input: Math.max(0, current.input - previous.input), output: Math.max(0, current.output - previous.output),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead), cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    reasoning: Math.max(0, current.reasoning - previous.reasoning) }
}
function objectJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') { try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) return parsed } catch {} }
  return {}
}

/** Follows one rollout. Both token record formats share cumulative counters, preventing double counts. */
export class LoopTracker {
  model?: string
  provider?: string
  status: FleetStatus = 'idle'
  tool?: string
  steps = 0
  startedAt = 0
  lastEventAt = 0
  contextTokens?: number
  contextWindow?: number
  quota?: Quota
  usage = emptyUsage()
  readonly events: UsageEvent[] = []
  readonly agents = new Map<string, SpawnInfo>()
  private counter = emptyUsage()
  private pending = new Map<string, { name: string; args: Record<string, unknown> }>()
  private responses = new Set<string>()
  private completedCalls = new Set<string>()
  private inherited = false
  private createdAt = 0

  apply(line: string) {
    let row: unknown
    try { row = JSON.parse(line) } catch { return }
    if (!isRecord(row) || !isRecord(row.payload)) return
    const p = row.payload
    const parsedAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    const at = Number.isFinite(parsedAt) ? parsedAt : this.lastEventAt
    if (!this.startedAt) this.startedAt = at
    this.lastEventAt = Math.max(this.lastEventAt, at)
    if (row.type === 'session_meta') {
      this.createdAt = at
      if (typeof p.model_provider === 'string') this.provider = p.model_provider
      if (num(p.context_window) > 0) this.contextWindow = num(p.context_window)
      // Forked history is replayed before the first locally started task.
      this.inherited = typeof p.forked_from_id === 'string' || num(p.subagent_history_start_ordinal) > 0
      return
    }
    // Forks can replay parent events with their original timestamps. They provide only a baseline.
    if (at < this.createdAt) {
      if (row.type === 'token_usage_record' && isRecord(p.thread_token_usage)) this.counter = toUsage(p.thread_token_usage)
      if (row.type === 'event_msg' && p.type === 'token_count' && isRecord(p.info) && isRecord(p.info.total_token_usage)) this.counter = toUsage(p.info.total_token_usage)
      return
    }
    if (row.type === 'turn_context') {
      if (typeof p.model === 'string') this.model = p.model
      return
    }
    if (row.type === 'token_usage_record') {
      if (typeof p.response_id === 'string' && this.responses.has(p.response_id)) return
      if (typeof p.response_id === 'string') this.responses.add(p.response_id)
      this.tokens(p.thread_token_usage, p.usage, at)
    } else if (row.type === 'event_msg') {
      switch (p.type) {
        case 'token_count': {
          const info = isRecord(p.info) ? p.info : {}
          if (num(info.model_context_window) > 0) this.contextWindow = num(info.model_context_window)
          if (isRecord(info.last_token_usage)) this.contextTokens = totalTokens(toUsage(info.last_token_usage))
          if (isRecord(info.total_token_usage)) this.tokens(info.total_token_usage, info.last_token_usage, at)
          const quota = parseQuota(p.rate_limits, at)
          if (quota) this.quota = quota
          break
        }
        case 'task_started':
        case 'turn_started':
          this.inherited = false
          this.status = 'running'; this.tool = undefined; this.pending.clear()
          if (num(p.model_context_window) > 0) this.contextWindow = num(p.model_context_window)
          break
        case 'user_message': this.status = 'running'; break
        case 'task_complete':
        case 'task_completed':
        case 'turn_completed': this.finish('completed'); break
        case 'turn_aborted': this.finish('killed'); break
        case 'error': this.finish('failed'); break
        case 'agent_message': if (p.phase === 'final_answer') this.finish('completed'); break
      }
    } else if (row.type === 'response_item' && !this.inherited) this.item(p, at)
  }

  private tokens(raw: unknown, last: unknown, at: number) {
    if (!isRecord(raw)) return
    const current = toUsage(raw)
    // Replayed fork counters establish a baseline; only local work belongs to this thread.
    if (this.inherited) { this.counter = current; return }
    // A lower counter is a stale/replayed event. Session replacement is reset by Session.refresh.
    if (totalTokens(current) <= totalTokens(this.counter)) return
    const delta = difference(current, this.counter)
    this.counter = current
    this.usage = addUsage(this.usage, delta)
    if (isRecord(last)) this.contextTokens = totalTokens(toUsage(last))
    this.steps += 1
    this.events.push({ at, model: this.provider && this.provider !== 'openai' ? `${this.provider}/${this.model ?? 'unknown'}` : this.model ?? 'unknown', usage: delta })
  }

  private finish(status: FleetStatus) { this.status = status; this.tool = undefined; this.pending.clear() }

  private item(p: Record<string, unknown>, at: number) {
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.call_id === 'string') {
      if (this.completedCalls.has(p.call_id)) return
      const name = typeof p.name === 'string' ? p.name : 'tool'
      const args = objectJson(p.arguments ?? p.input)
      this.pending.set(p.call_id, { name, args })
      this.tool = name; this.status = 'running'
      if (/request_user_input/.test(name)) this.status = 'waiting'
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string') {
      const call = this.pending.get(p.call_id)
      const output = objectJson(p.output)
      if (call && /(?:spawn_agent|fork_agent)$/.test(call.name)) {
        const id = typeof output.agent_id === 'string' ? output.agent_id : typeof output.id === 'string' ? output.id : undefined
        if (id) this.agents.set(id, { type: String(call.args.agent_type ?? call.args.task_name ?? 'agent'),
          description: typeof call.args.message === 'string' ? call.args.message.slice(0, 160) : '', startedAt: at, status: 'pending' })
      }
      if (call && /(?:close_agent|interrupt_agent)$/.test(call.name)) {
        const id = call.args.id ?? call.args.agent_id ?? call.args.target
        if (typeof id === 'string') { const agent = this.agents.get(id); if (agent) agent.status = 'killed' }
      }
      this.pending.delete(p.call_id); this.completedCalls.add(p.call_id)
      const remaining = [...this.pending.values()].at(-1)
      this.tool = remaining?.name
      this.status = remaining && /request_user_input/.test(remaining.name) ? 'waiting' : 'running'
    } else if (p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer') this.finish('completed')
  }
}
