# Lenders Snapshot UI

Static Vite + React + TypeScript UI for browsing Silo lender snapshots and preparing pro-rata reward distributions from the bundled `scripts/lender-snapshot/distribution_snapshot.json` file.

## Development

```bash
npm ci
npm run lint
npm run type-check
npm run build
npm run dev
```

The application is intentionally static: it does not make RPC or subgraph calls at runtime.

## Snapshot tooling

Python tooling lives in `scripts/lender-snapshot/`.
