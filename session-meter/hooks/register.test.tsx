import { expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'
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

type Mounted = {
  find: (q: { type?: string; text?: RegExp }) => Promise<FoundElement | undefined>
  findAll: (q: { type?: string; text?: RegExp }) => Promise<FoundElement[]>
}

async function cell(ui: Mounted, text: RegExp) {
  return ui.find({ type: 'Text', text })
}

/** The band draws the cache gauge first, then the context gauge. */
async function gauge(ui: Mounted, which: 'cache' | 'context') {
  const found = (await ui.findAll({ type: 'Svg' }))[which === 'cache' ? 0 : 1]

  return { alt: String(found?.props.alt), source: String(found?.props.source) }
}

/** Every model step answers with usage, as a main-thread or subagent response. */
function respond(on: On) {
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage(1, 1, 0, 0) }
  })
}

test('cache gauge and bar: green under 40, yellow 40 to 55, red past 55', async ($, on) => {
  const clock = engine(on, { costUsd: 1 })
  respond(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 }))

  const cases: [number, string, string, string][] = [
    [39, 'fresh', 'success', '#16A34A'],
    [40, 'warn', 'warning', '#B7791F'],
    [55, 'warn', 'warning', '#B7791F'],
    [56, 'stale', 'error', '#DC2626'],
  ]
  for (const [minutes, level, color, fill] of cases) {
    await clock.set(START + minutes * MINUTE)
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const dial = await gauge(desktop, 'cache')
    expect(dial.alt).toBe(`Cache ${minutes} minutes, ${level}`)
    expect(dial.source).toContain(`fill="${fill}">${minutes}m</text>`)
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await cell(terminal, new RegExp(`^ ${minutes} min$`)))?.props.color).toBe(color)
    await terminal.unmount()
  }
})

test('the needle and bar stop at the full scale (gaugeMinutes)', async ($, on) => {
  const clock = engine(on, {})
  respond(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 }))
  await clock.set(START + 90 * MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /^█+$/ })
  expect([bar?.text, bar?.props.color]).toEqual(['█'.repeat(12), 'error'])
  expect((await cell(ui, /^ 90 min$/))?.props.color).toBe('error')
  await ui.unmount()
})

test('a subagent response does not reset the cache age; no token total is shown', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87 })
  respond(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 }))
  await clock.set(START + 30 * MINUTE)
  await drain($.turn.step({ turnId: 't', index: 1, model: 'opus', messageCount: 2, agentId: 'agent-1' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauge(ui, 'cache')).alt).toBe('Cache 30 minutes, fresh')
  expect(await cell(ui, /Total token use/)).toBeUndefined()
  await ui.unmount()
})

test('cost is shown in euro at the ECB rate', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // 4.87 / 1.1081 = 4.3949...
  expect((await cell(ui, /€$/))?.text).toBe('4.39 €')
  expect((await cell(ui, /^cost$/))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('cost stays in dollars when the rate cannot be fetched', async ($, on) => {
  const clock = engine(on, { costUsd: 4.87, rateStatus: 503, rateBody: '' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(ui, /^\$/))?.text).toBe('$4.87')
  await ui.unmount()
})

test('before the first response the cache shows a dash and no needle', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const dial = await gauge(desktop, 'cache')
  expect(dial.alt).toBe('Cache: no response yet')
  expect(dial.source).not.toContain('<line')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(terminal, /^ —$/))?.text).toBe(' —')
  await terminal.unmount()
})

test('settings it cannot use fail the load with the field named', async () => {
  const good = {
    warnMinutes: 40,
    staleMinutes: 55,
    gaugeMinutes: 60,
    currency: 'EUR',
    rateUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
    rateRefreshHours: 24,
  }
  expect(readSettings(good).gaugeMinutes).toBe(60)
  expect(() => readSettings({ ...good, warnMinutes: 55 })).toThrow(/warnMinutes/)
  expect(() => readSettings({ ...good, staleMinutes: -1 })).toThrow(/staleMinutes/)
  expect(() => readSettings({ ...good, gaugeMinutes: 55 })).toThrow(/gaugeMinutes/)
  expect(() => readSettings({ ...good, currency: 'GBP' })).toThrow(/currency/)
  expect(() => readSettings({ ...good, rateUrl: 'http://x' })).toThrow(/rateUrl/)
})

test('context ring and bar: red share, tokens and window', async ($, on) => {
  engine(on, { context: { tokens: 231_200, window: 1_000_000, percent: 23 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ring = await gauge(desktop, 'context')
  expect(ring.alt).toBe('Context 231k / 1M tokens, 23%')
  expect(ring.source).toContain('>231k</text>')
  expect(ring.source).toContain('>/ 1M</text>')
  expect(ring.source).toContain('stroke="#E24B4A"')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 23% of 12 cells = 2.76, drawn as 3 red and 9 green
  const bars = await terminal.findAll({ type: 'Text', text: /^█+$/ })
  expect(bars.map(b => [b.text.length, b.props.color])).toEqual([[3, 'error'], [9, 'success']])
  expect((await cell(terminal, /^ 231k \/ 1M$/))?.text).toBe(' 231k / 1M')
  await terminal.unmount()
})

test('context before the first response shows the window alone, no red', async ($, on) => {
  engine(on, { context: { window: 1_000_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ring = await gauge(ui, 'context')
  expect(ring.alt).toBe('Context: no response yet, window 1M')
  expect(ring.source).not.toContain('stroke="#E24B4A"')
  await ui.unmount()
})
