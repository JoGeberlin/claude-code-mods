import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Rate } from '../types'
import { GAUGE_PX, barCells, cacheGauge, contextGauge } from './gauges'
import {
  MINUTE_MS,
  cacheFraction,
  cacheLevel,
  cacheMinutes,
  compactTokens,
  contextFraction,
  formatCost,
  isRateDue,
  parseEcbRate,
  readSettings,
} from './meter'
import type { CacheLevel, Settings } from './meter'

const RATE_KEY = 'rate'
/** Cells of each terminal bar. */
const BAR_CELLS = 12

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
    if (result.usage !== null && e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, lastResponseAt, () => now)
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
    const last = await read($, lastResponseAt)
    const usd = await read($, costUsd)
    const usdPerEur = await read($, rate)
    const fill = await read($, context)
    const now = await $.clock.now()

    const minutes = last === null ? null : cacheMinutes(last, now)
    const level = minutes === null ? null : cacheLevel(minutes, settings)
    const cost = formatCost(usd, usdPerEur, settings)

    // The terminal has no Svg element: it draws block bars below instead.
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve({ ...e, surface: e.surface })
      const cache = cacheGauge(minutes, level, settings)
      const ctx = contextGauge(fill)

      return (
        <Box flexDirection="row" flexWrap="nowrap" width="100%" alignItems="center">
          <Box key="cache" width="33%" alignItems="center">
            <Svg source={cache.source} alt={cache.alt} width={GAUGE_PX} height={GAUGE_PX} />
          </Box>
          <Box key="context" width="34%" alignItems="center">
            <Svg source={ctx.source} alt={ctx.alt} width={GAUGE_PX} height={GAUGE_PX} />
          </Box>
          <Box key="cost" width="33%" flexDirection="column" alignItems="center">
            <Text bold tabular wrap="truncate">
              {cost}
            </Text>
            <Text dimColor>cost</Text>
          </Box>
        </Box>
      )
    }

    const [cacheOn, cacheOff] = barCells(minutes === null ? 0 : cacheFraction(minutes, settings), BAR_CELLS)
    const share = contextFraction(fill)
    const [ctxRed, ctxGreen] = barCells(share ?? 0, BAR_CELLS)
    const levelColor = level === null ? undefined : LEVEL_COLOR[level]
    const ctxText =
      fill === null
        ? '—'
        : `${fill.tokens === undefined ? '—' : compactTokens(fill.tokens)} / ${compactTokens(fill.window)}`

    return (
      <Box flexDirection="row" flexWrap="nowrap" width="100%" gap={3}>
        <Box key="cache" flexDirection="row">
          <Text dimColor>cache </Text>
          <Text color={levelColor}>{'█'.repeat(cacheOn)}</Text>
          <Text dimColor>{'░'.repeat(cacheOff)}</Text>
          <Text bold tabular color={levelColor}>
            {minutes === null ? ' —' : ` ${minutes} min`}
          </Text>
        </Box>
        <Box key="context" flexDirection="row">
          <Text dimColor>context </Text>
          <Text color="error">{'█'.repeat(ctxRed)}</Text>
          <Text color="success">{'█'.repeat(ctxGreen)}</Text>
          <Text bold tabular>
            {` ${ctxText}`}
          </Text>
        </Box>
        <Box key="cost" flexDirection="row">
          <Text dimColor>cost </Text>
          <Text bold tabular>
            {cost}
          </Text>
        </Box>
      </Box>
    )
  })
}
