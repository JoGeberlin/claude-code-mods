import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { readSettings } from './meter'

const MINUTE = 60_000
const START = 1_800_000_000_000
const ECB = `<Cube><Cube time='2026-11-12'><Cube currency='USD' rate='1.1081'/><Cube currency='JPY' rate='176.96'/></Cube></Cube>`

const BAND = {
  plugin: 'session-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 2,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 2 },
    view: {},
  },
} as const

type Stub = {
  costUsd?: number
  context?: { tokens?: number; window: number; percent?: number }
  rateStatus?: number
  rateBody?: string
}

/** Stands in for the engine beneath the mod: clock, ledger, network and a model step. */
function engine(on: On, stub: Stub) {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: stub.context ?? { window: 200_000 },
      rateLimits: [],
      ...(stub.costUsd === undefined ? {} : { cost: { usd: stub.costUsd } }),
    },
  }))
  on('http.fetch', () => ({
    value: {
      status: stub.rateStatus ?? 200,
      ok: (stub.rateStatus ?? 200) < 300,
      headers: {},
      text: stub.rateBody ?? ECB,
    },
  }))

  return clock
}

/** Reads a streaming event to its end, as the engine does, and gives its result. */
async function drain<C, R>(stream: AsyncGenerator<C, R> & { readonly result: Promise<R> }): Promise<R> {
  for await (const _ of stream) {
    // chunks are not looked at
  }

  return stream.result
}

function usage(input: number, output: number, read: number, write: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    model: 'claude-opus-5-5',
  }
}

async function cell(ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }, text: RegExp) {
  return ui.find({ type: 'Text', text })
}

test('cache age colour: green under 40, yellow 40 to 55, red past 55', async ($, on) => {
  const clock = engine(on, { costUsd: 1 })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage(1, 1, 0, 0) }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 }))

  const cases: [number, string][] = [
    [39, 'success'],
    [40, 'warning'],
    [55, 'warning'],
    [56, 'error'],
  ]
  for (const [minutes, color] of cases) {
    await clock.set(START + minutes * MINUTE)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const found = await cell(ui, new RegExp(`^${minutes} min$`))
    expect(found?.props?.color).toBe(color)
    await ui.unmount()
  }
})

test('tokens add up over steps, subagent steps included; a subagent does not reset cache age', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87 })
  let step = 0
  const usages = [usage(1_000, 2_000, 1_000_000, 90_000), usage(2_100, 46_000, 100_000, 2_000)]
  on('turn.step', async function* (_, e) {
    const u = usages[step++] ?? null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 }))
  await clock.set(START + 30 * MINUTE)
  await drain($.turn.step({ turnId: 't', index: 1, model: 'opus', messageCount: 2, agentId: 'agent-1' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cell(ui, /^Total token use$/))?.text).toBe('Total token use')
  expect((await cell(ui, /^1\.24M$/))?.text).toBe('1.24M')
  expect(await cell(ui, /^Input$|^Output$|^Cache read$|^Cache write$/)).toBeUndefined()
  expect((await cell(ui, /min$/))?.text).toBe('30 min')
  await ui.unmount()
})

test('cost is shown in euro at the ECB rate', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // 4.87 / 1.1081 = 4.3949...
  expect((await cell(ui, /€$/))?.text).toBe('4.39 €')
  await ui.unmount()
})

test('cost stays in dollars when the rate cannot be fetched', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87, rateStatus: 503, rateBody: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cell(ui, /^\$/))?.text).toBe('$4.87')
  await ui.unmount()
})

test('before the first response the cache cell shows a dash', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(ui, /^—$/))?.text).toBe('—')
  await ui.unmount()
})

test('settings it cannot use fail the load with the field named', async () => {
  const good = {
    warnMinutes: 40,
    staleMinutes: 55,
    currency: 'EUR',
    rateUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
    rateRefreshHours: 24,
  }
  expect(readSettings(good).staleMinutes).toBe(55)
  expect(() => readSettings({ ...good, warnMinutes: 55 })).toThrow(/warnMinutes/)
  expect(() => readSettings({ ...good, staleMinutes: -1 })).toThrow(/staleMinutes/)
  expect(() => readSettings({ ...good, currency: 'GBP' })).toThrow(/currency/)
  expect(() => readSettings({ ...good, rateUrl: 'http://x' })).toThrow(/rateUrl/)
})

test('context shows percent, tokens and window', async ($, on) => {
  engine(on, { context: { tokens: 231_200, window: 1_000_000, percent: 23 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cell(ui, /\/ 1M$/))?.text).toBe('23% · 231.2k / 1M')
  await ui.unmount()
})

test('context before the first response shows the window alone', async ($, on) => {
  engine(on, { context: { window: 1_000_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cell(ui, /\/ 1M$/))?.text).toBe('— / 1M')
  await ui.unmount()
})
