import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Rate, Totals } from '../types'
import {
  MINUTE_MS,
  cacheLevel,
  cacheMinutes,
  formatContext,
  formatCost,
  formatTokens,
  isRateDue,
  parseEcbRate,
  readSettings,
} from './meter'
import type { CacheLevel, Settings } from './meter'

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const RATE_KEY = 'rate'

const totals = atom({ plugin: 'session-meter', key: 'totals' } as const, ZERO, {
  shape: 'totals-1',
})
const lastResponseAt = atom(
  { plugin: 'session-meter', key: 'lastResponseAt' } as const,
  null as number | null,
)
const costUsd = atom({ plugin: 'session-meter', key: 'costUsd' } as const, null as number | null)
const rate = atom({ plugin: 'session-meter', key: 'rate' } as const, null as Rate | null, {
  shape: 'rate-1',
})
const tick = atom({ plugin: 'session-meter', key: 'tick' } as const, 0)
const context = atom({ plugin: 'session-meter', key: 'context' } as const, null as Context | null, {
  shape: 'context-1',
})

function toContext(usage: { tokens?: number; window: number; percent?: number }): Context {
  return {
    window: usage.window,
    ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
    ...(usage.percent === undefined ? {} : { percent: usage.percent }),
  }
}

const LEVEL_COLOR: Record<CacheLevel, 'success' | 'warning' | 'error'> = {
  fresh: 'success',
  warn: 'warning',
  stale: 'error',
}

/** Fetches the ECB rate when the one held is missing or older than rateRefreshHours. */
async function refreshRate($: EngineInterface, settings: Settings): Promise<void> {
  if (settings.currency !== 'EUR') return

  const now = await $.clock.now()
  if (!isRateDue(await read($, rate), now, settings)) return

  const response = await $.http.fetch(settings.rateUrl)
  const fresh = response.ok ? parseEcbRate(response.text, now) : null
  if (fresh === null) {
    $.ui.log(`session-meter: no USD rate from ${settings.rateUrl} (status ${response.status})`)
    return
  }
  await update($, rate, () => fresh)
  await $.store.set(RATE_KEY, fresh)
}

async function storedRate($: EngineInterface): Promise<Rate | null> {
  const value = (await $.store.get(RATE_KEY)) as Partial<Rate> | undefined
  if (
    typeof value?.usdPerEur !== 'number' ||
    typeof value.date !== 'string' ||
    typeof value.fetchedAt !== 'number'
  ) {
    return null
  }

  return { usdPerEur: value.usdPerEur, date: value.date, fetchedAt: value.fetchedAt }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    const fill = toContext(usage.context)
    await update($, context, () => fill)
    if (usage.cost !== undefined) {
      const usd = usage.cost.usd
      await update($, costUsd, () => usd)
    }
    if ((await read($, rate)) === null) {
      const stored = await storedRate($)
      if (stored !== null) await update($, rate, () => stored)
    }
    const refresh = () => {
      refreshRate($, settings).catch((err: unknown) => {
        $.ui.log(`session-meter: rate fetch failed: ${String(err)}`)
      })
    }
    $.clock.every(MINUTE_MS, () => {
      void update($, tick, n => n + 1)
      refresh()
    })
    $.clock.after(0, refresh)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      await update($, totals, sum => ({
        input: sum.input + usage.input_tokens,
        output: sum.output + usage.output_tokens,
        cacheRead: sum.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: sum.cacheWrite + usage.cache_creation_input_tokens,
      }))
      if (e.agentId === undefined) {
        const now = await $.clock.now()
        await update($, lastResponseAt, () => now)
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const fill = toContext(e.context)
    await update($, context, () => fill)
    if (e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, costUsd, () => usd)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const sum = await read($, totals)
    const last = await read($, lastResponseAt)
    const usd = await read($, costUsd)
    const usdPerEur = await read($, rate)
    const fill = await read($, context)
    const now = await $.clock.now()

    const minutes = last === null ? null : cacheMinutes(last, now)
    const cacheColor = minutes === null ? undefined : LEVEL_COLOR[cacheLevel(minutes, settings)]
    const total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite

    const cells: { key: string; head: string; value: string; color?: string }[] = [
      { key: 'cache', head: 'Cache', value: minutes === null ? '—' : `${minutes} min`, color: cacheColor },
      { key: 'total', head: 'Total token use', value: formatTokens(total) },
      { key: 'context', head: 'Context', value: formatContext(fill) },
      { key: 'cost', head: 'Cost', value: formatCost(usd, usdPerEur, settings) },
    ]

    return (
      <Box flexDirection="row" flexWrap="nowrap" width="100%">
        {cells.map(cell => (
          <Box key={cell.key} flexDirection="column" width={`${100 / cells.length}%`}>
            <Text dimColor wrap="truncate">
              {cell.head}
            </Text>
            <Text bold tabular wrap="truncate" color={cell.color}>
              {cell.value}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
