export type Rate = {
  /** US dollars per euro, as the ECB publishes it. */
  usdPerEur: number
  /** The ECB's reference date of the rate (YYYY-MM-DD). */
  date: string
  /** When the rate was fetched, in `$.clock.now()` milliseconds. */
  fetchedAt: number
}

export type Context = {
  /** Input tokens the last response was answered over; absent before the first. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** tokens over window as a whole percentage, as the engine gives it. */
  percent?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': {
      lastResponseAt: number | null
      costUsd: number | null
      rate: Shaped<Rate | null>
      tick: number
      context: Shaped<Context | null>
    }
  }
}
