import type { PluginOptions } from 'claude-code'

import type { Context, Limit } from '../types'

export type Settings = {
  warnMinutes: number
  staleMinutes: number
  gaugeMinutes: number
}

export type CacheLevel = 'fresh' | 'warn' | 'stale'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The gauge label per usage window the engine names; another kind shows as named. */
const LIMIT_LABEL: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Week',
  spend_limit: 'Spend',
}

/** Reads the manifest's userConfig values; a value it cannot use fails the load. */
export function readSettings(options: PluginOptions): Settings {
  const warnMinutes = positiveNumber(options, 'warnMinutes')
  const staleMinutes = positiveNumber(options, 'staleMinutes')
  const gaugeMinutes = positiveNumber(options, 'gaugeMinutes')

  if (warnMinutes >= staleMinutes) {
    throw new Error(
      `session-meter: warnMinutes (${warnMinutes}) must be below staleMinutes (${staleMinutes})`,
    )
  }
  if (staleMinutes >= gaugeMinutes) {
    throw new Error(
      `session-meter: staleMinutes (${staleMinutes}) must be below gaugeMinutes (${gaugeMinutes})`,
    )
  }

  return { warnMinutes, staleMinutes, gaugeMinutes }
}

function positiveNumber(options: PluginOptions, name: string): number {
  const value = options[name]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`session-meter: ${name} must be a positive number, got ${String(value)}`)
  }

  return value
}

/** Whole minutes since the last main-thread response. */
export function cacheMinutes(lastResponseAt: number, now: number): number {
  return Math.max(0, Math.floor((now - lastResponseAt) / MINUTE_MS))
}

/** Green under warn, yellow from warn up to stale, red past stale. */
export function cacheLevel(minutes: number, settings: Settings): CacheLevel {
  if (minutes < settings.warnMinutes) return 'fresh'
  if (minutes <= settings.staleMinutes) return 'warn'

  return 'stale'
}

const LEVEL_NAME: Record<CacheLevel, string> = { fresh: 'Fresh', warn: 'Cooling', stale: 'Stale' }

export function levelName(level: CacheLevel): string {
  return LEVEL_NAME[level]
}

/** A span of time: "0:45 h", "4:21 h", "3 days". */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`
  const days = Math.floor(minutes / (24 * 60))

  return days === 1 ? '1 day' : `${days} days`
}

/** "18% used" and "821k free" for the context window; dashes before the first response. */
export function contextDetails(context: Context | null): [string, string] {
  const share = contextFraction(context)
  if (context === null || context.tokens === undefined || share === null) return ['— used', '— free']

  return [`${Math.round(share * 100)}% used`, `${compactTokens(Math.max(0, context.window - context.tokens))} free`]
}

/**
 * Two short lines, so the band stays one row: within a day "Resets 22:40" and
 * "in 4:21 h"; further out "Resets Tue" and "at 18:00". Empty without a reset time.
 */
export function resetDetails(limit: Limit, now: number): [string, string] {
  if (limit.resetsAt === undefined) return ['', '']
  const at = resetDate(limit)
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (at.getTime() - now < DAY_MS) return [`Resets ${clock}`, `in ${formatSpan(at.getTime() - now)}`]

  return [`Resets ${WEEKDAYS[at.getDay()] ?? ''}`, `at ${clock}`]
}

function resetDate(limit: Limit): Date {
  const at = new Date(limit.resetsAt ?? '')
  if (Number.isNaN(at.getTime())) {
    throw new Error(`session-meter: resetsAt is no ISO time: ${String(limit.resetsAt)}`)
  }

  return at
}

/** The share of the cache gauge's full scale (gaugeMinutes) the age has reached, 0 to 1. */
export function cacheFraction(minutes: number, settings: Settings): number {
  return Math.min(1, minutes / settings.gaugeMinutes)
}

/** The share of the context window in use, 0 to 1; null before the first response. */
export function contextFraction(context: Context | null): number | null {
  if (context === null || context.tokens === undefined) return null
  const share = context.percent === undefined ? context.tokens / context.window : context.percent / 100

  return Math.min(1, Math.max(0, share))
}

/** 950 → "950", 231_200 → "231k", 1_000_000 → "1M", 1_240_000 → "1.24M". */
export function compactTokens(count: number): string {
  const thousands = Math.round(count / 1_000)
  if (count < 1_000) return String(count)
  if (thousands < 1_000) return `${thousands}k`

  return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

/** The session's cost as Claude Code's own ledger gives it, in dollars. */
export function formatCost(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`
}

export function limitLabel(limit: Limit): string {
  return LIMIT_LABEL[limit.kind] ?? limit.kind
}

/** The share of the window used, 0 to 1 (an exceeded spend limit draws full). */
export function limitFraction(limit: Limit): number {
  return Math.min(1, Math.max(0, limit.percentUsed / 100))
}

/** Percent used, whole: 99.4 → "99%". */
export function limitPercent(limit: Limit): string {
  return `${Math.round(limit.percentUsed)}%`
}

/**
 * When the window resets, in local time: "17:40" within a day of now, else the
 * weekday ("Tue"); empty without a reset time.
 */
export function formatReset(limit: Limit, now: number): string {
  if (limit.resetsAt === undefined) return ''
  const at = resetDate(limit)
  if (at.getTime() - now < DAY_MS) {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  return WEEKDAYS[at.getDay()] ?? ''
}

export { MINUTE_MS }
