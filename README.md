# Lenders Snapshot UI

Static Vite + React + TypeScript UI for browsing Silo lender snapshots and preparing pro-rata airdrop distributions from the bundled `scripts/lender-snapshot/distribution_snapshot.json` file.

The app performs no runtime RPC, subgraph, or API calls. Snapshot data is imported into the Vite bundle at build time.

## Features

- Chain and silo browsing for bundled snapshot data.
- Direct lender and vault depositor tables with address filtering and sortable shares/assets.
- Explorer links for supported chains.
- Vault warning cards when depositors cannot be enumerated.
- Pro-rata airdrop calculation by raw asset balances using `BigInt`.
- CSV export for leaf recipients, excluding vault contracts and including vault depositors.

## Development

```bash
npm ci
npm run lint
npm run type-check
npm run build
npm run dev
```

## Automation

- `ci.yml` runs lint, type-check, and build on PRs to `master`.
- `deploy-pages.yml` builds and deploys the static Vite app to GitHub Pages.
- `version-bump.yml` sets `package.json` (and the lockfile) to the version in the `release/X.Y.Z` or `hotfix/X.Y.Z` branch name on PRs to `master`; non-release PRs fall back to an automatic patch bump.
- `snapshot-scan.yml` manually generates a fresh snapshot release asset.
- `snapshot-qa.yml` validates PR changes to `distribution_snapshot.json`.

## Snapshot tooling

Python tooling lives in `scripts/lender-snapshot/`.
