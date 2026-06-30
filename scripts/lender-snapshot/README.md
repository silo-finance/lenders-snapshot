# Lender snapshot (Trevee)

Builds block-pinned snapshots of all lenders for configured Silos, splitting them into:

- **direct lenders** – every account holding collateral shares of the Silo, and
- **SiloVault depositors** – holders of any SiloVault that itself lends into the Silo, attributed by their share of the vault.

Redeemable `assets` per address are computed purely via on-chain `previewRedeem` at the snapshot block. The subgraph is only used to enumerate addresses (lenders of the Silo and depositors of each vault).

After the snapshot is assembled, the script also scans post-snapshot events (`snapshot_block + 1` to latest) on:

- the Silo contract (for direct lenders), and
- each indexed vault contract (for vault depositors).

It records `Withdraw(...)`, `Deposit(...)`, and peer-to-peer share `Transfer(...)` events to reconcile post-snapshot position changes. These flows are merged into the same `distribution_snapshot.json` consumed by the UI (`total_withdrawals`, `total_deposits`, `total_transfers_in`, `total_transfers_out`, `pending_assets`, and the per-event `withdrawals[]` / `deposits[]` / `transfers[]` breakdowns).

Withdrawal attribution differs by lender type:

- **direct lenders:** the raw on-chain `Withdraw` event `assets` (a silo-level withdrawal in the silo asset) is subtracted directly from `assets_collateral`.
- **vault depositors:** a SiloVault can lend into several silos, and one vault `Withdraw` burns vault shares for the vault's *total* underlying across all of them. Subtracting the raw event assets from every silo entry would both double-count across silos and credit withdrawals to silos where the vault held nothing at the snapshot block. Instead, the burned vault shares are valued at the snapshot per-share rate and translated into the assets attributable to **this** silo: `assets = vault_silo_assets * shares_burned / vault_total_supply`. This scales each silo by its own position (no cross-silo double counting) and yields `0` for silos where the vault held nothing/dust at the snapshot block, so a depositor can never show withdrawals exceeding a zero snapshot position.

For vault depositors, each `withdrawals[]` entry also keeps the raw on-chain amount for reference (`vault_assets`); only `assets` reduces `pending_assets`.

## Layout

- `snapshot_lenders.py` – main script that produces `distribution_snapshot.json`.
- `qa_check.py` – pure-JSON validator (no RPC/graph) that asserts share-sum invariants against the stored total supplies.
- `requirements.txt` – Python dependencies (`web3`).
- `.env.example` – template for the required secrets.

## Configuration

Non-secret parameters are hardcoded near the top of `snapshot_lenders.py` in `TARGETS`:

- `chain`, `chain_id`, `subgraph_url`
- `silos[]` entries with:
  - `address`
  - `block`
  - optional `withdrawals_to_block`:
    - integer block number, or
    - `"latest"` (resolved right before the withdraw scan starts for that silo)
  - optional `withdrawals_block_chunk` (number of blocks per `eth_getLogs` call for this silo)
- `OUTPUT_JSON`
- `MULTICALL3` address and `MULTICALL_BATCH`

Sonic is configured with the current silo/block. Ethereum is present as a placeholder with
`silos: []` until silo addresses and snapshot blocks are supplied.

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

# Produce / refresh snapshots for all configured chain/silo targets:
python3 scripts/lender-snapshot/snapshot_lenders.py

# Validate the JSON invariants (zero tolerance, exact wei equality):
python3 scripts/lender-snapshot/qa_check.py

# Optionally re-confirm stored total supplies against the chain:
python3 scripts/lender-snapshot/qa_check.py --verify-onchain
```

Re-running for the same Silo **overwrites** that Silo's entry under its chain key; other Silos and other chains are preserved.

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
