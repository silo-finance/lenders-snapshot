# Lenders Snapshot UI

Static Vite + React + TypeScript UI for browsing Silo lender snapshots. Each snapshot category (e.g. `stream`) is rendered under its own path and bundled from its per-category `scripts/lender-snapshot/data/<slug>.json` file.

The app performs no runtime RPC, subgraph, or API calls. Snapshot data is imported into the Vite bundle at build time.

## Overview

This application helps lenders review balances used to prepare recovery claims related to the Stream Finance default. It covers three claim categories: Stream, Trevee, and Pendle. SiloDAO uses the Stream balances to submit claims on behalf of affected lenders, while Trevee and Pendle lenders should use the relevant project instructions for their claim process.

For each lender, the application starts with the value of their position at a fixed snapshot moment. It then accounts for later deposits, withdrawals, transfers, borrowing activity, repayments, and any distributions already received. The result is shown as the **Claim Amount**.

The calculations are prepared before the application is built. The browser only displays the resulting snapshot files and does not fetch live blockchain data. The detailed methodology and its important limitations are described below.

## How claim amounts are calculated

### 1. Starting balance

Each market is measured at a fixed snapshot moment. Markets on different networks use different block numbers matched to the same point in time.

For a direct lender, the starting balance is the value that could have been redeemed from their collateral position at that moment. For someone who deposited through a managed vault, it is their proportional share of the amount that the vault had lent into that market.

Vault contracts are not treated as claim recipients. Their balances are assigned to the underlying depositors whenever those depositors can be identified.

### 2. Activity after the snapshot

The starting balance is adjusted for activity between the snapshot and the end of the review period:

- deposits and incoming transfers increase the claim amount;
- withdrawals and outgoing transfers reduce it;
- in markets that also include borrowing, outstanding debt at the snapshot and later borrows reduce the claim amount, while repayments increase it.

Deposits, withdrawals, borrows, and repayments use the asset amounts recorded in their transactions. Transfers between wallets contain only a number of shares, so they are converted to an asset value using the exchange rate from the snapshot moment.

In simple terms:

```text
Claim Amount =
  starting balance
  - outstanding debt at the snapshot
  + deposits + incoming transfers + repayments
  - withdrawals - outgoing transfers - new borrows
  - distributions already received
```

Debt, borrowing, and repayment adjustments apply only to the relevant Stream markets.

### 3. Distributions already received

If a lender has already received an eligible distribution, that amount is deducted to avoid counting the same value twice. These deductions are applied across the Trevee, Pendle, and Stream categories in that order. The final applicable category absorbs any remaining deduction, which can produce a negative claim amount.

### 4. What the application shows

**Net Deposited Assets** is the lender's starting balance at the snapshot moment. **Claim Amount** is the final value after all tracked adjustments. Expanding a lender row shows the individual operations used in the calculation.

The generated data stores Claim Amount under the internal name `pending_assets`. Both names refer to the same value.

### Important limitations and disclaimers

- Interest earned after the snapshot moment is not included. Negative claim amounts may therefore reflect interest timing or over-accrual related to the Stream Finance incident.
- In some borrowing markets, an asset depeg and sharply higher interest rates allowed borrowers to take out more than their snapshot collateral was worth. A negative result can therefore be a valuation-timing effect rather than evidence of missing data.
- Managed vaults may issue or transfer fee-related shares. Because accrued vault fees and interest are not tracked as separate operations, a fee recipient can show a negative claim amount as an accounting artifact.
- Transfers are valued using the exchange rate at the snapshot moment. Deposits, withdrawals, borrows, and repayments use the actual asset amounts recorded in their transactions.
- When a vault lends into several markets, its remaining claim may be assigned to one market for calculation purposes only.
- Some vaults cannot provide a complete depositor list. Their assets are still displayed, but individual depositors may not be shown.
- Share creation and removal that happen as part of deposits and withdrawals are not counted as separate transfers, which prevents the same activity from being applied twice.
- A small number of economically immaterial contract positions do not follow the standard vault accounting model. These known cases are identified explicitly and reported as validation warnings; any change to them causes validation to fail.
- The data collection process can be repeated to capture additional activity. Rare infrastructure gaps may still exist; the operator-level limitations and validation rules are documented in [`scripts/lender-snapshot/README.md`](scripts/lender-snapshot/README.md).

## Features

- Chain and silo browsing for bundled snapshot data.
- Direct lender and vault depositor tables with address filtering and sortable shares, net deposited assets, and claim amounts.
- Explorer links for supported chains.
- Vault warning cards when depositors cannot be enumerated.
- CSV export for lenders and vault depositors.

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
- `snapshot-qa.yml` validates PR changes to `scripts/lender-snapshot/data/*.json`.

## Snapshot tooling

Python tooling lives in `scripts/lender-snapshot/`.


# Claims

## Recovery Claims (Stream Finance)

SiloDAO has submitted recovery claims through its legal counsel on behalf of affected lenders. Users do not need to submit individual claims. For transparency, all submitted Claim Amounts are publicly available through the Lender Snapshots UI and the exported claims spreadsheet:
• Lender Snapshots UI: https://silo-finance.github.io/lenders-snapshot/
• Claims Export: [stream-all-claims.csv](/csv/stream-all-claims.csv)
