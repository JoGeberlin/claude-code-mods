# Session Meter

A Claude Code mod that keeps a row of small gauges above the prompt, so you can see at a glance whether a session has gone stale, how full its context is, how much of your plan's usage is left and what the session has cost.

Each gauge has its title and two lines of detail beside it:

| Gauge | Inside the gauge | Beside it |
|---|---|---|
| **Cache** | A dial open at the bottom, running from green over yellow to red, with a needle at the minutes since the last response of the main conversation (the moment the main context's fill last changed); the minutes sit in the opening, coloured like the dial. | The level: Fresh, Cooling or Stale, in its colour. |
| **Context** | A green ring that fills red as the context window fills, with the tokens of the last response and the window size (`179k / 1M`). | Percent used and tokens free. |
| **Session** | On a Claude subscription: a ring that fills red with the share of the five-hour usage window used, the percent and reset time inside. | Reset time and the time left until it ("in 4:21 h"). |
| **Week** | The same for the weekly window, with the reset day inside. | Reset day ("Resets Tue") and time ("at 18:00"). |
| **Cost** | — | The session's cost in dollars from Claude Code's own cost ledger (the figure `/cost` shows), and how long the session has run. |

The prompt cache expires after a period of inactivity, after which the next message is billed for the full context again. Cache colours: green below 40 minutes, yellow from 40 to 55, red after 55; the dial ends at 60. Subagent requests do not reset it, as subagents keep their own context. After a restart or resume the dial shows a dash until the next response, as the time of earlier responses is not known.

The session and week gauges appear only when Claude Code has a reading for those windows, which it gets with each model response on a subscription; with an API key there are none. A gateway's spend limit shows as a **spend** gauge the same way.

The gauges update after every model response and once a minute while the session is idle. The Claude desktop app, the editor extension and the mobile app draw them as vector graphics whose text follows the system's light or dark setting; they stay on one row, each group taking the width its text needs. The terminal, which cannot draw vector graphics, shows the same figures on one line with coloured block bars (red for the used part, then green), shortened to fit the window:

```
Cache ██░░░░░░ 12 min   Context ██████ 179k / 1M   Session ████████ 99% 17:40   Week ███████ 30% Tue   Cost $17.98
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

A setting the mod cannot use stops it from loading, with a message naming the setting.

## What it runs, sends and fetches

**Sends:** nothing. The mod makes no network request, calls no service and passes no data to any other program.

**Reads:** only usage figures Claude Code already holds for the session, through these hooks and calls in `hooks/register.tsx`:

| Hook or call | What the mod takes from it | What it is for |
|---|---|---|
| `session.start` and `$.session.usage()` | When the session began; the context window's size and fill; the usage windows' kind, percent used and reset time; the cost total | The first reading when a session opens |
| `session.measure` | The same figures each time Claude Code updates them | Keeping the gauges current; a change in the main context's fill marks a response, which restarts the cache age |
| `ui.render` for `AbovePrompt` | Which surface draws the band (desktop, terminal, …) and its width in columns | Drawing SVG gauges or terminal bars that fit |
| `$.clock.now()` and `$.clock.every(60 s)` | The current time | The cache age, time left to a reset, session length, and a redraw once a minute |

It hooks no turn, tool, prompt or message event, so it never sees the conversation's text, tool calls or files. It reads no environment variables, credentials, settings files or other files, and starts no processes.

**Stores:** nothing on disk. The figures stay in the session's memory and are gone when the session ends.

## Development

`hooks/register.tsx` holds the hooks and the band; `hooks/gauges.ts` draws the SVG gauges and sizes the terminal bars; `hooks/meter.ts` the settings, colour thresholds and formats; `types/index.d.ts` the state contract. Tests are in `hooks/register.test.tsx`:

```
claude plugin validate ./session-meter --strict
claude plugin test ./session-meter
```

## License

MIT, see [LICENSE](../LICENSE).
