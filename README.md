# DVR Revival

A web client and bridge for Raysharp-made recorders, such as the Swann
DVR8-4575. Their own apps and browser plugins have stopped working, so this
talks to the recorder directly: recorder health, recordings, motion and PIR
events, and live view, from any browser or as an app on your phone.

A small server sits between the recorder and the page. It holds one logged-in
session on the recorder's control port, passes on what it reports, and runs
[go2rtc](https://github.com/AlexxIT/go2rtc) for live video.

## Running it

You need [mise](https://mise.jdx.dev). Copy `.env.example` to `.env.local` and
fill in your recorder's address and login, then:

```sh
mise install
mise run build
mise run serve:server
```

Open <https://server.dvr-revival.localhost>. The docs in [`docs/`](docs) cover
the settings, the API and the protocol.

## Parts

- [`packages/rsnet`](packages/rsnet): the recorder's control protocol, in
  TypeScript with [Effect](https://effect.website)
- [`packages/server`](packages/server): the server, with the recorder session,
  go2rtc and the API
- [`packages/web`](packages/web): the web client, installable on a phone
- [`packages/cli`](packages/cli): the `dvr-revival` CLI, with Code Mode and
  MCP for agents, and its [skill](skills/dvr-revival/SKILL.md)
- [`docs`](docs): the docs site

## Developing

```sh
mise run check   # lint, types, formatting and the docs
mise run test
```

The plan and what's left are in
[timmo001/dvr-revival#1](https://github.com/timmo001/dvr-revival/issues/1).
