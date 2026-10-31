import { Figures, FleetLoop, FleetMemory, FleetStatus, MAIN, isOver, totalTokens } from './types'

/**
 * The Codex Consumption cyberpunk pixel-art scene: a neon city where every sub-agent
 * is a drone, the main conversation a tower with a beating heart, and a HUD of figures. The animation is
 * carried by the SVG itself (SMIL): the panel only redraws when the state changes.
 */

const MAX_DRONES = 12

// ─── Neon palette ────────────────────────────────────────────────────────────

export const NEON = {
  cyan: '#00f0ff',
  magenta: '#ff2bd6',
  yellow: '#ffe14d',
  green: '#39ff14',
  red: '#ff3b3b',
  violet: '#7a3cff',
  dim: '#3a2a5a',
} as const

export const STATUS_COLOR: Record<FleetStatus, string> = {
  pending: NEON.yellow,
  running: NEON.cyan,
  waiting: NEON.yellow,
  idle: NEON.violet,
  completed: NEON.green,
  failed: NEON.red,
  killed: NEON.red,
}

export const STATUS_LABEL: Record<FleetStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting: 'permission',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

export function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`

  return String(n)
}

// ─── Pixel-art scene ─────────────────────────────────────────────────────────

const W = 192
/** Height of the bottom strip. */
const FOOTER = 6
/** Height of one HUD row. */
const HUD_ROW = 18

/** Geometry of a scene: its height follows the room the panel gives, the ground and sky follow. */
type Layout = { H: number; GROUND: number; HUD: number }

/** `hudRows` is 2, or 3 when the comparison row is shown: the scenery keeps the same room either way. */
function layoutFor(aspect: number, hudRows: number): Layout {
  const HUD = hudRows * HUD_ROW
  const H = Math.max(62, Math.min(108, Math.round(W / aspect))) + (HUD - 2 * HUD_ROW)

  return { H, GROUND: H - FOOTER, HUD }
}

/** Deterministic pseudo-random: the scene does not move from one redraw to the next. */
function noise(seed: number) {
  const x = Math.sin(seed * 9301 + 49297) * 233280

  return x - Math.floor(x)
}

function rect(x: number, y: number, w: number, h: number, fill: string, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`
}

export function escapeXml(text: string) {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

/** A text readable over the scenery: a dark cartouche under the characters. */
function label(x: number, y: number, text: string, color: string, size: number, anchor: 'start' | 'middle' | 'end' = 'middle', bold = false) {
  const width = text.length * size * 0.62 + 2
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x - 1

  return (
    rect(left, y - size * 0.9, width, size * 1.2, '#0b0820', 'opacity="0.85" rx="0.5"') +
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${color}" font-family="monospace"${bold ? ' font-weight="bold"' : ''}>${escapeXml(text)}</text>`
  )
}

function stars(l: Layout) {
  let out = ''

  for (let i = 0; i < 28; i += 1) {
    const x = Math.floor(noise(i) * W)
    const y = Math.floor(noise(i + 100) * (l.GROUND * 0.5))
    const dur = (1.4 + noise(i + 200) * 3).toFixed(1)
    out += `<rect x="${x}" y="${y}" width="1" height="1" fill="#cfd8ff"><animate attributeName="opacity" values="0.15;1;0.15" dur="${dur}s" repeatCount="indefinite"/></rect>`
  }

  return out
}

function sun(l: Layout) {
  const r = Math.min(22, Math.floor((l.GROUND - l.HUD) / 2.6))
  const cy = l.GROUND - r + 2
  let bands = ''

  for (let y = cy - r * 0.6; y < cy + r; y += 4) bands += rect(96 - r, Math.round(y), r * 2, 1, '#3a2478')

  return `<circle cx="96" cy="${cy}" r="${r}" fill="url(#sun)"/>${bands}`
}

function skyline(l: Layout) {
  let out = ''
  const scale = (l.GROUND - l.HUD) / 70
  const buildings = [
    [0, 36, 14], [16, 24, 10], [28, 42, 12], [42, 28, 8], [52, 50, 16], [120, 46, 14], [136, 30, 10],
    [148, 56, 12], [162, 36, 14], [178, 26, 14],
  ] as const

  buildings.forEach(([x, height, w], b) => {
    const top = Math.round(l.GROUND - height * scale)
    out += rect(x, top, w, l.GROUND - top, '#2a2270', 'stroke="#6a58b8" stroke-width="0.5"')

    for (let wy = top + 3; wy < l.GROUND - 3; wy += 4) {
      for (let wx = x + 2; wx < x + w - 1; wx += 3) {
        const r = noise(b * 1000 + wy * 7 + wx)

        if (r < 0.45) continue

        const color = r > 0.85 ? NEON.magenta : r > 0.7 ? NEON.yellow : NEON.cyan
        const blink = r > 0.9 ? `<animate attributeName="opacity" values="1;0.2;1" dur="${(0.8 + r).toFixed(1)}s" repeatCount="indefinite"/>` : ''
        out += `<rect x="${wx}" y="${wy}" width="1" height="2" fill="${color}" opacity="0.8">${blink}</rect>`
      }
    }
  })

  return out
}

function grid(l: Layout) {
  let out = `<line x1="0" y1="${l.GROUND}" x2="${W}" y2="${l.GROUND}" stroke="${NEON.cyan}" stroke-width="1"/>`

  for (let i = -6; i <= 6; i += 1) {
    out += `<line x1="${96 + i * 12}" y1="${l.GROUND}" x2="${96 + i * 40}" y2="${l.H}" stroke="${NEON.magenta}" stroke-width="0.5" opacity="0.45"/>`
  }

  out += `<line x1="0" y1="${l.GROUND + 3}" x2="${W}" y2="${l.GROUND + 3}" stroke="${NEON.magenta}" stroke-width="0.5" opacity="0.35"/>`

  return out
}

/** The central tower: the main loop, whose heart beats while it works. */
function tower(l: Layout, main: FleetLoop | undefined) {
  const top = l.HUD + 4
  const core = Math.round((top + l.GROUND) / 2)
  const isWorking = main?.status === 'running' || main?.status === 'waiting'
  const color = main ? STATUS_COLOR[main.status] : NEON.dim
  const pulse = isWorking
    ? `<animate attributeName="r" values="2;4;2" dur="0.9s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.5;1" dur="0.9s" repeatCount="indefinite"/>`
    : ''
  const beacon = `<rect x="95" y="${top - 4}" width="2" height="2" fill="${NEON.red}"><animate attributeName="opacity" values="1;0;1" dur="1.6s" repeatCount="indefinite"/></rect>`
  let floors = ''

  for (let y = top + 6; y < l.GROUND - 4; y += 6) {
    if (Math.abs(y - core) > 8) floors += rect(89, y, 14, 1, '#5a48b0')
  }
  const caption = main ? label(96, l.GROUND - 2, `${main.tool ?? STATUS_LABEL[main.status]} ${formatTokens(totalTokens(main.usage))}`, color, 4.4) : ''

  return (
    rect(86, top, 20, l.GROUND - top, '#33288a', 'stroke="#8a74d8" stroke-width="0.6"') +
    rect(90, top - 2, 12, 3, '#4a3aa0') +
    beacon +
    `<circle cx="96" cy="${core}" r="3" fill="${color}">${pulse}</circle>` +
    `<circle cx="96" cy="${core}" r="6" fill="none" stroke="${color}" stroke-width="0.5" opacity="0.5"/>` +
    floors +
    caption
  )
}

/** One drone per sub-agent: it flies while the agent works, lands once it is over. */
function drone(l: Layout, loop: FleetLoop, index: number, count: number) {
  // Drones spread on both sides of the tower (x 86 to 106), never in front of it.
  const SIDE = 64
  const slotWidth = Math.min(28, Math.floor((SIDE * 2) / Math.max(count, 1)))
  const virtual = index * slotWidth + Math.floor(slotWidth / 2)
  const cx = virtual < SIDE ? 14 + virtual : 114 + (virtual - SIDE)
  const over = isOver(loop.status)
  const lane = (index % 3) * Math.max(4, Math.floor((l.GROUND - l.HUD) / 9))
  const cy = over ? l.GROUND - 5 : l.HUD + 6 + lane
  const core = Math.round((l.HUD + 4 + l.GROUND) / 2)
  const color = STATUS_COLOR[loop.status]
  const hover = over
    ? ''
    : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="${(1 + (index % 4) * 0.25).toFixed(2)}s" repeatCount="indefinite"/>`
  const rotor = over
    ? ''
    : `<rect x="${cx - 5}" y="${cy - 4}" width="4" height="1" fill="#9fb3ff"><animate attributeName="opacity" values="1;0.2;1" dur="0.2s" repeatCount="indefinite"/></rect><rect x="${cx + 1}" y="${cy - 4}" width="4" height="1" fill="#9fb3ff"><animate attributeName="opacity" values="0.2;1;0.2" dur="0.2s" repeatCount="indefinite"/></rect>`
  const beam = loop.status === 'running'
    ? `<line x1="96" y1="${core}" x2="${cx}" y2="${cy}" stroke="${NEON.cyan}" stroke-width="0.5" stroke-dasharray="2 2" opacity="0.6"><animate attributeName="stroke-dashoffset" values="0;-8" dur="0.6s" repeatCount="indefinite"/></line>`
    : ''
  const eye = loop.status === 'waiting'
    ? `<rect x="${cx - 1}" y="${cy - 1}" width="2" height="1" fill="${NEON.yellow}"><animate attributeName="opacity" values="1;0;1" dur="0.4s" repeatCount="indefinite"/></rect>`
    : `<rect x="${cx - 1}" y="${cy - 1}" width="2" height="1" fill="${over ? '#1b1b1b' : NEON.red}"/>`
  const caption = over ? formatTokens(totalTokens(loop.usage)) : `${loop.tool ? loop.tool.slice(0, 8) + ' ' : ''}${formatTokens(totalTokens(loop.usage))}`
  // Once landed, the drone carries its total above itself so it does not overlap the bottom strip labels.
  const text = label(cx, over ? cy - 6 : cy + 9, caption, color, 4.2)
  const title = `<title>${escapeXml(`${loop.type} · ${STATUS_LABEL[loop.status]}${loop.description ? ' · ' + loop.description : ''} · ${formatTokens(totalTokens(loop.usage))} tokens`)}</title>`

  return (
    beam +
    `<g>${title}${hover}` +
    rotor +
    rect(cx - 4, cy - 3, 8, 5, color, `opacity="${over ? 0.55 : 1}"`) +
    rect(cx - 3, cy - 2, 6, 3, '#1c1656') +
    eye +
    rect(cx - 2, cy + 2, 1, 1, color) +
    rect(cx + 1, cy + 2, 1, 1, color) +
    `</g>` +
    text
  )
}

export function money(usd: number | undefined, estimated = false) {
  return usd === undefined ? '--' : `${estimated ? '≈' : ''}$${usd.toFixed(2)}`
}

export function percent(value: number | undefined) {
  return value === undefined ? '--' : `${Math.round(value)}%`
}

/** How many times more expensive Codex was than the comparison model, as `×n`. */
export function ratio(codex: number | undefined, other: number | undefined) {
  if (codex === undefined || other === undefined || other <= 0) return '--'

  const value = codex / other

  return `×${value >= 10 ? value.toFixed(0) : value.toFixed(1)}`
}

function hud(list: readonly FleetLoop[], memCount: number, f: Figures, l: Layout) {
  const agents = list.filter(one => one.id !== MAIN)
  const running = agents.filter(one => !isOver(one.status) && one.status !== 'idle').length
  const tokens = list.reduce((sum, one) => sum + totalTokens(one.usage), 0)
  const ctxColor = f.contextPercent !== undefined && f.contextPercent >= 80 ? NEON.red : NEON.cyan
  const quotaColor = (value: number | undefined) => (value !== undefined && value >= 80 ? NEON.red : NEON.green)
  const periodsMark = Boolean(f.periodsEstimated)
  const cell = (x: number, row: number, title: string, value: string, color: string) =>
    `<text x="${x}" y="${row * HUD_ROW + 7.5}" font-size="3.6" fill="#b8b0e0" font-family="monospace">${escapeXml(title)}</text>` +
    `<text x="${x}" y="${row * HUD_ROW + 15.5}" font-size="6.5" fill="${color}" font-family="monospace" font-weight="bold">${escapeXml(value)}</text>`
  const separator = (row: number) => `<line x1="4" y1="${row * HUD_ROW}" x2="${W - 4}" y2="${row * HUD_ROW}" stroke="#2a2270" stroke-width="0.5"/>`
  // The comparison row: what the same tokens would cost on the comparison model, and the ratio.
  const compare = f.compareLabel
    ? separator(2) +
      cell(4, 2, `${f.compareLabel} SESSION`, money(f.compareSessionUsd), NEON.magenta) +
      cell(50, 2, `${f.compareLabel} WEEK`, money(f.compareWeekUsd), NEON.magenta) +
      cell(96, 2, `${f.compareLabel} MONTH`, money(f.compareMonthUsd), NEON.magenta) +
      cell(142, 2, `CODEX / ${f.compareLabel}`, ratio(f.sessionUsd, f.compareSessionUsd), NEON.magenta)
    : ''

  return (
    rect(0, 0, W, l.HUD, '#0b0820') +
    `<line x1="0" y1="${l.HUD}" x2="${W}" y2="${l.HUD}" stroke="${NEON.cyan}" stroke-width="0.8"/>` +
    separator(1) +
    compare +
    cell(4, 0, 'AGENTS', `${running}/${agents.length}`, NEON.cyan) +
    cell(50, 0, 'TOKENS', formatTokens(tokens), NEON.magenta) +
    cell(96, 0, 'MEMORY', String(memCount), NEON.green) +
    cell(142, 0, 'CONTEXT', percent(f.contextPercent), ctxColor) +
    rect(142, 17, 44, 1.5, '#2a2270') +
    rect(142, 17, Math.max(0, Math.min(44, (f.contextPercent ?? 0) * 0.44)), 1.5, ctxColor) +
    cell(4, 1, 'SESSION API EST.', money(f.sessionUsd, f.sessionEstimated), NEON.yellow) +
    cell(50, 1, 'WEEK', money(f.weekUsd, periodsMark), NEON.yellow) +
    cell(96, 1, 'MONTH', money(f.monthUsd, periodsMark), NEON.yellow) +
    cell(142, 1, f.quotaLabel ?? 'QUOTA', `${percent(f.fiveHourPercent)} ${percent(f.sevenDayPercent)}`, quotaColor(f.sevenDayPercent))
  )
}

/**
 * The whole scene. `aspect` is the width/height ratio of the available room: the scenery's height
 * adapts to it, and `meet` fits the drawing in the box without ever cropping it.
 */
export function scene(list: readonly FleetLoop[], mem: FleetMemory, figures: Figures, aspect: number) {
  const l = layoutFor(aspect, figures.compareLabel ? 3 : 2)
  const main = list.find(one => one.id === MAIN)
  const agents = list.filter(one => one.id !== MAIN)
  const drones = agents.slice(-MAX_DRONES)
  const more = agents.length - drones.length
  const overflow = more > 0 ? `<text x="${W - 4}" y="${l.GROUND - 2}" text-anchor="end" font-size="3.4" fill="${NEON.yellow}" font-family="monospace">+${more}</text>` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${l.H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img">` +
    `<defs>` +
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1656"/><stop offset="0.65" stop-color="#432a86"/><stop offset="1" stop-color="#8a3fae"/></linearGradient>` +
    `<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${NEON.yellow}"/><stop offset="1" stop-color="${NEON.magenta}"/></linearGradient>` +
    `<pattern id="scan" width="1" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#000" opacity="0.05"/></pattern>` +
    `</defs>` +
    rect(-W, -l.H, W * 3, l.H * 3, '#1c1656') +
    rect(0, 0, W, l.H, 'url(#sky)') +
    stars(l) +
    sun(l) +
    skyline(l) +
    tower(l, main) +
    rect(0, l.GROUND, W, l.H - l.GROUND, '#1e1750') +
    grid(l) +
    drones.map((loop, i) => drone(l, loop, i, drones.length)).join('') +
    overflow +
    hud(list, mem.entries.length, figures, l) +
    rect(0, 0, W, l.H, 'url(#scan)') +
    `</svg>`
  )
}

/** The scene's alternative text, read by screen readers and shown as a tooltip. */
export function sceneAlt(list: readonly FleetLoop[], mem: FleetMemory, figures: Figures) {
  const main = list.find(one => one.id === MAIN)
  const agents = list.filter(one => one.id !== MAIN)

  const compare = figures.compareLabel ? `, ${money(figures.compareSessionUsd)} on ${figures.compareLabel.toLowerCase()} (${ratio(figures.sessionUsd, figures.compareSessionUsd)})` : ''

  return `${agents.filter(one => !isOver(one.status)).length} active agent(s) out of ${agents.length}, main ${main ? STATUS_LABEL[main.status] : '--'}, context ${figures.contextPercent === undefined ? '?' : Math.round(figures.contextPercent)} %, ${mem.entries.length} memory entries, cost ${money(figures.sessionUsd, figures.sessionEstimated)}${compare}`
}
