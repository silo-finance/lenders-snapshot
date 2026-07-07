# Lender snapshot (Trevee)

Builds block-pinned snapshots of all lenders for configured Silos, splitting them into:

- **direct lenders** – every account holding collateral shares of the Silo, and
- **SiloVault depositors** – holders of any SiloVault that itself lends into the Silo, attributed by their share of the vault.

Redeemable `assets` per address are computed purely via on-chain `previewRedeem` at the snapshot block. The subgraph is only used to enumerate addresses (lenders of the Silo and depositors of each vault).

After the snapshot is assembled, the script also scans post-snapshot events (`snapshot_block + 1` to latest) on:

- the Silo contract (for direct lenders), and
- each indexed vault contract (for vault depositors).

It records `Withdraw(...)`, `Deposit(...)`, and peer-to-peer share `Transfer(...)` events to reconcile post-snapshot position changes. These flows are merged into the same per-category `data/<slug>.json` consumed by the UI (`total_withdrawals`, `total_deposits`, `total_transfers_in`, `total_transfers_out`, `pending_assets`, and the per-event `withdrawals[]` / `deposits[]` / `transfers[]` breakdowns).

Withdrawal attribution differs by lender type:

- **direct lenders:** the raw on-chain `Withdraw` event `assets` (a silo-level withdrawal in the silo asset) is subtracted directly from `assets_collateral`.
- **vault depositors:** a SiloVault can lend into several silos, and one vault `Withdraw` burns vault shares for the vault's *total* underlying across all of them. Subtracting the raw event assets from every silo entry would both double-count across silos and credit withdrawals to silos where the vault held nothing at the snapshot block. Instead, the burned vault shares are valued at the snapshot per-share rate and translated into the assets attributable to **this** silo: `assets = vault_silo_assets * shares_burned / vault_total_supply`. This scales each silo by its own position (no cross-silo double counting) and yields `0` for silos where the vault held nothing/dust at the snapshot block, so a depositor can never show withdrawals exceeding a zero snapshot position.

For vault depositors, each `withdrawals[]` entry also keeps the raw on-chain amount for reference (`vault_assets`); only `assets` reduces `pending_assets`.

## Layout

- `snapshot_lenders.py` – main script that produces one `data/<category>.json` per category.
- `qa_check.py` – pure-JSON validator (no RPC/graph) that asserts share-sum invariants against the stored total supplies.
- `data/` – generated per-category snapshot files (e.g. `data/trevee.json`), imported by the UI.
- `requirements.txt` – Python dependencies (`web3`).
- `.env.example` – template for the required secrets.

## Configuration

Non-secret parameters are hardcoded near the top of `snapshot_lenders.py` in the `CATEGORIES`
dict. Each **category** is a self-contained snapshot rendered under its own path in the UI
(e.g. `/lenders-snapshot/trevee`) and written to its own `data/<slug>.json` file. Categories
are intentionally hardcoded: adding one is a rare, deliberate edit.

Each category maps to a list of chain `targets`:

- `chain`, `chain_id`, `subgraph_url`
- `silos[]` entries with:
  - `address`
  - `block`
  - optional `type` (`"silo"` default, or `"silo_vault"`)
  - optional `withdrawals_to_block`:
    - integer block number, or
    - `"latest"` (resolved right before the withdraw scan starts for that silo)
  - optional `withdrawals_block_chunk` (number of blocks per `eth_getLogs` call for this silo)

A category may also set an explicit `output` filename (defaults to `<slug>.json`).

`MULTICALL3` address / `MULTICALL_BATCH` and the per-category output directory (`data/`) are
also defined near the top of the script.

The `trevee` category currently holds the Sonic silos/blocks. Its `ethereum` target is present
as a placeholder with `silos: []` until Ethereum silo addresses and snapshot blocks are supplied.

Secrets are read **only** from the environment (or a local, gitignored `.env`):

- `SONIC_RPC_URL` – archive RPC endpoint for Sonic (must support `eth_call` at the historical block).
- `ETHEREUM_RPC_URL` – future archive RPC endpoint for Ethereum once Ethereum silos are configured.
- `RPC_URL` – optional fallback used if a chain-specific URL is not set.
- `THE_GRAPH_API_KEY` – The Graph gateway Bearer token.
- `WITHDRAWALS_TO_BLOCK` – optional global override for scan end block (`latest` or integer).
- `WITHDRAWALS_BLOCK_CHUNK` – optional global override for `eth_getLogs` chunk size.

```bash
cp scripts/lender-snapshot/.env.example scripts/lender-snapshot/.env
# edit .env and fill SONIC_RPC_URL and THE_GRAPH_API_KEY
```

The script auto-loads `scripts/lender-snapshot/.env` if present; you can also export the variables in your shell.

## Usage

```bash
python3 -m pip install -r scripts/lender-snapshot/requirements.txt

# Produce / refresh snapshots for ALL categories (writes data/<slug>.json each):
python3 scripts/lender-snapshot/snapshot_lenders.py

# Produce / refresh a single category only:
python3 scripts/lender-snapshot/snapshot_lenders.py trevee

# Validate the JSON invariants for all data/*.json (zero tolerance, exact wei equality):
python3 scripts/lender-snapshot/qa_check.py

# Validate a specific file:
python3 scripts/lender-snapshot/qa_check.py --json scripts/lender-snapshot/data/trevee.json

# Optionally re-confirm stored total supplies against the chain:
python3 scripts/lender-snapshot/qa_check.py --verify-onchain
```

Re-running for the same Silo **merges (unions)** its flow events into the existing entry rather than overwriting: recorded `withdrawals[]` / `deposits[]` / `transfers[]` are combined and de-duplicated (by `tx_hash`+`log_index`[+`direction`]) and the derived totals are recomputed. This is deliberate — the RPC endpoint is load-balanced and `eth_getLogs` can silently return an **incomplete** set of logs for a range (identical queries hit different backends and return different counts), so a plain overwrite could let an unlucky run replace a more complete result with a smaller one. Because writes are append-only per event, repeating the run can only ever grow the recorded set; other Silos and chains are preserved. **To start clean, delete the category's `data/<slug>.json`.**

## Performance

All historical reads are batched through Multicall3 (`aggregate3` with `allowFailure=true`) via `eth_call` pinned at `BLOCK`. `eth_getCode` (used for contract detection) cannot go through Multicall3 and is issued in JSON-RPC batches instead.

## Output shape

```jsonc
{
  "<chain>": {
    "chain_id": 146,
    "silos": {
      "<silo_address>": {
        "snapshot_block": 54144258,
        "silo_id": "12",
        "input_token": { "address": "0x..", "decimals": 6, "symbol": "USDC" },
        "total_assets": "…",              // raw integer string from silo.totalAssets()
        "collateral_total_supply": "…",   // raw integer string
        "withdrawals_scanned_to_block": 55000000,
        "direct_lenders": {
          "<addr>": {
            "address_type": "eoa|silo_vault|gnosis_safe|erc4626_unresolved|contract_other",
            "collateral_shares": "…",
            "assets_collateral": "…",
            "total_assets": "…",
            // present for non-vault direct lenders:
            "total_withdrawals": "…",
            "pending_assets": "…",
            "withdrawals": [ { "...": "..." } ]
          }
        },
        "vaults": {
          "<vault_addr>": {
            "name": "…",
            "indexed_in_subgraph": true,
            "in_withdraw_queue": true,
            "status": "ok|vault_not_indexed|not_in_withdraw_queue",
            "vault_silo_assets": "…",
            "vault_total_supply": "…",
            "depositors": {
              "<addr>": {
                "address_type": "…",
                "vault_shares": "…",
                "fraction": "0.1234",
                "attributed_silo_assets": "…",
                "total_withdrawals": "…",
                "pending_assets": "…",
                "withdrawals": [
                  {
                    "block_number": 54150000,
                    "tx_hash": "0x…",
                    "log_index": 7,
                    "assets": "…",         // snapshot-rate, attributed to this silo (reduces pending)
                    "shares": "…",         // vault shares burned
                    "vault_assets": "…"    // raw vault underlying from the on-chain Withdraw event
                  }
                ]
              }
            }
          }
        }
      }
    }
  }
}
```

All share/supply amounts are raw integers (as strings, to preserve precision), expressed in the same units as the corresponding `totalSupply`, so that sums match exactly.

## QA invariants

`qa_check.py` enforces, with **zero tolerance** (exact equality to 1 wei):

- `sum(direct_lenders[].collateral_shares) == collateral_total_supply`
- for each indexed vault with `in_withdraw_queue == true`: `sum(depositors[].vault_shares) == vault_total_supply`
- for each lender/depositor (exact, signed, NOT clamped to zero): `pending_assets == base_assets + total_deposits + total_transfers_in - total_withdrawals - total_transfers_out`
- for each lender/depositor: `sum(withdrawals[].assets) == total_withdrawals`, `sum(deposits[].assets) == total_deposits`, `sum(transfers[in].assets) == total_transfers_in`, `sum(transfers[out].assets) == total_transfers_out`

Vaults with `status == vault_not_indexed` or `in_withdraw_queue == false` are reported as warnings (their depositors are intentionally not enumerated), not errors.

## Known limitations & disclaimers

- **RPC log completeness.** The Sonic RPC is load-balanced and `eth_getLogs` can silently return a *partial* log set for a block range (identical queries hit different backends — some pruned to ~block 63.2M — and return different counts, with no JSON-RPC error). Mitigations: (a) flows are unioned across runs (see [Usage](#usage)), so repeated runs can only grow the recorded set; and (b) `qa_check.py` reconciles each account in shares and hard-fails on a negative residual (more shares left than the account ever held ⇒ a missed inflow). **Caveat:** a dropped inflow whose residual stays ≥ 0 is *not* detected by QA. A `balanceOf`-based reconciliation (walking each lender's on-chain balance and bisecting against the recorded events) can locate such gaps deterministically if stronger guarantees are needed.
- **SiloVault contract rows are not distribution recipients.** A direct-lender with `address_type == silo_vault` is never credited directly; its holders are attributed via that vault's `depositors`. Silo-level `Deposit`/`Withdraw`/`Transfer` events performed by vault addresses are treated as vault rebalances and skipped.
- **Mint/burn transfers are excluded** from the peer-`Transfer` scan (mint `from==0x0`, burn `to==0x0`): they accompany `Deposit`/`Withdraw` and counting them would double-count.
- **Accepted unreconciled residuals.** A few contract accounts have share residuals that don't reconcile under the ERC4626 model even with complete data (their `Deposit`/`Withdraw`-event shares differ from the actual mint/burn amounts, or fee shares are minted with no paired `Deposit`). These are net-zero / economically immaterial contract positions, pinned exactly in `KNOWN_FEE_MINT_RESIDUALS` (exact identity **and** residual) and surfaced as warnings; any change to the identity or amount re-triggers a hard error.
