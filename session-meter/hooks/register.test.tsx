import { expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'

import { readSettings } from './meter'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = 1_800_000_000_000

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
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
}

/**
 * Stands in for the engine beneath the mod: clock, ledger and usage readings.
 * Nothing answers a network request, so one would fail the test that made it.
 */
function engine(on: On, stub: Stub) {
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed, cwd: '/' }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: stub.context ?? { window: 200_000 },
      rateLimits: stub.rateLimits ?? [],
      ...(stub.costUsd === undefined ? {} : { cost: { usd: stub.costUsd } }),
    },
  }))

  return { clock }
}

type Mounted = {
  find: (q: { type?: string; text?: RegExp }) => Promise<FoundElement | undefined>
  findAll: (q: { type?: string; text?: RegExp }) => Promise<FoundElement[]>
}

async function cell(ui: Mounted, text: RegExp) {
  return ui.find({ type: 'Text', text })
}

/** The band draws cache, context, then one gauge per usage window, in that order. */
async function gauges(ui: Mounted) {
  return (await ui.findAll({ type: 'Svg' })).map(g => ({ alt: String(g.props.alt), source: String(g.props.source) }))
}

async function gauge(ui: Mounted, index: number) {
  const all = await gauges(ui)

  return all[index] ?? { alt: 'missing', source: '' }
}

type Measure = { session: { measure: (e: { context: { window: number; tokens?: number }; rateLimits: never[]; changed: ('context' | 'rateLimits' | 'cost')[] }) => Promise<unknown> } }

/** A main-conversation response as the engine reports it: the main context's fill moves to `tokens`. */
async function respond($: Measure, tokens: number) {
  await $.session.measure({ context: { window: 1_000_000, tokens }, rateLimits: [], changed: ['context'] })
}

/** The local clock reading the mod shows for an ISO time: "17:40". */
function localTime(iso: string) {
  const at = new Date(iso)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

test('cache gauge and bar: green under 40, yellow 40 to 55, red past 55', async ($, on) => {
  const { clock } = engine(on, { costUsd: 1 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await respond($, 10_000)

  const cases: [number, string, string, string][] = [
    [39, 'fresh', 'success', '#16A34A'],
    [40, 'warn', 'warning', '#B7791F'],
    [55, 'warn', 'warning', '#B7791F'],
    [56, 'stale', 'error', '#DC2626'],
  ]
  for (const [minutes, level, color, fill] of cases) {
    await clock.set(START + minutes * MINUTE)
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const dial = await gauge(desktop, 0)
    expect(dial.alt).toBe(`Cache ${minutes} minutes, ${level}`)
    expect(dial.source).toContain(`fill="${fill}">${minutes}m</text>`)
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await cell(terminal, new RegExp(`^ ${minutes} min$`)))?.props.color).toBe(color)
    await terminal.unmount()
  }
})

test('the needle and bar stop at the full scale (gaugeMinutes)', async ($, on) => {
  const { clock } = engine(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await respond($, 10_000)
  await clock.set(START + 90 * MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /^█+$/ })
  expect([bar?.text, bar?.props.color]).toEqual(['█'.repeat(12), 'error'])
  expect((await cell(ui, /^ 90 min$/))?.props.color).toBe('error')
  await ui.unmount()
})

test('a reading whose context fill did not move (a subagent, a usage update) keeps the cache age; no token total is shown', async ($, on) => {
  const { clock } = engine(on, { costUsd: 4.87 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await respond($, 10_000)
  await clock.set(START + 30 * MINUTE)
  await $.session.measure({ context: { window: 1_000_000, tokens: 10_000 }, rateLimits: [], changed: ['cost'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauge(ui, 0)).alt).toBe('Cache 30 minutes, fresh')
  expect(await cell(ui, /Total token use/)).toBeUndefined()
  await ui.unmount()
})

test('cost is Claude Code\'s dollar figure, and the mod makes no network request', async ($, on) => {
  const { clock } = engine(on, { costUsd: 4.87 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.set(START + 2 * 24 * HOUR)
  await clock.settle()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cell(desktop, /^\$/))?.text).toBe('$4.87')
  expect((await cell(desktop, /^Cost$/))?.props.bold).toBe(true)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(terminal, /^\$/))?.text).toBe('$4.87')
  await terminal.unmount()
})

test('before the first response the cache shows a dash and no needle', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const dial = await gauge(desktop, 0)
  expect(dial.alt).toBe('Cache: no response yet')
  expect(dial.source).not.toContain('<line')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(terminal, /^ —$/))?.text).toBe(' —')
  await terminal.unmount()
})

test('settings it cannot use fail the load with the field named', async () => {
  const good = { warnMinutes: 40, staleMinutes: 55, gaugeMinutes: 60 }
  expect(readSettings(good).gaugeMinutes).toBe(60)
  expect(() => readSettings({ ...good, warnMinutes: 55 })).toThrow(/warnMinutes/)
  expect(() => readSettings({ ...good, staleMinutes: -1 })).toThrow(/staleMinutes/)
  expect(() => readSettings({ ...good, gaugeMinutes: 55 })).toThrow(/gaugeMinutes/)
  expect(() => readSettings({ ...good, gaugeMinutes: 'x' })).toThrow(/gaugeMinutes/)
})

test('context ring and bar: red share, tokens and window', async ($, on) => {
  engine(on, { context: { tokens: 231_200, window: 1_000_000, percent: 23 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ring = await gauge(desktop, 1)
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
  const ring = await gauge(ui, 1)
  expect(ring.alt).toBe('Context: no response yet, window 1M')
  expect(ring.source).not.toContain('stroke="#E24B4A"')
  await ui.unmount()
})

test('session and week usage: percent used, reset time, red share', async ($, on) => {
  const sessionReset = new Date(START + 3 * HOUR).toISOString()
  const weekReset = new Date(START + 4 * 24 * HOUR).toISOString()
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(weekReset).getDay()]
  engine(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 99.4, resetsAt: sessionReset },
      { kind: 'seven_day', percentUsed: 30, resetsAt: weekReset },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const [, , session, week] = await gauges(desktop)
  expect(session?.alt).toBe(`Session usage 99%, resets ${localTime(sessionReset)}`)
  expect(session?.source).toContain(`>${localTime(sessionReset)}</text>`)
  expect(week?.alt).toBe(`Week usage 30%, resets ${weekday}`)
  expect((await cell(desktop, /^Session$/))?.props.bold).toBe(true)
  expect((await cell(desktop, /^Resets \d/))?.text).toBe(`Resets ${localTime(sessionReset)}`)
  expect((await cell(desktop, /^in 3:00 h$/))?.text).toBe('in 3:00 h')
  expect((await cell(desktop, new RegExp(`^Resets ${weekday}$`)))?.text).toBe(`Resets ${weekday}`)
  expect((await cell(desktop, /^at \d/))?.text).toBe(`at ${localTime(weekReset)}`)
  expect(week?.source).toContain('stroke="#E24B4A"')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await cell(terminal, /^ 99% /))?.text).toBe(` 99% ${localTime(sessionReset)}`)
  expect((await cell(terminal, /^ 30% /))?.text).toBe(` 30% ${weekday}`)
  // The bars shrink so the line fits the band's 120 columns; the session bar is all red.
  const line = (await terminal.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(line.length).toBeLessThanOrEqual(120)
  const red = (await terminal.findAll({ type: 'Text', text: /^█+$/ })).filter(b => b.props.color === 'error')
  expect(red.length).toBe(2)
  await terminal.unmount()
})

test('off a subscription there are no usage gauges', async ($, on) => {
  engine(on, { rateLimits: [] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauges(ui)).length).toBe(2)
  await ui.unmount()
})

test('usage readings follow session.measure', async ($, on) => {
  engine(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 1_000_000, tokens: 10_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 64 }],
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauge(ui, 2)).alt).toBe('Session usage 64%')
  await ui.unmount()
})

test('details beside the gauges: cache level, context free, session length', async ($, on) => {
  const { clock } = engine(on, { costUsd: 17.98, context: { window: 1_000_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await respond($, 179_000)

  const cases: [number, string][] = [
    [12, 'Fresh'],
    [47, 'Cooling'],
    [58, 'Stale'],
  ]
  for (const [minutes, level] of cases) {
    await clock.set(START + minutes * MINUTE)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await cell(ui, new RegExp(`^${level}$`)))?.text).toBe(level)
    expect(await cell(ui, /^(Yellow|Red) (in|for) /)).toBeUndefined()
    await ui.unmount()
  }

  await clock.set(START + 2 * HOUR + 14 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const text of ['Cache', 'Context', 'Cost', '18% used', '821k free', '$17.98', 'Session 2:14 h']) {
    expect((await cell(ui, new RegExp(`^${text.replace('$', '\\$')}$`)))?.text).toBe(text)
  }
  await ui.unmount()
})

test('a resumed session does not count its first reading as a response', async ($, on) => {
  const { clock } = engine(on, { context: { tokens: 400_000, window: 1_000_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.set(START + 5 * MINUTE)
  await $.session.measure({ context: { window: 1_000_000, tokens: 400_000 }, rateLimits: [], changed: ['context', 'rateLimits', 'cost'] })

  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauge(before, 0)).alt).toBe('Cache: no response yet')
  await before.unmount()

  await respond($, 412_000)
  await clock.set(START + 7 * MINUTE)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gauge(after, 0)).alt).toBe('Cache 2 minutes, fresh')
  await after.unmount()
})
