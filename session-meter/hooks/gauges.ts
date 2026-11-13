import type { Context } from '../types'
import { cacheFraction, compactTokens, contextFraction } from './meter'
import type { CacheLevel, Settings } from './meter'

/** Side of each gauge, in CSS pixels. */
export const GAUGE_PX = 64

const CENTER = GAUGE_PX / 2
/** The ring sits a little high, so the opening at the bottom holds two lines of text. */
const CENTER_Y = 29
const RADIUS = 26
const STROKE = 6
const NEEDLE = RADIUS - 8
/** The arc runs from lower left over the top to lower right, open at the bottom (0° = top). */
const ARC_START = -135
const ARC_SWEEP = 270
/** Small slices drawn per cache arc, so its colour runs as a gradient. */
const SLICES = 54

const GREEN = '#22D46B'
const YELLOW = '#FFC21A'
const RED = '#F0453A'
const TRACK_GREEN = '#22C55E'
const FILL_RED = '#E24B4A'

/** Value text per cache level, readable on light and dark backgrounds. */
const LEVEL_TEXT: Record<CacheLevel, string> = {
  fresh: '#16A34A',
  warn: '#B7791F',
  stale: '#DC2626',
}

/** Text and needle follow the viewer's colour scheme, as the SVG is drawn as an image. */
const STYLE =
  '<style>.fg{fill:#1F2937;stroke:#1F2937}.dim{fill:#6B7280}' +
  'text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:11px;text-anchor:middle}' +
  '@media (prefers-color-scheme:dark){.fg{fill:#E5E7EB;stroke:#E5E7EB}.dim{fill:#9CA3AF}}</style>'

function point(angle: number, radius: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180

  return [CENTER + radius * Math.cos(rad), CENTER_Y + radius * Math.sin(rad)]
}

function arcPath(from: number, to: number): string {
  const [x0, y0] = point(from, RADIUS)
  const [x1, y1] = point(to, RADIUS)
  const large = to - from > 180 ? 1 : 0

  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${RADIUS} ${RADIUS} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function hex(colour: string): number[] {
  return [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16))
}

/** The colour at minute m: green at 0, yellow at warnMinutes, red from staleMinutes on. */
function cacheColour(minute: number, settings: Settings): string {
  if (minute >= settings.staleMinutes) return RED
  if (minute < settings.warnMinutes) return blend(GREEN, YELLOW, minute / settings.warnMinutes)

  return blend(YELLOW, RED, (minute - settings.warnMinutes) / (settings.staleMinutes - settings.warnMinutes))
}

function blend(from: string, to: string, t: number): string {
  const a = hex(from)
  const b = hex(to)

  return `rgb(${a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * t)).join(',')})`
}

function svg(alt: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE_PX}" height="${GAUGE_PX}" ` +
    `viewBox="0 0 ${GAUGE_PX} ${GAUGE_PX}" role="img" aria-label="${alt}">${STYLE}${body}</svg>`
  )
}

function label(text: string): string {
  return `<text class="dim" x="${CENTER}" y="${GAUGE_PX - 1}">${text}</text>`
}

/** Cache gauge: gradient arc over the gauge's full scale, needle at the age, minutes in the opening. */
export function cacheGauge(minutes: number | null, level: CacheLevel | null, settings: Settings) {
  let body = ''
  for (let k = 0; k < SLICES; k++) {
    const from = ARC_START + (ARC_SWEEP * k) / SLICES
    const to = ARC_START + (ARC_SWEEP * (k + 1)) / SLICES + 0.6
    const minute = (settings.gaugeMinutes * (k + 0.5)) / SLICES
    body += `<path d="${arcPath(from, Math.min(to, ARC_START + ARC_SWEEP))}" stroke="${cacheColour(minute, settings)}" stroke-width="${STROKE}" fill="none"/>`
  }

  if (minutes === null || level === null) {
    body += `<text class="fg" x="${CENTER}" y="${GAUGE_PX - 12}">—</text>`
  } else {
    const [nx, ny] = point(ARC_START + ARC_SWEEP * cacheFraction(minutes, settings), NEEDLE)
    body +=
      `<line class="fg" x1="${CENTER}" y1="${CENTER_Y}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<circle class="fg" cx="${CENTER}" cy="${CENTER_Y}" r="3"/>` +
      `<text x="${CENTER}" y="${GAUGE_PX - 12}" font-weight="600" fill="${LEVEL_TEXT[level]}">${minutes}m</text>`
  }
  body += label('cache')

  const alt = minutes === null ? 'Cache: no response yet' : `Cache ${minutes} minutes, ${level}`

  return { source: svg(alt, body), alt }
}

/** Context gauge: green ring filled red as the window fills, tokens and window inside. */
export function contextGauge(context: Context | null) {
  const share = contextFraction(context)
  let body = `<path d="${arcPath(ARC_START, ARC_START + ARC_SWEEP)}" stroke="${TRACK_GREEN}" stroke-width="${STROKE}" fill="none" stroke-linecap="round"/>`
  if (share !== null && share > 0) {
    body += `<path d="${arcPath(ARC_START, ARC_START + ARC_SWEEP * share)}" stroke="${FILL_RED}" stroke-width="${STROKE}" fill="none" stroke-linecap="round"/>`
  }

  const used = context?.tokens === undefined ? '—' : compactTokens(context.tokens)
  const window = context === null ? '' : `/ ${compactTokens(context.window)}`
  body +=
    `<text class="fg" x="${CENTER}" y="${CENTER_Y + 1}" font-weight="600" font-size="10.5">${used}</text>` +
    `<text class="dim" x="${CENTER}" y="${CENTER_Y + 13}" font-size="10">${window}</text>` +
    label('context')

  const alt =
    share === null
      ? `Context: no response yet${context === null ? '' : `, window ${compactTokens(context.window)}`}`
      : `Context ${used} ${window} tokens, ${Math.round(share * 100)}%`

  return { source: svg(alt, body), alt }
}

/** Filled and empty block cells of a terminal bar for a share 0 to 1. */
export function barCells(share: number, cells: number): [number, number] {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * cells)

  return [filled, cells - filled]
}
