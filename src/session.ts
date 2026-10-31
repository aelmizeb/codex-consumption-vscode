import { promises as fs } from 'node:fs'
import { Rollout, descendants } from './paths'
import { LineReader } from './reader'
import { LoopTracker, UsageEvent } from './tracker'
import { FleetLoop, FleetUsage, MAIN, addUsage, emptyUsage, isOver } from './types'

type Entry = { reader: LineReader; tracker: LoopTracker; descriptor: Rollout; size: number; mtimeMs: number }
export class Session {
  readonly entries = new Map<string, Entry>()
  constructor(readonly descriptor: Rollout) {}
  get id() { return this.descriptor.id }
  get project() { return this.descriptor.cwd }
  get main() { return this.entries.get(this.id)?.tracker }
  async refresh(all: readonly Rollout[]) {
    const related = descendants(this.descriptor, all)
    // Spawn responses can identify children whose older metadata has no parent field.
    for (const id of this.main?.agents.keys() ?? []) {
      const child = all.find(one => one.id === id)
      if (child && !related.some(one => one.id === id)) related.push(...descendants(child, all))
    }
    for (const descriptor of related) {
      let entry = this.entries.get(descriptor.id)
      if (!entry || entry.descriptor.file !== descriptor.file || entry.descriptor.ino !== descriptor.ino || descriptor.size < entry.size || (descriptor.size === entry.size && descriptor.mtimeMs !== entry.mtimeMs)) {
        entry = { reader: new LineReader(descriptor.file), tracker: new LoopTracker(), descriptor, size: 0, mtimeMs: 0 }
        this.entries.set(descriptor.id, entry)
      }
      try {
        await entry.reader.read(line => entry!.tracker.apply(line))
        const stat = await fs.stat(descriptor.file)
        entry.size = descriptor.size; entry.mtimeMs = stat.mtimeMs; entry.descriptor = descriptor
      } catch { /* Retry next poll when the file is being moved or rewritten. */ }
    }
  }
  totalUsage(): FleetUsage {
    let total = emptyUsage()
    for (const entry of this.entries.values()) total = addUsage(total, entry.tracker.usage)
    return total
  }
  events(): UsageEvent[] { return [...this.entries.values()].flatMap(one => one.tracker.events) }
  loops(now: number, idleAfterMs: number): FleetLoop[] {
    const loops: FleetLoop[] = []
    for (const [id, entry] of this.entries) {
      const t = entry.tracker, main = id === this.id
      const spawn = this.main?.agents.get(id)
      const stale = now - t.lastEventAt > idleAfterMs
      const status = spawn?.status === 'killed' ? 'killed' : (t.status === 'running' || t.status === 'waiting') && stale ? 'idle' : t.status
      loops.push({ id: main ? MAIN : id, parentId: main ? undefined : entry.descriptor.parentId === this.id ? MAIN : entry.descriptor.parentId,
        type: main ? MAIN : entry.descriptor.agentType ?? spawn?.type ?? 'agent',
        description: main ? '' : entry.descriptor.nickname ?? spawn?.description ?? '', status: main && status === 'completed' ? 'idle' : status,
        startedAt: t.startedAt, endedAt: isOver(status) ? t.lastEventAt : undefined,
        steps: t.steps, usage: t.usage, model: t.model, tool: status === 'running' || status === 'waiting' ? t.tool : undefined })
    }
    for (const [id, spawn] of this.main?.agents ?? []) if (!this.entries.has(id)) {
      loops.push({ id, type: spawn.type, description: spawn.description, parentId: MAIN, startedAt: spawn.startedAt,
        steps: 0, usage: emptyUsage(), status: now - spawn.startedAt > idleAfterMs && spawn.status === 'pending' ? 'idle' : spawn.status })
    }
    return loops.sort((a, b) => a.id === MAIN ? -1 : b.id === MAIN ? 1 : a.startedAt - b.startedAt)
  }
}
