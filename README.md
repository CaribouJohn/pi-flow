# pi-flow

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
implements an opinionated AFK delivery loop on top of GitHub Issues.

You file work, the agent picks it up, implements it on a track branch, a
separate reviewer agent gates the merge, and the loop continues until
everything's done or genuinely blocked on you. The state machine lives in
GitHub labels; the human-gated states (`needs-acceptance`, `review:human`,
`needs-info`) are where the agent stops and a GitHub poller is where it
restarts.

See **[DESIGN.md](DESIGN.md)** for the full design.

This repo is being built **using its own design** — see the [Issues
tab](https://github.com/CaribouJohn/pi-flow/issues) for live tracks.

## Status

Pre-bootstrap. The `claude-skills/` directory holds the prompts the extension
will eventually ship; the extension itself is being implemented across three
tracks (skeleton & tools, AFK loop, setup wizard).

## License

MIT
