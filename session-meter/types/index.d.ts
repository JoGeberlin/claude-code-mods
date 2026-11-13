export type Context = {
  /** Input tokens the last response was answered over; absent before the first. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** tokens over window as a whole percentage, as the engine gives it. */
  percent?: number
}

/** One plan usage window as the engine reports it (`five_hour`, `seven_day`, `spend_limit`). */
export type Limit = {
  kind: string
  /** 0 to 100; past 100 on an exceeded spend limit. */
  percentUsed: number
  /** ISO 8601 time the window resets. */
  resetsAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': {
      lastResponseAt: number | null
      costUsd: number | null
      tick: number
      context: Shaped<Context | null>
      limits: Shaped<Limit[]>
      /** When the session began, in `$.clock.now()` milliseconds. */
      startedAt: number | null
    }
  }
}
