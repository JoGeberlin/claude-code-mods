# claude-code-mods

Mods for Claude Code: plugins whose hooks module changes Claude Code's own interface. This repository is a plugin marketplace, so each mod installs with one line.

| Mod | What it does |
|---|---|
| [session-meter](session-meter/) | Two-line table above the prompt: prompt-cache age (green, yellow, red), total token use, context window fill and the session's cost in euro or dollars. |

## Install a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace iwanlenin/claude-code-mods
```

For example `/plugin install session-meter --marketplace iwanlenin/claude-code-mods`. Each mod's README describes what it shows, its settings, and what it runs, sends or fetches.

## License

MIT, see [LICENSE](LICENSE).
