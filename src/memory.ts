import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { FleetMemory } from './types'

/** Count entries in Codex's persistent memory index, when one exists. */
export async function readMemory(root: string, now: number): Promise<FleetMemory> {
  for (const name of ['MEMORY.md', 'memory_summary.md']) {
    const file = path.join(root, 'memories', name)
    try {
      const text = await fs.readFile(file, 'utf8')
      const entries = text.split('\n').flatMap(line => {
        const title = /^\s*-\s*\[([^\]]+)\]/.exec(line)?.[1] ?? /^##\s+(.+)/.exec(line)?.[1]
        return title ? [title.trim()] : []
      })
      return { entries, path: file, readAt: now }
    } catch { /* Memory is optional. */ }
  }
  return { entries: [], readAt: now }
}
