# Session Meter

A Claude Code mod that keeps three small gauges above the prompt, so you can see at a glance whether a session has gone stale, how full its context is and what it has cost.

| Gauge | What it shows |
|---|---|
| **cache** | A dial open at the bottom, running from green over yellow to red, with a needle at the minutes since the last model response of the main conversation; the minutes sit in the dial's opening, coloured like the dial. The prompt cache expires after a period of inactivity, after which the next message is billed for the full context again. Green below 40 minutes, yellow from 40 to 55, red after 55; the dial ends at 60. Subagent requests do not reset it. |
| **context** | A green ring that fills red as the context window fills, with the tokens of the last response and the window size inside (`231k / 1M`), as Claude Code reports them. |
| **cost** | The session's cost from Claude Code's own cost ledger (the figure `/cost` shows), converted to euro at the European Central Bank's daily reference rate, or shown in dollars. |

The gauges update after every model response and once a minute while the session is idle. The Claude desktop app, the editor extension and the mobile app draw them as vector graphics whose text follows the system's light or dark setting. The terminal, which cannot draw vector graphics, shows the same figures on one line with coloured block bars (the context bar's red part first, then green):

```
cache ██░░░░░░░░░░ 12 min   context ████████████ 231k / 1M   cost 4.39 €
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-meter --marketplace JoGeberlin/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-meter --marketplace JoGeberlin/claude-code-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `JoGeberlin/claude-code-mods`, then Add plugin.

## Settings

Each setting uses its default until you change it with `/plugin configure session-meter@jogeberlin-mods` in Claude Code, or `--config KEY=VALUE` on `claude plugin install`:

| Setting | Default | Meaning |
|---|---|---|
| `warnMinutes` | 40 | From this cache age the cache dial and its figure turn yellow. |
| `staleMinutes` | 55 | After this cache age they turn red. Must be above `warnMinutes`. |
| `gaugeMinutes` | 60 | The cache age at the dial's right end and the bar's full length; the needle stops there. Must be above `staleMinutes`. |
| `currency` | `EUR` | `EUR` converts the cost to euro; `USD` shows Claude Code's dollar figure and fetches nothing. |
| `rateUrl` | ECB daily XML | Where the euro rate is read from. Must be an `https://` URL. |
| `rateRefreshHours` | 24 | A stored rate older than this is fetched again. |

A setting the mod cannot use stops it from loading, with a message naming the setting.

## What it runs, sends and fetches

- **Network:** with `currency` set to `EUR`, the mod sends one plain GET request to `rateUrl` (by default `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`, the European Central Bank's public reference rates) at session start and then at most once per `rateRefreshHours`. The request carries no data about you, your session or your code. With `USD`, it makes no network request at all.
- **Stored data:** the fetched USD-per-euro rate, its reference date and the fetch time, kept in the plugin's own Claude Code store on your computer. Cache age, context fill and cost stay in the session's memory.
- **Nothing else:** the mod reads only usage figures Claude Code already has. It reads no files, runs no programs and sends nothing to any other service.

## Development

`hooks/register.tsx` holds the hooks and the band; `hooks/gauges.ts` draws the two SVG gauges and sizes the terminal bars; `hooks/meter.ts` the settings, colour thresholds, formats and the ECB parser; `types/index.d.ts` the state contract. Tests are in `hooks/register.test.tsx`:

```
claude plugin validate ./session-meter --strict
claude plugin test ./session-meter
```

## License

MIT, see [LICENSE](../LICENSE).
