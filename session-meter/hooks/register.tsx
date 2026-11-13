import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Limit } from '../types'
import { GAUGE_PX, barCells, cacheGauge, contextGauge, limitGauge } from './gauges'
import {
  MINUTE_MS,
  cacheFraction,
  contextDetails,
  formatSpan,
  levelName,
  resetDetails,
  cacheLevel,
  cacheMinutes,
  compactTokens,
  contextFraction,
  formatCost,
  formatReset,
  limitFraction,
  limitLabel,
  limitPercent,
  readSettings,
} from './meter'
import type { CacheLevel } from './meter'

/** Longest and shortest terminal bar, in cells. */
const BAR_MAX = 12
const BAR_MIN = 3
/** Cells between the terminal line's groups. */
const GROUP_GAP = 3

const lastResponseAt = atom(
  { plugin: 'session-meter', key: 'lastResponseAt' } as const,
  null as number | null,
)
const costUsd = atom({ plugin: 'session-meter', key: 'costUsd' } as const, null as number | null)
const tick = atom({ plugin: 'session-meter', key: 'tick' } as const, 0)
const context = atom({ plugin: 'session-meter', key: 'context' } as const, null as Context | null, {
  shape: 'context-1',
})
const limits = atom({ plugin: 'session-meter', key: 'limits' } as const, [] as Limit[], {
  shape: 'limits-1',
})
const startedAt = atom({ plugin: 'session-meter', key: 'startedAt' } as const, null as number | null)

type Usage = {
  startedAt?: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const LEVEL_COLOR: Record<CacheLevel, 'success' | 'warning' | 'error'> = {
  fresh: 'success',
  warn: 'warning',
  stale: 'error',
}

/** Keeps the engine's own readings: context fill, plan usage windows, cost. */
async function keep($: EngineInterface, usage: Usage): Promise<void> {
  const fill: Context = {
    window: usage.context.window,
    ...(usage.context.tokens === undefined ? {} : { tokens: usage.context.tokens }),
    ...(usage.context.percent === undefined ? {} : { percent: usage.context.percent }),
  }
  const windows: Limit[] = usage.rateLimits.map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
  }))
  await update($, context, () => fill)
  await update($, limits, () => windows)
  if (usage.startedAt !== undefined) {
    const began = usage.startedAt
    await update($, startedAt, () => began)
  }
  if (usage.cost !== undefined) {
    const usd = usage.cost.usd
    await update($, costUsd, () => usd)
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await keep($, await $.session.usage())
    $.clock.every(MINUTE_MS, () => {
      void update($, tick, n => n + 1)
    })

    return result
  })

  // The cache age counts from the last main-conversation response. The mod learns of one
  // from the engine's figures alone: the main context's fill moves only when a response
  // of the main conversation arrives (subagents keep their own context). It hooks no
  // turn event, so it never sees the conversation's text.
  on('session.measure', async ($, e, next) => {
    const before = await read($, context)
    if (e.context.tokens !== undefined && e.context.tokens !== before?.tokens) {
      const now = await $.clock.now()
      await update($, lastResponseAt, () => now)
    }
    await keep($, e)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const last = await read($, lastResponseAt)
    const usd = await read($, costUsd)
    const fill = await read($, context)
    const windows = await read($, limits)
    const began = await read($, startedAt)
    const now = await $.clock.now()

    const minutes = last === null ? null : cacheMinutes(last, now)
    const level = minutes === null ? null : cacheLevel(minutes, settings)
    const cost = formatCost(usd)
    const columns = 3 + windows.length

    // The terminal has no Svg element: it draws block bars below instead.
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve({ ...e, surface: e.surface })
      const levelColor = level === null ? undefined : LEVEL_COLOR[level]
      const [used, free] = contextDetails(fill)
      type Line = { text: string; color?: 'success' | 'warning' | 'error' }
      type Group = { key: string; source: string; alt: string; title: string; lines: Line[] }
      const cells: Group[] = [
        {
          key: 'cache',
          ...cacheGauge(minutes, level, settings),
          title: 'Cache',
          lines: [
            { text: level === null ? 'No response yet' : levelName(level), color: levelColor },
          ],
        },
        { key: 'context', ...contextGauge(fill), title: 'Context', lines: [{ text: used }, { text: free }] },
        ...windows.map(l => {
          const [resets, left] = resetDetails(l, now)
          return { key: `limit-${l.kind}`, ...limitGauge(l, now), title: limitLabel(l), lines: [{ text: resets }, { text: left }] }
        }),
      ]

      // One row: each group takes the width its words need, the rest of the band is shared
      // between the groups, and a small fixed gap keeps neighbours apart.
      return (
        <Box flexDirection="row" flexWrap="nowrap" width="100%" alignItems="center" justifyContent="space-between" paddingX="sm" columnGap="sm">
          {cells.map(c => (
            <Box key={c.key} flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
              <Svg source={c.source} alt={c.alt} width={GAUGE_PX} height={GAUGE_PX} />
              <Box flexDirection="column">
                <Text bold>{c.title}</Text>
                {c.lines.map((line, i) => (
                  <Text key={`${c.key}-${i}`} dimColor={line.color === undefined} color={line.color}>
                    {line.text}
                  </Text>
                ))}
              </Box>
            </Box>
          ))}
          <Box key="cost" flexDirection="column" flexShrink={0}>
            <Text bold>Cost</Text>
            <Text bold tabular>
              {cost}
            </Text>
            <Text dimColor>{began === null ? '' : `Session ${formatSpan(now - began)}`}</Text>
          </Box>
        </Box>
      )
    }

    const ctxText =
      fill === null
        ? '—'
        : `${fill.tokens === undefined ? '—' : compactTokens(fill.tokens)} / ${compactTokens(fill.window)}`
    const cacheText = minutes === null ? ' —' : ` ${minutes} min`
    const limitTexts = windows.map(l => {
      const reset = formatReset(l, now)
      return { limit: l, name: `${limitLabel(l)} `, text: ` ${limitPercent(l)}${reset === '' ? '' : ` ${reset}`}` }
    })

    // The bars share what the band's width leaves after the words.
    const words =
      'Cache '.length + cacheText.length + 'Context '.length + ctxText.length + 1 + 'Cost '.length + cost.length +
      limitTexts.reduce((n, t) => n + t.name.length + t.text.length, 0) + GROUP_GAP * (columns - 1)
    const bars = 2 + windows.length
    const cells = Math.max(BAR_MIN, Math.min(BAR_MAX, Math.floor((e.props.bodyColumns - words) / bars)))

    const [cacheOn, cacheOff] = barCells(minutes === null ? 0 : cacheFraction(minutes, settings), cells)
    const [ctxRed, ctxGreen] = barCells(contextFraction(fill) ?? 0, cells)
    const levelColor = level === null ? undefined : LEVEL_COLOR[level]

    return (
      <Box flexDirection="row" flexWrap="nowrap" width="100%" gap={GROUP_GAP}>
        <Box key="cache" flexDirection="row">
          <Text dimColor>Cache </Text>
          <Text color={levelColor}>{'█'.repeat(cacheOn)}</Text>
          <Text dimColor>{'░'.repeat(cacheOff)}</Text>
          <Text bold tabular color={levelColor}>
            {cacheText}
          </Text>
        </Box>
        <Box key="context" flexDirection="row">
          <Text dimColor>Context </Text>
          <Text color="error">{'█'.repeat(ctxRed)}</Text>
          <Text color="success">{'█'.repeat(ctxGreen)}</Text>
          <Text bold tabular>
            {` ${ctxText}`}
          </Text>
        </Box>
        {limitTexts.map(t => {
          const [red, green] = barCells(limitFraction(t.limit), cells)
          return (
            <Box key={`limit-${t.limit.kind}`} flexDirection="row">
              <Text dimColor>{t.name}</Text>
              <Text color="error">{'█'.repeat(red)}</Text>
              <Text color="success">{'█'.repeat(green)}</Text>
              <Text bold tabular>
                {t.text}
              </Text>
            </Box>
          )
        })}
        <Box key="cost" flexDirection="row">
          <Text dimColor>Cost </Text>
          <Text bold tabular>
            {cost}
          </Text>
        </Box>
      </Box>
    )
  })
}
