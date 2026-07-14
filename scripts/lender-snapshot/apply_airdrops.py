#!/usr/bin/env python3
"""Apply off-chain distribution airdrops to snapshot pending balances.

The operation is deterministic and idempotent: configured airdrop rows are
removed first, pending balances are recomputed from the remaining flows, and
the CSV allocations are then applied again.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import tempfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

AIRDROPS: dict[str, list[dict[str, Any]]] = {
    "trevee": [
        {
            "id": "eth-snapshot",
            "csv": "airdrops/eth-snapshot-airdrops.csv",
            "decimals": 18,
            "silos": ["0x219656f33c58488d09d518badf50aa8cdcaca2aa"],  # WETH, silo_id=26
        },
        {
            "id": "usdc-snapshot",
            "csv": "airdrops/usdc-snapshot-airdrops.csv",
            "decimals": 6,
            "silos": [
                "0x5954ce6671d97d24b782920ddcdbb4b1e63ab2de",  # USDC, silo_id=23
                "0x4935fadb17df859667cc4f7bfe6a8cb24f86f8d0",  # USDC, silo_id=55
            ],
        },
    ],
}


@dataclass(frozen=True)
class Position:
    silo_address: str
    location: str
    entry: dict[str, Any]
    snapshot_block: int
    snapshot_block_timestamp: int


def _to_int(value: Any) -> int:
    if value in (None, ""):
        return 0
    return int(value)


def _base_assets(entry: dict[str, Any]) -> int:
    if "assets_collateral" in entry:
        return _to_int(entry.get("assets_collateral"))
    return _to_int(entry.get("attributed_silo_assets"))


def _sum_assets(entry: dict[str, Any], key: str) -> int:
    rows = entry.get(key)
    if not isinstance(rows, list):
        return 0
    return sum(_to_int(row.get("assets")) for row in rows if isinstance(row, dict))


def _recompute_entry(entry: dict[str, Any]) -> None:
    total_withdrawals = _sum_assets(entry, "withdrawals")
    total_deposits = _sum_assets(entry, "deposits")
    transfers = entry.get("transfers")
    total_transfers_in = 0
    total_transfers_out = 0
    if isinstance(transfers, list):
        for row in transfers:
            if not isinstance(row, dict):
                continue
            if row.get("direction") == "out":
                total_transfers_out += _to_int(row.get("assets"))
            else:
                total_transfers_in += _to_int(row.get("assets"))
    total_borrows = _sum_assets(entry, "borrows")
    total_repays = _sum_assets(entry, "repays")
    total_airdrops = _sum_assets(entry, "airdrops")

    entry["total_withdrawals"] = str(total_withdrawals)
    entry["total_deposits"] = str(total_deposits)
    entry["total_transfers_in"] = str(total_transfers_in)
    entry["total_transfers_out"] = str(total_transfers_out)
    if "borrows" in entry or "total_borrows" in entry:
        entry["total_borrows"] = str(total_borrows)
    if "repays" in entry or "total_repays" in entry:
        entry["total_repays"] = str(total_repays)
    if "airdrops" in entry or "total_airdrops" in entry:
        entry["total_airdrops"] = str(total_airdrops)

    entry["pending_assets"] = str(
        _base_assets(entry)
        - _to_int(entry.get("debt_at_snapshot"))
        + total_deposits
        + total_transfers_in
        + total_repays
        - total_withdrawals
        - total_transfers_out
        - total_borrows
        - total_airdrops
    )


def _iter_recipient_entries(root: dict[str, Any]):
    for chain_obj in root.values():
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos")
        if not isinstance(silos, dict):
            continue
        for silo_address, silo in silos.items():
            if not isinstance(silo, dict):
                continue
            direct_lenders = silo.get("direct_lenders")
            if isinstance(direct_lenders, dict):
                for address, entry in direct_lenders.items():
                    if isinstance(entry, dict) and entry.get("address_type") != "silo_vault":
                        yield str(silo_address).lower(), str(address).lower(), "direct", silo, entry
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
                        location = f"vault:{str(vault_address).lower()}"
                        yield str(silo_address).lower(), str(address).lower(), location, silo, entry


def _strip_configured_airdrops(root: dict[str, Any], configured_ids: set[str]) -> None:
    synthetic_hashes = {f"airdrop:{airdrop_id}" for airdrop_id in configured_ids}
    for _silo_address, _address, _location, _silo, entry in _iter_recipient_entries(root):
        rows = entry.get("airdrops")
        if isinstance(rows, list):
            entry["airdrops"] = [
                row
                for row in rows
                if not isinstance(row, dict) or str(row.get("tx_hash", "")).lower() not in synthetic_hashes
            ]
        _recompute_entry(entry)


def _read_allocations(path: Path, decimals: int) -> list[tuple[str, int]]:
    if not path.exists():
        raise FileNotFoundError(f"Airdrop CSV not found: {path}")
    allocations: list[tuple[str, int]] = []
    seen: set[str] = set()
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "address" not in reader.fieldnames or "Amount sent" not in reader.fieldnames:
            raise ValueError(f"{path}: expected 'address' and 'Amount sent' columns")
        for line_number, row in enumerate(reader, start=2):
            address = str(row.get("address", "")).strip().lower()
            if not ADDRESS_RE.fullmatch(address):
                raise ValueError(f"{path}:{line_number}: invalid address {address!r}")
            if address in seen:
                raise ValueError(f"{path}:{line_number}: duplicate address {address}")
            seen.add(address)
            try:
                scaled = Decimal(str(row.get("Amount sent", "")).strip()) * (Decimal(10) ** decimals)
            except InvalidOperation as exc:
                raise ValueError(f"{path}:{line_number}: invalid Amount sent") from exc
            if scaled != scaled.to_integral_value():
                raise ValueError(f"{path}:{line_number}: Amount sent has more than {decimals} decimal places")
            amount = int(scaled)
            if amount <= 0:
                raise ValueError(f"{path}:{line_number}: Amount sent must be positive")
            allocations.append((address, amount))
    return allocations


def _position_index(root: dict[str, Any], target_silos: set[str]) -> dict[str, list[Position]]:
    index: dict[str, list[Position]] = {}
    for silo_address, address, location, silo, entry in _iter_recipient_entries(root):
        if silo_address not in target_silos:
            continue
        index.setdefault(address, []).append(
            Position(
                silo_address=silo_address,
                location=location,
                entry=entry,
                snapshot_block=_to_int(silo.get("snapshot_block")),
                snapshot_block_timestamp=_to_int(silo.get("snapshot_block_timestamp")),
            )
        )
    return index


def _append_airdrop(position: Position, airdrop_id: str, amount: int) -> None:
    rows = position.entry.get("airdrops")
    if not isinstance(rows, list):
        rows = []
        position.entry["airdrops"] = rows
    rows.append(
        {
            "block_number": position.snapshot_block,
            "block_timestamp": position.snapshot_block_timestamp,
            "tx_hash": f"airdrop:{airdrop_id}",
            "log_index": 0,
            "assets": str(amount),
            "shares": "0",
        }
    )
    _recompute_entry(position.entry)


def _apply_allocation(positions: list[Position], airdrop_id: str, amount: int) -> dict[str, int]:
    ordered = sorted(
        positions,
        key=lambda position: (
            -_to_int(position.entry.get("pending_assets")),
            position.silo_address,
            position.location,
        ),
    )
    remaining = amount
    applied_by_silo: dict[str, int] = {}
    for index, position in enumerate(ordered):
        if remaining <= 0:
            break
        is_last = index == len(ordered) - 1
        allocation = remaining if is_last else min(remaining, max(_to_int(position.entry.get("pending_assets")), 0))
        if allocation <= 0:
            continue
        _append_airdrop(position, airdrop_id, allocation)
        applied_by_silo[position.silo_address] = applied_by_silo.get(position.silo_address, 0) + allocation
        remaining -= allocation
    if remaining:
        raise RuntimeError(f"Internal error: {remaining} airdrop units were not allocated")
    return applied_by_silo


def _atomic_write_json(path: Path, root: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(root, handle, indent=2)
            handle.write("\n")
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def apply_category(slug: str, output_path: Path | None = None) -> dict[str, Any]:
    configs = AIRDROPS.get(slug)
    if not configs:
        raise ValueError(f"No airdrops configured for category {slug!r}")
    path = output_path or DATA_DIR / f"{slug}.json"
    if not path.exists():
        raise FileNotFoundError(f"Snapshot JSON not found: {path}")
    root = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(root, dict):
        raise ValueError(f"{path}: snapshot root must be an object")

    _strip_configured_airdrops(root, {str(config["id"]).lower() for config in configs})
    report: dict[str, Any] = {"category": slug, "airdrops": []}
    for config in configs:
        airdrop_id = str(config["id"]).lower()
        csv_path = SCRIPT_DIR / str(config["csv"])
        allocations = _read_allocations(csv_path, int(config["decimals"]))
        index = _position_index(root, {str(address).lower() for address in config["silos"]})
        unmatched: list[str] = []
        applied_by_silo: dict[str, int] = {}
        matched = 0
        for address, amount in allocations:
            positions = index.get(address)
            if not positions:
                unmatched.append(address)
                continue
            matched += 1
            for silo_address, applied in _apply_allocation(positions, airdrop_id, amount).items():
                applied_by_silo[silo_address] = applied_by_silo.get(silo_address, 0) + applied
        item = {
            "id": airdrop_id,
            "rows": len(allocations),
            "matched": matched,
            "unmatched": unmatched,
            "applied_by_silo": applied_by_silo,
        }
        report["airdrops"].append(item)

    _atomic_write_json(path, root)
    for item in report["airdrops"]:
        print(
            f"[airdrop] {item['id']}: matched={item['matched']}/{item['rows']} "
            f"unmatched={len(item['unmatched'])}"
        )
        for silo_address, amount in sorted(item["applied_by_silo"].items()):
            print(f"[airdrop]   silo={silo_address} applied_raw={amount}")
        for address in item["unmatched"]:
            print(f"[airdrop]   unmatched={address}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply configured airdrops to a snapshot category.")
    parser.add_argument("category", choices=sorted(AIRDROPS))
    args = parser.parse_args()
    apply_category(args.category)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
