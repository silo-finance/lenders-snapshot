#!/usr/bin/env python3
"""Price xUSD debt (Initial Debt / Borrow / Repay) via Silo oracles.

Collateral (USDC / scUSD) stays 1:1. Oracle quote returns Silo Virtual Asset,
treated as a USDC substitute; only decimal scale is aligned to the silo ledger.

Automatic flow (durable quotes file is independent of stream.json):
  1. Collect unique debt blocks from stream.json.
  2. For each required quote missing from data/debt_oracle_quotes.json,
     fetch quote(10**decimals, xUSD) and persist immediately (resume-safe).
     Already-present quotes are never re-fetched.
  3. Once every required quote is present, rewrite priced amounts into
     data/stream.json. Re-running snapshot_lenders.py can wipe prices from
     stream.json; re-run this script to re-apply from the quotes file
     without RPC (unless new blocks appeared).

usage:
    python3 scripts/lender-snapshot/apply_debt_prices.py
    ./scripts/lender-snapshot/run.sh apply_debt_prices.py
    # tylko uzupełnij plik z cenami

./scripts/lender-snapshot/run.sh apply_debt_prices.py
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_utils import function_signature_to_4byte_selector, to_checksum_address

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
STREAM_PATH = DATA_DIR / "stream.json"
# Durable store of per-block unit quotes. Survives snapshot re-runs.
QUOTES_PATH = DATA_DIR / "debt_oracle_quotes.json"
# Legacy name from the first implementation; migrated on load if present.
_LEGACY_QUOTES_PATH = DATA_DIR / "oracle_quotes_cache.json"

# quote() returns SVA with 18-decimal scale.
QUOTE_DECIMALS = 18

# Hardcoded debt-silo → oracle + xUSD underlying. Missing entry for a needed
# borrow_repay_silo is a hard error (full config required before pricing).
ORACLE_BY_DEBT_SILO: dict[str, dict[str, Any]] = {
    # Sonic silo 112 – xUSD paired with USDC
    "0x172a687c397e315dbe56ed78ab347d7743d0d4fa": {
        "chain": "sonic",
        "oracle": "0x7A9Efa7CfE9a51922005056DC33Ac1a13a16953C",
        "debt_token": "0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926",
        "debt_decimals": 6,
    },
    # Sonic silo 118 – xUSD paired with scUSD (same xUSD oracle/token)
    "0x596aef68a03a0e35c4d8e624fbbdb0df0862f172": {
        "chain": "sonic",
        "oracle": "0x7A9Efa7CfE9a51922005056DC33Ac1a13a16953C",
        "debt_token": "0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926",
        "debt_decimals": 6,
    },
    # Arbitrum silo 146 – xUSD paired with USDC
    "0xf0543d476e7906374863091034fe679a7be8ee20": {
        "chain": "arbitrum",
        "oracle": "0x90C25a2A0C587E943Ad758E59bA1a9B1F9C2077e",
        "debt_token": "0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C",
        "debt_decimals": 6,
    },
}


def _sel(signature: str) -> bytes:
    return function_signature_to_4byte_selector(signature)


SEL_QUOTE = _sel("quote(uint256,address)")


def _norm(addr: str) -> str:
    return addr.strip().lower()


def _cs(addr: str) -> str:
    return to_checksum_address(addr)


def _to_int(value: Any) -> int:
    if value in (None, ""):
        return 0
    return int(value)


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_rpc_url(chain: str) -> str:
    chain_key = f"{chain.upper()}_RPC_URL"
    rpc_url = os.environ.get(chain_key, "").strip() or os.environ.get("RPC_URL", "").strip()
    if not rpc_url:
        raise SystemExit(
            f"Missing required env var for {chain}: set {chain_key} or RPC_URL "
            f"in the environment or in {SCRIPT_DIR / '.env'} (see .env.example)."
        )
    return rpc_url


_HTTP_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})
_HTTP_TRANSIENT_ERRORS = (
    urllib.error.URLError,
    TimeoutError,
    json.JSONDecodeError,
    http.client.RemoteDisconnected,
    http.client.IncompleteRead,
    ConnectionResetError,
    BrokenPipeError,
)


def _http_post_json(url: str, payload: Any, headers: dict[str, str]) -> Any:
    data = json.dumps(payload).encode("utf-8")
    last_err: Exception | None = None
    attempts = 5
    backoff = 2.0
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # noqa: PERF203
            last_err = exc
            if exc.code not in _HTTP_RETRYABLE_STATUS:
                raise RuntimeError(f"HTTP POST to {url} failed: {last_err}") from exc
        except _HTTP_TRANSIENT_ERRORS as exc:  # noqa: PERF203
            last_err = exc
        if attempt == attempts - 1:
            break
        print(
            f"[warn] HTTP POST retry {attempt + 1}/{attempts} after {last_err!r}; "
            f"sleeping {backoff:g}s"
        )
        time.sleep(backoff)
        backoff *= 2
    raise RuntimeError(f"HTTP POST to {url} failed: {last_err}")


class RpcClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self._id = 0
        self._headers = {"Content-Type": "application/json"}

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def eth_call(self, to: str, data: bytes, block: int) -> bytes:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "eth_call",
            "params": [{"to": _cs(to), "data": "0x" + data.hex()}, hex(block)],
        }
        res = _http_post_json(self.url, payload, self._headers)
        if "error" in res and res["error"]:
            raise RuntimeError(f"eth_call error at block {block}: {res['error']}")
        return bytes.fromhex(res["result"][2:])


def _cache_key(chain: str, oracle: str, token: str, block: int) -> str:
    return f"{chain}:{_norm(oracle)}:{_norm(token)}:{block}"


def _load_quotes(path: Path) -> dict[str, str]:
    """Load durable quotes file; migrate legacy cache path if needed."""
    load_path = path
    if not load_path.exists() and _LEGACY_QUOTES_PATH.exists():
        print(f"[debt-price] migrating {_LEGACY_QUOTES_PATH.name} → {path.name}")
        load_path = _LEGACY_QUOTES_PATH
    if not load_path.exists():
        return {}
    raw = json.loads(load_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit(f"Invalid debt oracle quotes file (expected object): {load_path}")
    out: dict[str, str] = {}
    for key, value in raw.items():
        out[str(key)] = str(value)
    if load_path != path:
        _atomic_write_json(path, dict(sorted(out.items())))
        print(f"[debt-price] wrote migrated quotes → {path}")
    return out


def _persist_quotes(path: Path, quotes: dict[str, str]) -> None:
    _atomic_write_json(path, dict(sorted(quotes.items())))


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def _call_quote(rpc: RpcClient, oracle: str, amount: int, token: str, block: int) -> int:
    data = SEL_QUOTE + abi_encode(["uint256", "address"], [amount, _cs(token)])
    ret = rpc.eth_call(oracle, data, block)
    return int(abi_decode(["uint256"], ret)[0])


def _unit_price_ledger(unit_quote_18: int, main_decimals: int) -> int:
    """Price of 1 human debt token in main-ledger units (SVA≈USDC, scale-aligned)."""
    if main_decimals > QUOTE_DECIMALS:
        raise SystemExit(f"main_decimals {main_decimals} > quote decimals {QUOTE_DECIMALS}")
    return unit_quote_18 // (10 ** (QUOTE_DECIMALS - main_decimals))


def _value_ledger(raw: int, unit_quote_18: int, debt_decimals: int, main_decimals: int) -> int:
    """raw debt amount → ledger units via unit quote(10**debt_decimals)."""
    price = _unit_price_ledger(unit_quote_18, main_decimals)
    return raw * price // (10 ** debt_decimals)


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
    total_fee_credits = _to_int(entry.get("total_fee_credits"))
    fee_compensation = _to_int(entry.get("fee_compensation"))

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
        + total_fee_credits
        - total_withdrawals
        - total_transfers_out
        - total_borrows
        - total_airdrops
        - fee_compensation
    )


def _iter_two_sided_silos(root: dict[str, Any]):
    for chain_name, chain_obj in root.items():
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos")
        if not isinstance(silos, dict):
            continue
        for silo_address, silo in silos.items():
            if not isinstance(silo, dict):
                continue
            paired = silo.get("borrow_repay_silo")
            if not paired:
                continue
            yield str(chain_name).lower(), _norm(str(silo_address)), silo, _norm(str(paired))


def _collect_work(
    root: dict[str, Any],
) -> tuple[list[str], dict[str, set[int]], dict[str, dict[str, Any]], dict[str, Any]]:
    """Return missing debt silos, blocks-by-chain, configs in use, and scan stats."""
    missing: list[str] = []
    blocks_by_chain: dict[str, set[int]] = {}
    used_configs: dict[str, dict[str, Any]] = {}
    two_sided = 0
    debt_positions = 0
    borrow_events = 0
    repay_events = 0

    for chain_name, _silo_addr, silo, debt_silo in _iter_two_sided_silos(root):
        two_sided += 1
        cfg = ORACLE_BY_DEBT_SILO.get(debt_silo)
        if cfg is None:
            missing.append(debt_silo)
            continue
        used_configs[debt_silo] = cfg
        blocks = blocks_by_chain.setdefault(chain_name, set())
        snapshot_block = _to_int(silo.get("snapshot_block"))
        direct = silo.get("direct_lenders")
        if not isinstance(direct, dict):
            continue
        for entry in direct.values():
            if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
                continue
            if _to_int(entry.get("debt_at_snapshot_raw", entry.get("debt_at_snapshot"))) > 0:
                if snapshot_block <= 0:
                    raise SystemExit(f"Missing snapshot_block for silo with debt on {chain_name}")
                blocks.add(snapshot_block)
                debt_positions += 1
            for key in ("borrows", "repays"):
                rows = entry.get(key)
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    raw = _to_int(row.get("assets_raw", row.get("assets")))
                    if raw <= 0:
                        continue
                    block = _to_int(row.get("block_number"))
                    if block <= 0:
                        raise SystemExit(f"Missing block_number on {key} row in {chain_name}")
                    blocks.add(block)
                    if key == "borrows":
                        borrow_events += 1
                    else:
                        repay_events += 1

    # Deduplicate missing while preserving order
    seen: set[str] = set()
    missing_unique: list[str] = []
    for addr in missing:
        if addr not in seen:
            seen.add(addr)
            missing_unique.append(addr)
    stats = {
        "two_sided_silos": two_sided,
        "debt_positions": debt_positions,
        "borrow_events": borrow_events,
        "repay_events": repay_events,
        "unique_blocks": {chain: len(blocks) for chain, blocks in sorted(blocks_by_chain.items())},
    }
    return missing_unique, blocks_by_chain, used_configs, stats


def _oracle_triplets_by_chain(
    used_configs: dict[str, dict[str, Any]],
) -> dict[str, list[tuple[str, str, int]]]:
    """chain → unique (oracle, token, debt_decimals) for RPC fetches."""
    by_chain: dict[str, list[tuple[str, str, int]]] = {}
    seen: set[tuple[str, str, str]] = set()
    for cfg in used_configs.values():
        chain = str(cfg["chain"]).lower()
        oracle = _norm(str(cfg["oracle"]))
        token = _norm(str(cfg["debt_token"]))
        key = (chain, oracle, token)
        if key in seen:
            continue
        seen.add(key)
        by_chain.setdefault(chain, []).append((oracle, token, int(cfg["debt_decimals"])))
    return by_chain


def _ensure_quotes(
    quotes: dict[str, str],
    quotes_path: Path,
    blocks_by_chain: dict[str, set[int]],
    used_configs: dict[str, dict[str, Any]],
    required_keys: list[str],
) -> int:
    """Fetch missing unit quotes into `quotes`, persisting after each RPC hit.

    Returns number of new RPC fetches. Does not touch stream.json.
    """
    by_chain = _oracle_triplets_by_chain(used_configs)
    to_fetch = [key for key in required_keys if key not in quotes]
    if not to_fetch:
        return 0

    print(f"[debt-price] fetching {len(to_fetch)} missing quote(s) via RPC …")
    fetched = 0
    total = len(to_fetch)
    rpcs: dict[str, RpcClient] = {}
    for chain, blocks in sorted(blocks_by_chain.items()):
        if not blocks:
            continue
        triplets = by_chain.get(chain, [])
        if not triplets:
            raise SystemExit(f"No oracle config for chain {chain} with debt pricing blocks")
        if chain not in rpcs:
            rpc_url = resolve_rpc_url(chain)
            print(f"[debt-price]   RPC {chain} ready")
            rpcs[chain] = RpcClient(rpc_url)
        rpc = rpcs[chain]
        for block in sorted(blocks):
            for oracle, token, debt_decimals in triplets:
                key = _cache_key(chain, oracle, token, block)
                if key in quotes:
                    continue
                amount = 10**debt_decimals
                fetched += 1
                print(
                    f"[debt-price]   [{fetched}/{total}] {chain} block={block} "
                    f"oracle={oracle[:10]}… token={token[:10]}…"
                )
                quote = _call_quote(rpc, oracle, amount, token, block)
                quotes[key] = str(quote)
                # Persist immediately so an interrupted run keeps progress.
                _persist_quotes(quotes_path, quotes)
    return fetched


def _required_quote_keys(
    blocks_by_chain: dict[str, set[int]],
    used_configs: dict[str, dict[str, Any]],
) -> list[str]:
    by_chain = _oracle_triplets_by_chain(used_configs)
    keys: list[str] = []
    for chain, blocks in sorted(blocks_by_chain.items()):
        for oracle, token, _dec in by_chain.get(chain, []):
            for block in sorted(blocks):
                keys.append(_cache_key(chain, oracle, token, block))
    return keys


def _price_flow_row(
    row: dict[str, Any],
    unit_quote_18: int,
    debt_decimals: int,
    main_decimals: int,
) -> None:
    raw = _to_int(row.get("assets_raw", row.get("assets")))
    row["assets_raw"] = str(raw)
    price = _unit_price_ledger(unit_quote_18, main_decimals)
    row["price"] = str(price)
    row["assets"] = str(_value_ledger(raw, unit_quote_18, debt_decimals, main_decimals))


def _apply_quotes_to_stream(
    root: dict[str, Any],
    quotes: dict[str, str],
    used_configs: dict[str, dict[str, Any]],
) -> tuple[int, int]:
    """Rewrite debt/borrow/repay amounts in-memory from the quotes file."""
    priced_lenders = 0
    priced_events = 0
    priced_debts = 0

    for chain_name, silo_addr, silo, debt_silo in _iter_two_sided_silos(root):
        cfg = used_configs[debt_silo]
        oracle = _norm(str(cfg["oracle"]))
        token = _norm(str(cfg["debt_token"]))
        debt_decimals = int(cfg["debt_decimals"])
        main_decimals = _to_int((silo.get("input_token") or {}).get("decimals"))
        if main_decimals <= 0:
            raise SystemExit(f"Missing input_token.decimals on silo {silo_addr}")
        snapshot_block = _to_int(silo.get("snapshot_block"))
        direct = silo.get("direct_lenders")
        if not isinstance(direct, dict):
            continue

        silo_lenders = 0
        silo_events = 0
        silo_debts = 0
        symbol = str((silo.get("input_token") or {}).get("symbol") or "?")

        for _addr, entry in direct.items():
            if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
                continue
            changed = False

            debt_raw = _to_int(entry.get("debt_at_snapshot_raw", entry.get("debt_at_snapshot")))
            if debt_raw > 0:
                key = _cache_key(chain_name, oracle, token, snapshot_block)
                if key not in quotes:
                    raise SystemExit(f"Missing quote in {QUOTES_PATH.name} for {key}")
                unit_quote_18 = int(quotes[key])
                entry["debt_at_snapshot_raw"] = str(debt_raw)
                price = _unit_price_ledger(unit_quote_18, main_decimals)
                entry["debt_price"] = str(price)
                entry["debt_at_snapshot"] = str(
                    _value_ledger(debt_raw, unit_quote_18, debt_decimals, main_decimals)
                )
                changed = True
                silo_debts += 1
                priced_debts += 1

            for key_name in ("borrows", "repays"):
                rows = entry.get(key_name)
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    raw = _to_int(row.get("assets_raw", row.get("assets")))
                    if raw <= 0:
                        continue
                    block = _to_int(row.get("block_number"))
                    quote_key = _cache_key(chain_name, oracle, token, block)
                    if quote_key not in quotes:
                        raise SystemExit(f"Missing quote in {QUOTES_PATH.name} for {quote_key}")
                    unit_quote_18 = int(quotes[quote_key])
                    _price_flow_row(row, unit_quote_18, debt_decimals, main_decimals)
                    priced_events += 1
                    silo_events += 1
                    changed = True

            if changed:
                _recompute_entry(entry)
                priced_lenders += 1
                silo_lenders += 1

        if silo_lenders or silo_events or silo_debts:
            print(
                f"[debt-price]   {chain_name}/{silo_addr[:10]}… ({symbol}): "
                f"lenders={silo_lenders} initial_debt={silo_debts} "
                f"borrow/repay={silo_events}"
            )

    print(
        f"[debt-price] apply totals: lenders={priced_lenders} "
        f"initial_debt={priced_debts} borrow/repay_events={priced_events}"
    )
    return priced_lenders, priced_events


def apply_debt_prices(
    stream_path: Path = STREAM_PATH,
    quotes_path: Path = QUOTES_PATH,
) -> dict[str, Any]:
    """Fill missing quotes automatically, then patch stream.json when complete."""
    _load_dotenv(SCRIPT_DIR / ".env")
    if not stream_path.exists():
        raise SystemExit(f"Snapshot not found: {stream_path}")

    print(f"[debt-price] loading {stream_path}")
    root = json.loads(stream_path.read_text(encoding="utf-8"))
    if not isinstance(root, dict):
        raise SystemExit(f"Invalid stream snapshot (expected object): {stream_path}")

    print("[debt-price] scanning two-sided markets for Initial Debt / Borrow / Repay blocks …")
    missing, blocks_by_chain, used_configs, scan_stats = _collect_work(root)
    if missing:
        raise SystemExit(
            "Missing ORACLE_BY_DEBT_SILO config for borrow_repay_silo address(es):\n  - "
            + "\n  - ".join(missing)
            + "\nAdd hardcoded silo→oracle mappings before running debt pricing."
        )

    print(
        f"[debt-price] found {scan_stats['two_sided_silos']} two-sided silo(s), "
        f"{scan_stats['debt_positions']} initial-debt position(s), "
        f"{scan_stats['borrow_events']} borrow(s), {scan_stats['repay_events']} repay(s)"
    )
    for chain, count in scan_stats["unique_blocks"].items():
        print(f"[debt-price]   {chain}: {count} unique block(s) to price")

    required = _required_quote_keys(blocks_by_chain, used_configs)
    quotes = _load_quotes(quotes_path)
    already = sum(1 for key in required if key in quotes)
    need = len(required) - already
    print(
        f"[debt-price] quotes file {quotes_path.name}: "
        f"{already}/{len(required)} present, {need} to fetch"
    )

    fetched = _ensure_quotes(quotes, quotes_path, blocks_by_chain, used_configs, required)
    if fetched:
        print(f"[debt-price] quotes file updated ({fetched} new) → {quotes_path}")
    else:
        print(f"[debt-price] quotes complete; skipping RPC")

    incomplete = [key for key in required if key not in quotes]
    if incomplete:
        raise SystemExit(
            f"Quotes file incomplete ({len(incomplete)} missing). "
            f"Refusing to modify {stream_path.name}. First missing: {incomplete[0]}"
        )

    print(f"[debt-price] applying priced debt into {stream_path.name} …")
    priced_lenders, priced_events = _apply_quotes_to_stream(root, quotes, used_configs)
    _atomic_write_json(stream_path, root)
    print(f"[debt-price] wrote {stream_path}")
    report = {
        "priced_lenders": priced_lenders,
        "priced_events": priced_events,
        "fetched_quotes": fetched,
        "quotes_entries": len(quotes),
        "stream": str(stream_path),
        "quotes": str(quotes_path),
    }
    print(
        f"[debt-price] done: fetched={fetched} priced_lenders={priced_lenders} "
        f"priced_events={priced_events} quotes_file={len(quotes)}"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch any missing xUSD oracle quotes into data/debt_oracle_quotes.json, "
            "then apply priced debt amounts into data/stream.json."
        )
    )
    parser.parse_args()
    apply_debt_prices()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
