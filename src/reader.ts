import { promises as fs } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const CHUNK = 4 * 1024 * 1024

/**
 * Reads a line-oriented file incrementally: every call only reads what was appended since the previous
 * one. A file that shrank (truncated, replaced) is read again from the start.
 */
export class LineReader {
  private offset = 0
  private rest = ''
  private decoder = new StringDecoder('utf8')

  constructor(public readonly path: string) {}

  /** Calls `onLine` for every new complete line; returns the number of lines read. */
  async read(onLine: (line: string) => void): Promise<number> {
    const stat = await fs.stat(this.path)

    if (stat.size < this.offset) this.reset()
    if (stat.size === this.offset) return 0

    const handle = await fs.open(this.path, 'r')
    let count = 0

    try {
      while (this.offset < stat.size) {
        const length = Math.min(CHUNK, stat.size - this.offset)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset)

        if (bytesRead === 0) break

        this.offset += bytesRead
        const text = this.rest + this.decoder.write(buffer.subarray(0, bytesRead))
        const parts = text.split('\n')
        this.rest = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.endsWith('\r') ? part.slice(0, -1) : part

          if (line.length === 0) continue

          onLine(line)
          count += 1

          // A first read may cover tens of megabytes: yield to the event loop now and then.
          if (count % 5000 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    } finally {
      await handle.close()
    }

    return count
  }

  reset() {
    this.offset = 0
    this.rest = ''
    this.decoder = new StringDecoder('utf8')
  }
}
