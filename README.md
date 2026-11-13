# claude-code-mods

Mods for Claude Code: plugins whose hooks module changes Claude Code's own interface. This repository is a plugin marketplace, so each mod installs with one line.

| Mod | What it does |
|---|---|
| [session-meter](session-meter/) | Gauges above the prompt: prompt-cache age on a green-to-red dial with a needle, context window fill as a ring with the tokens inside, and the session's cost in euro or dollars. |

## Install a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace JoGeberlin/claude-code-mods
```

For example `/plugin install session-meter --marketplace JoGeberlin/claude-code-mods`. Each mod's README describes what it shows, its settings, and what it runs, sends or fetches.

## License

MIT, see [LICENSE](LICENSE).
