# HotOrNot web

Plain JavaScript on Node 24 built-ins: no dependencies, no build step. Deploys to Vercel with no
framework: `public/` is static, `api/*.js` are functions.

```
node server.js            # http://localhost:3000, static files plus /api/*
npm test                  # node --test tests/
npm run check             # node --check on every .js file outside public/vendor/
npm run mocks             # regenerate mocks/*.json
npm run vendor            # re-download public/vendor/ and rewrite its manifest
```

- `public/shared/contracts.js`: validators and shape checks for the API and published data.
  Used by the browser and the server.
- `api/`: one file per route, exporting `GET` or `POST(request)` that returns a `Response`.
  They serve `mocks/` until the data layer lands.
- `public/vendor/`: MapLibre GL (global `maplibregl`), terra-draw (`terraDraw`,
  `terraDrawMaplibreGlAdapter`) and ECharts (`echarts`), pinned in `manifest.json`.
- `DATA_BASE_URL`: where published data lives, an `https://` URL or a local directory
  (default `./public/data`). Unused while the routes serve mocks.
