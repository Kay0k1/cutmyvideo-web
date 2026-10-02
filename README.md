# cutmy.video web

Private product interface built on the open [cutmy-core](https://github.com/Kay0k1/cutmy-core) media engine. Manual selection and export, without AI or Telegram Mini Apps.

## Development

Requires Node 20.19+ and the core HTTP API on `127.0.0.1:8080`.

```sh
npm ci
npm run dev
```

The development server uses port 5173 and proxies `/api` to the backend. Production serves `dist/` and proxies `/api` to the core service under the same origin. Session cookies authorize metadata, processing, and downloads.

```sh
npm run typecheck
npm test
npm run build
```

Design decisions and accessibility references are in [docs/UX.md](docs/UX.md). This repository contains product UI only; media processing belongs in the public core.
