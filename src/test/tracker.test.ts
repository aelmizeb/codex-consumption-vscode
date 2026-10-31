import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoopTracker, toUsage } from '../tracker'
import { totalTokens } from '../types'

const at = '2026-10-31T10:00:00.000Z'
const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: at, payload })
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: output / 2 })
const count = (total: unknown, last: unknown = total) => row('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 } })

test('cached input and reasoning are subsets; malformed token counts are sanitized', () => {
  const value = toUsage(usage(100, 40, 20))
  assert.equal(value.input, 60)
  assert.equal(value.reasoning, 10)
  assert.equal(totalTokens(value), 120)
  assert.equal(totalTokens(toUsage({ input_tokens: -1, cached_input_tokens: Infinity, output_tokens: NaN })), 0)
})

test('dual record formats and repeated quota-only records count cumulative usage once', () => {
  const t = new LoopTracker()
  t.apply(row('turn_context', { model: 'gpt-6.1-sol' }))
  t.apply(row('token_usage_record', { response_id: 'r1', thread_token_usage: usage(100, 40, 20), usage: usage(100, 40, 20) }))
  t.apply(count(usage(100, 40, 20)))
  t.apply(count(usage(100, 40, 20)))
  t.apply(row('token_usage_record', { response_id: 'r2', thread_token_usage: usage(300, 100, 50), usage: usage(200, 60, 30) }))
  t.apply(count(usage(300, 100, 50), usage(200, 60, 30)))
  assert.equal(totalTokens(t.usage), 350)
  assert.equal(t.steps, 2)
  assert.equal(t.contextTokens, 230)
  assert.equal(t.contextWindow, 200000)
  assert.equal(t.events.length, 2)
})

test('model changes apply only to new cumulative deltas and unknown providers retain their identity', () => {
  const t = new LoopTracker()
  t.apply(row('session_meta', { model_provider: 'custom' }))
  t.apply(row('turn_context', { model: 'gpt-6.1-sol' }))
  t.apply(count(usage(100, 40, 20)))
  t.apply(row('turn_context', { model: 'other' }))
  t.apply(count(usage(200, 80, 40)))
  assert.deepEqual(t.events.map(e => [e.model, totalTokens(e.usage)]), [['custom/gpt-6.1-sol', 120], ['custom/other', 120]])
})

test('forked historical counters establish a baseline, then local work is counted', () => {
  const t = new LoopTracker()
  t.apply(row('session_meta', { subagent_history_start_ordinal: 5 }))
  t.apply(count(usage(100, 40, 20)))
  t.apply(row('event_msg', { type: 'task_started' }))
  t.apply(count(usage(200, 80, 40), usage(100, 40, 20)))
  assert.equal(totalTokens(t.usage), 120)
})

test('tracks parallel tools, waits for input, recognizes spawned agents and ends turns', () => {
  const t = new LoopTracker()
  const tool = (id: string, name: string, args = {}) => t.apply(row('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }))
  const output = (id: string, value = {}) => t.apply(row('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify(value) }))
  tool('a', 'exec_command'); tool('b', 'request_user_input')
  assert.equal(t.status, 'waiting')
  output('b'); assert.equal(t.tool, 'exec_command')
  tool('spawn', 'spawn_agent', { agent_type: 'explorer', message: 'Inspect parser' })
  output('spawn', { agent_id: 'child' })
  assert.equal(t.agents.get('child')?.description, 'Inspect parser')
  output('a'); assert.equal(t.tool, undefined)
  t.apply(row('event_msg', { type: 'task_complete' }))
  assert.equal(t.status, 'completed')
  t.apply(row('event_msg', { type: 'task_started' }))
  t.apply(row('event_msg', { type: 'turn_aborted' }))
  assert.equal(t.status, 'killed')
  t.apply('broken {')
  assert.equal(t.status, 'killed')
})
