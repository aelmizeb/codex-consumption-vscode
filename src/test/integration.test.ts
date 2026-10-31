import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptIndex, inWorkspace, newestSession } from '../paths'
import { Session } from '../session'
import { periodStarts, periodTotals, scanPeriodCosts, summarize } from '../costs'
import { LineReader } from '../reader'
import { emptyUsage, totalTokens } from '../types'
import { estimateUsd, readPrices } from '../pricing'
import { parseQuota, quotaFigures } from '../status'

const now = new Date(2026, 9, 31, 12).getTime()
function line(type: string, payload: unknown, at = now) { return JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload }) + '\n' }
function tokens(input: number, output: number, at = now) {
  return line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output },
    last_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output }, model_context_window: 200000 } }, at)
}
async function fixture() { return fs.mkdtemp(path.join(os.tmpdir(), 'codex-consumption-')) }
async function rollout(root: string, id: string, cwd: string, parent?: string, archive = false) {
  const dir = path.join(root, archive ? 'archived_sessions' : 'sessions/2026/10/31')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-${id}.jsonl`)
  await fs.writeFile(file, line('session_meta', { id, cwd, parent_thread_id: parent, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: 'explorer' } } } : 'vscode' }) +
    line('event_msg', { type: 'task_started' }) + line('turn_context', { model: 'gpt-6.1-sol' }) + tokens(100, 20))
  return file
}

test('workspace selection respects directory boundaries and Windows casing', () => {
  assert.equal(inWorkspace('/work/app/src', ['/work/app']), true)
  assert.equal(inWorkspace('/work/app-other', ['/work/app']), false)
  assert.equal(inWorkspace('C:\\WORK\\App\\src', ['c:\\work\\app']), true)
  assert.equal(inWorkspace('/work/app', []), false)
})

test('discovers rollouts and archived children, selects root, updates incrementally and replaces truncated files', async () => {
  const root = await fixture()
  try {
    const file = await rollout(root, 'main-id', '/work/app')
    await rollout(root, 'child-id', '/work/app', 'main-id', true)
    await rollout(root, 'grandchild-id', '/work/other', 'child-id')
    await rollout(root, 'unrelated', '/work/app-other')
    const index = new TranscriptIndex()
    let all = await index.scan(root)
    const candidate = newestSession(all, ['/work/app'], false)!
    assert.equal(candidate.id, 'main-id')
    const session = new Session(candidate)
    await session.refresh(all)
    assert.equal(session.loops(now, 600000).length, 3)
    assert.equal(totalTokens(session.totalUsage()), 360)
    await fs.appendFile(file, tokens(200, 40))
    all = await index.scan(root); await session.refresh(all); await session.refresh(all)
    assert.equal(totalTokens(session.totalUsage()), 480)
    await fs.writeFile(file, line('session_meta', { id: 'main-id', cwd: '/work/app' }) + tokens(10, 2))
    all = await index.scan(root); await session.refresh(all)
    assert.equal(totalTokens(session.main!.usage), 12)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('incremental line reader retains partial UTF-8 and waits for complete lines', async () => {
  const root = await fixture(), file = path.join(root, 'partial.jsonl')
  try {
    const bytes = Buffer.from('hello 🌌\n')
    await fs.writeFile(file, bytes.subarray(0, bytes.length - 3))
    const reader = new LineReader(file), lines: string[] = []
    assert.equal(await reader.read(line => lines.push(line)), 0)
    await fs.appendFile(file, bytes.subarray(bytes.length - 3))
    assert.equal(await reader.read(line => lines.push(line)), 1)
    assert.deepEqual(lines, ['hello 🌌'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('period costs use event dates, include archives, cache unchanged files and replace live families once', async () => {
  const root = await fixture()
  try {
    const file = await rollout(root, 'main-id', '/work/app')
    await rollout(root, 'child-id', '/work/app', 'main-id', true)
    const files = await new TranscriptIndex().scan(root)
    const first = await scanPeriodCosts(files, {}, now)
    const cached = await scanPeriodCosts(files, first.cache, now)
    assert.equal(cached.cache['main-id'], first.cache['main-id'])
    const excluded = periodTotals(first.cache, new Set(['main-id', 'child-id']))
    assert.equal(excluded.month.usd, 0)
    assert.ok(periodTotals(first.cache, new Set()).month.usd > 0)
    const session = new Session(files.find(one => one.id === 'main-id')!)
    await session.refresh(files)
    const live = summarize(session.events(), now)
    assert.equal(live.month.usd, periodTotals(first.cache, new Set()).month.usd)
    await fs.appendFile(file, tokens(200, 40))
    const rescanned = await scanPeriodCosts(await new TranscriptIndex().scan(root), first.cache, now)
    assert.ok(rescanned.cache['main-id']!.month.usd > first.cache['main-id']!.month.usd)
    const prior = periodStarts(now).month - 1
    const dated = summarize([{ at: prior, model: 'gpt-6.1-sol', usage: { ...emptyUsage(), input: 100 } }], now)
    assert.ok(dated.session.usd > 0); assert.equal(dated.month.usd, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('API estimates mark unknown models and accept custom prices without charging reasoning twice', () => {
  const usage = { input: 500000, cacheRead: 500000, output: 100000, reasoning: 50000, cacheWrite: 0 }
  assert.equal(estimateUsd(usage, 'gpt-6.1-sol'), 2.05)
  assert.equal(estimateUsd(usage, 'unknown'), undefined)
  const custom = readPrices({ unknown: { input: 1, cacheRead: 0.1, output: 5 }, invalid: { input: -1, cacheRead: 0, output: 1 } })
  assert.equal(estimateUsd(usage, 'unknown', custom), 1.05)
  assert.equal(custom.invalid, undefined)
  assert.equal(summarize([{ at: now, model: 'unknown', usage }], now).session.unpriced, 1)
})

test('quota windows expire and retain their actual durations; unrelated model buckets are ignored', () => {
  const q = parseQuota({ primary: { used_percent: 25, window_minutes: 300, resets_at: (now + 60000) / 1000 },
    secondary: { used_percent: 50, window_minutes: 10080, resets_at: (now + 86400000) / 1000 } }, now)
  assert.equal(quotaFigures(q, now).fiveHourPercent, 25)
  assert.equal(quotaFigures(q, now).quotaLabel, 'QUOTA 5H / 7D')
  assert.equal(quotaFigures(q, now + 60001).fiveHourPercent, undefined)
  assert.equal(quotaFigures(q, now + 16 * 60000).sevenDayPercent, undefined)
  assert.equal(parseQuota({ limit_id: 'other', primary: { used_percent: 1, window_minutes: 60 } }, now), undefined)
  assert.equal(parseQuota({ primary: { used_percent: NaN, window_minutes: 60 } }, now), undefined)
})
