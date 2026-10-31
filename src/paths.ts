import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { isRecord } from './types'

export function configDir(setting: string | undefined): string {
  const custom = (setting ?? '').trim() || (process.env.CODEX_HOME ?? '').trim()
  return path.resolve(custom === '~' ? os.homedir() : custom.startsWith('~/') ? path.join(os.homedir(), custom.slice(2)) : custom || path.join(os.homedir(), '.codex'))
}
export function inWorkspace(cwd: string, folders: readonly string[]): boolean {
  return folders.some(folder => {
    const win = /^[a-z]:[\\/]/i.test(folder)
    const api = win ? path.win32 : path
    const relative = api.relative(win ? folder.toLowerCase() : folder, win ? cwd.toLowerCase() : cwd)
    return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))
  })
}
export type Rollout = {
  id: string; file: string; cwd: string; parentId?: string; agentType?: string; nickname?: string
  mtimeMs: number; size: number; ino: number
}
async function filesUnder(dir: string): Promise<string[]> {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const result: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(full))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full)
  }
  return result
}
/** Read only the metadata header; never keep prompts or tool output in the index. */
async function metadata(file: string): Promise<Omit<Rollout, 'mtimeMs' | 'size' | 'ino'> | undefined> {
  const handle = await fs.open(file, 'r')
  try {
    // Session metadata can contain large system instructions, so allow a bounded 2 MiB header.
    const buffer = Buffer.alloc(2 * 1024 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of text.split('\n').slice(0, 4)) {
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      if (!isRecord(row) || row.type !== 'session_meta' || !isRecord(row.payload)) continue
      const p = row.payload
      if (typeof p.id !== 'string' || typeof p.cwd !== 'string') return undefined
      const source = isRecord(p.source) && isRecord(p.source.subagent) ? p.source.subagent : {}
      const spawn = isRecord(source.thread_spawn) ? source.thread_spawn : {}
      const parentId = p.parent_thread_id ?? spawn.parent_thread_id
      return { id: p.id, cwd: p.cwd, file,
        parentId: typeof parentId === 'string' ? parentId : undefined,
        agentType: typeof p.agent_role === 'string' ? p.agent_role : typeof source.other === 'string' ? source.other : typeof spawn.agent_role === 'string' ? spawn.agent_role : undefined,
        nickname: typeof p.agent_nickname === 'string' ? p.agent_nickname : undefined }
    }
    return undefined
  } finally { await handle.close() }
}
export class TranscriptIndex {
  private headers = new Map<string, { ino: number; header: Omit<Rollout, 'mtimeMs' | 'size' | 'ino'> }>()
  async scan(root: string): Promise<Rollout[]> {
    const files = [...await filesUnder(path.join(root, 'sessions')), ...await filesUnder(path.join(root, 'archived_sessions'))]
    const found: Rollout[] = []
    for (const file of files) {
      try {
        const stat = await fs.stat(file)
        const known = this.headers.get(file)
        const header = known?.ino === stat.ino ? known.header : await metadata(file)
        if (!header) continue
        this.headers.set(file, { ino: stat.ino, header })
        found.push({ ...header, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
      } catch { /* Files can move to the archive while scanning. */ }
    }
    const live = new Set(files)
    for (const file of this.headers.keys()) if (!live.has(file)) this.headers.delete(file)
    // A moving rollout can briefly appear in both trees. Prefer the most recent copy.
    const unique = new Map<string, Rollout>()
    for (const entry of found) if (!unique.has(entry.id) || entry.mtimeMs > unique.get(entry.id)!.mtimeMs) unique.set(entry.id, entry)
    return [...unique.values()]
  }
}
export function descendants(main: Rollout, all: readonly Rollout[]): Rollout[] {
  const ids = new Set([main.id])
  let changed = true
  while (changed) {
    changed = false
    for (const one of all) if (one.parentId && ids.has(one.parentId) && !ids.has(one.id)) { ids.add(one.id); changed = true }
  }
  return all.filter(one => ids.has(one.id))
}
export function newestSession(all: readonly Rollout[], folders: readonly string[], followAll: boolean): Rollout | undefined {
  const roots = all.filter(one => !one.parentId && (followAll || inWorkspace(one.cwd, folders)))
  let best: Rollout | undefined, latest = -1
  for (const root of roots) {
    const at = Math.max(...descendants(root, all).map(one => one.mtimeMs))
    if (at > latest) { best = root; latest = at }
  }
  return best
}
