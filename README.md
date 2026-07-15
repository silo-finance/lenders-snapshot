# Lenders Snapshot UI

Static Vite + React + TypeScript UI for browsing Silo lender snapshots. Each snapshot category (e.g. `stream`) is rendered under its own path and bundled from its per-category `scripts/lender-snapshot/data/<slug>.json` file.

The app performs no runtime RPC, subgraph, or API calls. Snapshot data is imported into the Vite bundle at build time.

## Overview

This application helps lenders review balances used to prepare recovery claims related to the Stream Finance default. It covers three claim categories that correspond to different collateral families: Stream-issued assets (such as xUSD and xBTC), Trevee-issued assets, and Pendle-issued assets. SiloDAO uses the Stream balances to submit claims on behalf of affected lenders. Trevee and Pendle lenders should use the balances shown here to verify their positions and follow each project's instructions for its recovery process.

For each lender, the application starts with the value of their position at a fixed snapshot moment. It then accounts for later deposits, withdrawals, transfers, borrowing activity, repayments, and any distributions already received through the end of a defined review period. The result is shown as the **Claim Amount**.

The calculations are prepared before the application is built. The browser only displays the resulting snapshot files and does not fetch live blockchain data. The [full methodology document](Methodology%20for%20Calculating%20Stream%20Finance%20Recovery%20Claims%20for%20Silo%20Lenders.docx.md) and the [affected markets list](https://docs.google.com/spreadsheets/d/12KokCexdD5ON2tG8mfpHakpkV5V0Lt43/edit?gid=749859997#gid=749859997) provide additional detail. A summary of how claim amounts are calculated and the important limitations are described below.

## How claim amounts are calculated

### 1. Starting balance

All markets share a common snapshot moment: **7 November 2025, 11:33:16 UTC**. Because the affected markets operate on different networks, each network uses the block that corresponds to that moment (for example, Sonic block 54,144,258). The UI shows the snapshot block for each market.

For a direct lender, the starting balance is the value that could have been redeemed from their collateral position at that moment. For someone who deposited through a managed vault, it is their proportional share of the amount that the vault had lent into that market.

Vault contracts are not treated as claim recipients. Their balances are assigned to the underlying depositors whenever those depositors can be identified.

### 2. Activity after the snapshot

The starting balance is adjusted for activity from the block after the snapshot through the end of a fixed review period, matched to the same moment in time on every network (Sonic reference block 75,700,045). **Claim Amount therefore reflects balances at the end of this review period, not the snapshot moment alone.**

During that period:

- deposits and incoming transfers increase the claim amount;
- withdrawals and outgoing transfers reduce it;
- in three Stream markets that allowed xUSD borrowing, outstanding debt at the snapshot and later borrows reduce the claim amount, while repayments increase it.

Deposits, withdrawals, borrows, and repayments use the asset amounts recorded in their transactions. Transfers between wallets contain only a number of shares, so they are converted to an asset value using the exchange rate from the snapshot moment. Interest and vault fees are not added as separate lines, but the transaction amounts above can still reflect activity that occurred after the snapshot.

In the three xUSD borrowing markets, borrowed amounts are converted into the lender asset's units on a one-to-one value basis. Where post-incident borrowing exceeded the value of the snapshot position, the result may be a large negative claim amount.

In simple terms:

```text
Claim Amount =
  starting balance
  - outstanding debt at the snapshot
  + deposits + incoming transfers + repayments
  - withdrawals - outgoing transfers - new borrows
  - distributions already received
```

The result is signed: it is not reduced to zero when the calculation produces a negative amount.

### 3. Distributions already received

If a lender has already received an eligible distribution through Silo, that amount is deducted to avoid counting the same value twice. Deductions are applied across compatible positions in the order **Trevee → Pendle → Stream**. Each category before the last compatible one is reduced only up to its positive claim balance; the final compatible category absorbs any remainder and may therefore show a negative claim amount. Each deduction appears as a distribution entry in the lender's operation history in the UI.

### 4. What the application shows

Select a category (Stream, Trevee, or Pendle), choose a market, and filter by wallet address to review your position. The UI displays:

- **Net Deposited Assets** — starting balance at the snapshot moment, before debt and later activity;
- **Debt** — outstanding xUSD debt at the snapshot, for the three borrowing markets only (later borrows and repayments appear in the breakdown);
- **Claim Amount** — final value after all tracked adjustments through the end of the review period;
- **Calculation breakdown** — deposits, withdrawals, transfers, debt, borrows, repayments, and distributions, in chronological order.

The generated data stores Claim Amount under the internal name `pending_assets`. Both names refer to the same value.

### 5. Verifying the calculations

Anyone may review the figures in the public UI, export CSVs, inspect the [open-source calculation scripts](scripts/lender-snapshot/), or read the [full methodology document](Methodology%20for%20Calculating%20Stream%20Finance%20Recovery%20Claims%20for%20Silo%20Lenders.docx.md). Regenerating the snapshot from on-chain data requires historical network access and credentials described in the script documentation. Published snapshot files are checked by an automated quality-assurance process that verifies exact accounting for every lender and vault depositor.

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
- Direct lender and vault depositor tables with address filtering and sortable shares/assets.
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
