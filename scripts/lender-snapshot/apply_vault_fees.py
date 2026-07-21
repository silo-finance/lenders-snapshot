#!/usr/bin/env python3
"""Tag vault fee mints / fee-forwarding transfers and recompute pending.

Two passes (no nested accounting while tagging):

  1. From scanner ``fee_mints[]``, emit received_fee rows and mark peer transfer-ins
     that consume those fee shares as fee_in (FIFO by shares). Nested fee_in → later
     transfer-out is reported as a non-fatal ERROR.
  2. Recompute totals and pending from tags; apply fee_compensation =
     min(max(pending_before, 0), total fee credits) so this subtraction alone cannot
     create a negative balance.

Idempotent: previous fee annotations are cleared before pass 1.
Run after ``apply_airdrops.py`` when both are used.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"


def _to_int(value: Any) -> int:
    if value in (None, ""):
        return 0
    return int(value)


def _base_assets(entry: dict[str, Any]) -> int:
    if "assets_collateral" in entry:
        return _to_int(entry.get("assets_collateral"))
    return _to_int(entry.get("attributed_silo_assets"))


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _iter_vault_depositors(root: dict[str, Any]):
    """Yield (chain, silo_addr, vault_addr, address, entry)."""
    for chain, chain_obj in root.items():
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos")
        if not isinstance(silos, dict):
            continue
        for silo_address, silo in silos.items():
            if not isinstance(silo, dict):
                continue
            vaults = silo.get("vaults")
            if not isinstance(vaults, dict):
                continue
            for vault_address, vault in vaults.items():
                if not isinstance(vault, dict):
                    continue
                depositors = vault.get("depositors")
                if not isinstance(depositors, dict):
                    continue
                for address, entry in depositors.items():
                    if isinstance(entry, dict):
                        yield (
                            str(chain),
                            str(silo_address).lower(),
                            str(vault_address).lower(),
                            str(address).lower(),
                            entry,
                        )


def _reset_fee_annotations(entry: dict[str, Any]) -> None:
    """Restore transfer-ins that were carved into fee_in; drop fees[] / fee totals."""
    fees = entry.get("fees")
    transfers = entry.get("transfers")
    if not isinstance(transfers, list):
        transfers = []
        entry["transfers"] = transfers

    if isinstance(fees, list):
        for row in fees:
            if not isinstance(row, dict) or row.get("kind") != "fee_in":
                continue
            tx = str(row.get("tx_hash", "")).lower()
            log_index = row.get("log_index")
            assets = _to_int(row.get("assets"))
            shares = _to_int(row.get("shares"))
            matched = None
            for tr in transfers:
                if not isinstance(tr, dict):
                    continue
                if (
                    str(tr.get("tx_hash", "")).lower() == tx
                    and tr.get("log_index") == log_index
                    and tr.get("direction") == "in"
                ):
                    matched = tr
                    break
            if matched is None:
                transfers.append(
                    {
                        "block_number": row.get("block_number"),
                        "tx_hash": tx,
                        "log_index": log_index,
                        "assets": str(assets),
                        "shares": str(shares),
                        "direction": "in",
                        "counterparty": row.get("counterparty", ""),
                        **(
                            {"block_timestamp": row["block_timestamp"]}
                            if "block_timestamp" in row
                            else {}
                        ),
                    }
                )
            else:
                matched["assets"] = str(_to_int(matched.get("assets")) + assets)
                matched["shares"] = str(_to_int(matched.get("shares")) + shares)

    entry.pop("fees", None)
    entry.pop("fee_compensation", None)
    entry.pop("total_received_fees", None)
    entry.pop("total_fee_in", None)
    entry.pop("total_fee_credits", None)


def _find_transfer_in(
    entry: dict[str, Any], tx_hash: str, log_index: Any
) -> dict[str, Any] | None:
    for tr in entry.get("transfers") or []:
        if not isinstance(tr, dict):
            continue
        if (
            str(tr.get("tx_hash", "")).lower() == tx_hash
            and tr.get("log_index") == log_index
            and tr.get("direction") == "in"
        ):
            return tr
    return None


def _event_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        _to_int(row.get("block_number")),
        _to_int(row.get("log_index")),
        str(row.get("tx_hash", "")),
    )


def pass1_tag_fees(root: dict[str, Any]) -> int:
    """Tag received_fee / fee_in. Returns nested-forwarding error count."""
    nested_errors = 0

    # Group depositors by vault for FIFO walks that cross counterparties.
    by_vault: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = {}
    for chain, silo_addr, vault_addr, address, entry in _iter_vault_depositors(root):
        _reset_fee_annotations(entry)
        by_vault.setdefault((chain, silo_addr, vault_addr), {})[address] = entry

    for (chain, silo_addr, vault_addr), depositors in by_vault.items():
        # remaining fee shares from received_fee only (not from fee_in).
        remaining_fee_shares: dict[str, int] = {addr: 0 for addr in depositors}
        has_fee_in: set[str] = set()
        fees_by_addr: dict[str, list[dict[str, Any]]] = {addr: [] for addr in depositors}

        # Seed received_fee from fee_mints.
        mint_rows: list[tuple[str, dict[str, Any]]] = []
        for addr, entry in depositors.items():
            for mint in entry.get("fee_mints") or []:
                if isinstance(mint, dict):
                    mint_rows.append((addr, mint))
        mint_rows.sort(key=lambda item: _event_sort_key(item[1]))

        for addr, mint in mint_rows:
            shares = _to_int(mint.get("shares"))
            assets = _to_int(mint.get("assets"))
            remaining_fee_shares[addr] = remaining_fee_shares.get(addr, 0) + shares
            row = {
                "kind": "received_fee",
                "block_number": mint.get("block_number"),
                "tx_hash": mint.get("tx_hash"),
                "log_index": mint.get("log_index"),
                "assets": str(assets),
                "shares": str(shares),
            }
            if "block_timestamp" in mint:
                row["block_timestamp"] = mint["block_timestamp"]
            fees_by_addr[addr].append(row)

        # Collect unique peer outs (one log → sender out).
        outs: list[tuple[str, dict[str, Any]]] = []
        for addr, entry in depositors.items():
            for tr in entry.get("transfers") or []:
                if isinstance(tr, dict) and tr.get("direction") == "out":
                    outs.append((addr, tr))
        outs.sort(key=lambda item: _event_sort_key(item[1]))

        for sender, out_row in outs:
            if sender in has_fee_in:
                nested_errors += 1
                print(
                    f"[ERROR] nested fee forward: {chain} silo={silo_addr} vault={vault_addr} "
                    f"addr={sender} still has fee_in and later transfer-out "
                    f"tx={out_row.get('tx_hash')} log_index={out_row.get('log_index')} "
                    f"shares={out_row.get('shares')} assets={out_row.get('assets')}"
                )
                # Do not recurse / reclassify further from fee_in lots.
                continue

            fee_left = remaining_fee_shares.get(sender, 0)
            if fee_left <= 0:
                continue

            out_shares = _to_int(out_row.get("shares"))
            out_assets = _to_int(out_row.get("assets"))
            if out_shares <= 0:
                continue

            fee_shares = min(fee_left, out_shares)
            fee_assets = (out_assets * fee_shares) // out_shares if out_shares else 0
            remaining_fee_shares[sender] = fee_left - fee_shares

            receiver = str(out_row.get("counterparty", "")).lower()
            if not receiver or receiver not in depositors:
                # Counterparty outside this vault's depositor map: still consume sender lots
                # so we do not double-apply on a later out, but cannot tag fee_in.
                print(
                    f"[warn] fee out to unknown depositor: {chain} vault={vault_addr} "
                    f"from={sender} to={receiver} tx={out_row.get('tx_hash')} "
                    f"fee_shares={fee_shares}"
                )
                continue

            recv_entry = depositors[receiver]
            tx = str(out_row.get("tx_hash", "")).lower()
            log_index = out_row.get("log_index")
            in_row = _find_transfer_in(recv_entry, tx, log_index)
            if in_row is None:
                print(
                    f"[warn] missing transfer-in mirror for fee out: {chain} vault={vault_addr} "
                    f"from={sender} to={receiver} tx={tx} log_index={log_index}"
                )
                continue

            in_shares = _to_int(in_row.get("shares"))
            in_assets = _to_int(in_row.get("assets"))
            # Carve fee portion out of the transfer-in.
            new_shares = in_shares - fee_shares
            new_assets = in_assets - fee_assets
            if new_shares <= 0:
                recv_entry["transfers"] = [
                    tr
                    for tr in (recv_entry.get("transfers") or [])
                    if tr is not in_row
                ]
            else:
                in_row["shares"] = str(new_shares)
                in_row["assets"] = str(new_assets)

            fee_in_row: dict[str, Any] = {
                "kind": "fee_in",
                "block_number": out_row.get("block_number"),
                "tx_hash": tx,
                "log_index": log_index,
                "assets": str(fee_assets),
                "shares": str(fee_shares),
                "counterparty": sender,
            }
            if "block_timestamp" in out_row:
                fee_in_row["block_timestamp"] = out_row["block_timestamp"]
            fees_by_addr[receiver].append(fee_in_row)
            has_fee_in.add(receiver)

        for addr, entry in depositors.items():
            fee_rows = fees_by_addr.get(addr) or []
            if fee_rows:
                fee_rows.sort(key=_event_sort_key)
                entry["fees"] = fee_rows

    return nested_errors


def pass2_recompute(root: dict[str, Any]) -> None:
    """Flat totals + pending + fee_compensation from already-tagged rows."""
    for _chain, _silo, _vault, _addr, entry in _iter_vault_depositors(root):
        withdrawals = entry.get("withdrawals") or []
        deposits = entry.get("deposits") or []
        transfers = entry.get("transfers") or []
        airdrops = entry.get("airdrops") or []
        borrows = entry.get("borrows") or []
        repays = entry.get("repays") or []
        fees = entry.get("fees") or []

        total_w = sum(_to_int(r.get("assets")) for r in withdrawals if isinstance(r, dict))
        total_d = sum(_to_int(r.get("assets")) for r in deposits if isinstance(r, dict))
        total_in = sum(
            _to_int(r.get("assets"))
            for r in transfers
            if isinstance(r, dict) and r.get("direction") == "in"
        )
        total_out = sum(
            _to_int(r.get("assets"))
            for r in transfers
            if isinstance(r, dict) and r.get("direction") == "out"
        )
        total_b = sum(_to_int(r.get("assets")) for r in borrows if isinstance(r, dict))
        total_r = sum(_to_int(r.get("assets")) for r in repays if isinstance(r, dict))
        total_a = sum(_to_int(r.get("assets")) for r in airdrops if isinstance(r, dict))

        total_received = 0
        total_fee_in = 0
        # Drop prior compensation rows before recomputing.
        fees = [r for r in fees if isinstance(r, dict) and r.get("kind") != "fee_compensation"]
        for r in fees:
            kind = r.get("kind")
            if kind == "received_fee":
                total_received += _to_int(r.get("assets"))
            elif kind == "fee_in":
                total_fee_in += _to_int(r.get("assets"))

        entry["total_withdrawals"] = str(total_w)
        entry["total_deposits"] = str(total_d)
        entry["total_transfers_in"] = str(total_in)
        entry["total_transfers_out"] = str(total_out)
        if borrows or "total_borrows" in entry:
            entry["total_borrows"] = str(total_b)
        if repays or "total_repays" in entry:
            entry["total_repays"] = str(total_r)
        if airdrops or "total_airdrops" in entry:
            entry["total_airdrops"] = str(total_a)

        total_fee_credits = total_received + total_fee_in
        entry["total_received_fees"] = str(total_received)
        entry["total_fee_in"] = str(total_fee_in)
        entry["total_fee_credits"] = str(total_fee_credits)

        pending_before = (
            _base_assets(entry)
            - _to_int(entry.get("debt_at_snapshot"))
            + total_d
            + total_in
            + total_fee_credits
            + total_r
            - total_w
            - total_out
            - total_b
            - total_a
        )
        fee_compensation = min(max(pending_before, 0), total_fee_credits)
        entry["fee_compensation"] = str(fee_compensation)
        entry["pending_assets"] = str(pending_before - fee_compensation)

        if fee_compensation > 0:
            # Synthetic trailing row for the UI breakdown (no on-chain tx).
            # Use JS Number.MAX_SAFE_INTEGER so block_number survives JSON→JS intact
            # and still sorts after every real chain block.
            fees.append(
                {
                    "kind": "fee_compensation",
                    "block_number": 9_007_199_254_740_991,
                    "tx_hash": "fee_compensation",
                    "log_index": 0,
                    "assets": str(fee_compensation),
                    "shares": "0",
                }
            )
        if fees:
            entry["fees"] = fees
        else:
            entry.pop("fees", None)


def apply_vault_fees_to_file(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        root = json.load(handle)
    if not isinstance(root, dict):
        raise SystemExit(f"{path}: root JSON must be an object")

    nested_errors = pass1_tag_fees(root)
    pass2_recompute(root)
    _atomic_write_json(path, root)
    print(f"[info] wrote {path} (nested fee-forward errors: {nested_errors})")
    return nested_errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "categories",
        nargs="*",
        help="Category slugs (default: all data/<slug>.json except *.bak)",
    )
    args = parser.parse_args(argv)

    if args.categories:
        paths = [DATA_DIR / f"{slug}.json" for slug in args.categories]
    else:
        paths = sorted(p for p in DATA_DIR.glob("*.json") if not p.name.endswith(".bak.json"))

    total_errors = 0
    for path in paths:
        if not path.is_file():
            raise SystemExit(f"missing snapshot file: {path}")
        print(f"[info] apply_vault_fees: {path.name}")
        total_errors += apply_vault_fees_to_file(path)

    if total_errors:
        print(f"[warn] finished with {total_errors} nested fee-forward error(s) (non-fatal)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
