# Glowboot relay

Tiny Cloudflare Worker that pairs up two browser tabs sharing a room
code and shuttles bytes between them. It's the optional cross-device
backend for the [Glowboot](https://github.com/glowboot/glowboot)
emulator's link cable — Tetris between two laptops, Pokémon trades
between phones, that sort of thing.

The Worker is **transport-only**: it doesn't parse Game Boy serial
bytes or WebRTC signalling payloads. Whatever one client sends, the
other receives byte-for-byte. The protocol contract lives in the
emulator repo (`src/ui/session/webrtc-link.ts`).

## How it works

- One Durable Object per room code (`idFromName(roomCode)`), so every
  edge location lands the same code on the same instance.
- First two WebSockets paired; a third joiner gets a `room-full`
  message and is closed.
- Each side learns about the other through `joined` / `peer-joined` /
  `peer-left` JSON frames; everything else is forwarded verbatim.
- Hibernating-WebSocket API (`acceptWebSocket`) — quiet rooms cost
  nothing; an idle sweeper closes sockets after 5 minutes of silence.
- 4 KB per-message cap, origin allowlist, lowercased room codes
  matching `[A-Za-z0-9_-]{1,32}`.

## Deploy

Requirements: Node.js 18+ and a Cloudflare account.

```sh
npm install
npx wrangler login   # first time only
npm run deploy
```

The Worker name (`relay` in `wrangler.jsonc`) plus your account's
`workers.dev` subdomain determine the deployed URL — e.g.
`https://relay.<your-subdomain>.workers.dev`. Wrangler prints the
exact URL after deploy.

For local testing:

```sh
npm run dev
```

## Configure

Two things to edit before deploying for your own use:

- **`ALLOWED_ORIGINS` in `src/index.ts`** — the list of origins
  permitted to open a relay socket. Defaults to
  `https://glowboot.pages.dev`. Edit when the app moves.
- **`name` in `wrangler.jsonc`** — the deployed Worker's name and
  therefore the URL. Defaults to `relay`.

Plug the resulting `wss://` URL into the emulator build's
`VITE_LINK_RELAY_URL` env var — the client appends `/link/<roomCode>`
itself.

## Scripts

| Command                | Description                    |
| ---------------------- | ------------------------------ |
| `npm run dev`          | Wrangler dev server (local DO) |
| `npm run deploy`       | Deploy to Cloudflare           |
| `npm run lint`         | ESLint over the project        |
| `npm run lint:fix`     | ESLint with `--fix`            |
| `npm run format`       | Prettier write across the repo |
| `npm run format:check` | Prettier check (no writes)     |

## License

[MIT License](./LICENSE) © 2026 the Glowboot authors.
