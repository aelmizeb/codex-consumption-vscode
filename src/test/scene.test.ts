import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ratio, scene, sceneAlt } from '../scene'
import { FleetLoop, FleetMemory } from '../types'

const memory: FleetMemory = { entries: ['a', 'b'], readAt: 0 }
const main: FleetLoop = {
  id: 'main',
  type: 'main',
  description: '',
  status: 'running',
  startedAt: 0,
  steps: 3,
  usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 10 },
  tool: 'Bash',
}

test('the comparison row only shows when a comparison label is given, and the scene grows by one row', () => {
  const plain = scene([main], memory, { sessionUsd: 12.4 }, 2.5)
  const compared = scene([main], memory, { sessionUsd: 12.4, compareLabel: 'DEEPSEEK', compareSessionUsd: 0.31, compareWeekUsd: 2.6, compareMonthUsd: 24 }, 2.5)

  assert.ok(!plain.includes('DEEPSEEK'))
  assert.ok(compared.includes('DEEPSEEK SESSION'))
  assert.ok(compared.includes('CODEX / DEEPSEEK'))
  assert.ok(compared.includes('×40'))
  assert.ok(plain.includes('viewBox="0 0 192 77"'), plain.slice(0, 80))
  assert.ok(compared.includes('viewBox="0 0 192 95"'), compared.slice(0, 80))
})

test('the ratio reads ×n, with one decimal below ten', () => {
  assert.equal(ratio(12.4, 0.31), '×40')
  assert.equal(ratio(2, 0.8), '×2.5')
  assert.equal(ratio(2, 0), '--')
  assert.equal(ratio(undefined, 1), '--')
})

test('escapes transcript text, keeps cost amounts readable and uses actual quota window labels', () => {
  const agent: FleetLoop = { ...main, id: 'child', type: '<script>', description: '" onload="bad', tool: '<img src=x>' }
  const svg = scene([main, agent], memory, { sessionUsd: 1, sessionEstimated: true, sessionUnpriced: true,
    monthUsd: 45.08, periodsEstimated: 1, unpriced: 1502,
    quotaLabel: 'QUOTA 15M / 1H', fiveHourPercent: 25, sevenDayPercent: 50 }, 1.4)
  assert.ok(!svg.includes('<script>'))
  assert.ok(!svg.includes('<img'))
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(svg.includes('≈$1.00'))
  assert.ok(svg.includes('≈$45.08'))
  assert.ok(!svg.includes('+?'))
  assert.ok(!svg.includes('+1502'))
  assert.ok(svg.includes('QUOTA 15M / 1H'))
  assert.ok(sceneAlt([main], memory, { contextPercent: 20 }).includes('context 20'))
})
