import type { PluginOptions } from 'claude-code'

import type { Context, Rate } from '../types'

export type Settings = {
  warnMinutes: number
  staleMinutes: number
  currency: 'EUR' | 'USD'
  rateUrl: string
  rateRefreshHours: number
}

export type CacheLevel = 'fresh' | 'warn' | 'stale'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Reads the manifest's userConfig values; a value it cannot use fails the load. */
export function readSettings(options: PluginOptions): Settings {
  const warnMinutes = positiveNumber(options, 'warnMinutes')
  const staleMinutes = positiveNumber(options, 'staleMinutes')
  const rateRefreshHours = positiveNumber(options, 'rateRefreshHours')
  const currency = options.currency
  const rateUrl = options.rateUrl

  if (warnMinutes >= staleMinutes) {
    throw new Error(
      `session-meter: warnMinutes (${warnMinutes}) must be below staleMinutes (${staleMinutes})`,
    )
  }
  if (currency !== 'EUR' && currency !== 'USD') {
    throw new Error(`session-meter: currency must be EUR or USD, got ${String(currency)}`)
  }
  if (typeof rateUrl !== 'string' || !/^https:\/\//.test(rateUrl)) {
    throw new Error(`session-meter: rateUrl must be an https URL, got ${String(rateUrl)}`)
  }

  return { warnMinutes, staleMinutes, currency, rateUrl, rateRefreshHours }
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

/** 950 → "950", 3_140 → "3.1k", 1_240_000 → "1.24M". */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${trim((count / 1_000).toFixed(1))}k`

  return `${trim((count / 1_000_000).toFixed(2))}M`
}

function trim(fixed: string): string {
  return fixed.replace(/\.?0+$/, '')
}

/** The context cell: "23% · 231.2k / 1M"; the window alone before the first response. */
export function formatContext(context: Context | null): string {
  if (context === null) return '—'
  const window = formatTokens(context.window)
  if (context.tokens === undefined) return `— / ${window}`
  const percent = context.percent ?? Math.round((context.tokens / context.window) * 100)

  return `${percent}% · ${formatTokens(context.tokens)} / ${window}`
}

/** The cost cell: euro when a rate is at hand and EUR is chosen, else dollars. */
export function formatCost(usd: number | null, rate: Rate | null, settings: Settings): string {
  if (usd === null) return '—'
  if (settings.currency === 'EUR' && rate !== null) {
    return `${(usd / rate.usdPerEur).toFixed(2)} €`
  }

  return `$${usd.toFixed(2)}`
}

/** Reads the USD rate and its date from the ECB daily XML; null when either is missing. */
export function parseEcbRate(xml: string, fetchedAt: number): Rate | null {
  const usd = /currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml)?.[1]
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1]
  const usdPerEur = usd === undefined ? NaN : Number(usd)

  if (date === undefined || !Number.isFinite(usdPerEur) || usdPerEur <= 0) return null

  return { usdPerEur, date, fetchedAt }
}

export function isRateDue(rate: Rate | null, now: number, settings: Settings): boolean {
  return rate === null || now - rate.fetchedAt >= settings.rateRefreshHours * HOUR_MS
}

export { MINUTE_MS }
