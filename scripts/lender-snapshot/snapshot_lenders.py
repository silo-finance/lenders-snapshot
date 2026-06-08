#!/usr/bin/env python3
"""
Trevee lender snapshot.

Builds block-pinned snapshots of all lenders for configured Silos:
  - direct lenders (every account holding collateral and/or protected shares), and
  - SiloVault depositors (holders of any SiloVault that itself lends into the Silo),
    attributed by their fraction of the vault.

Redeemable `assets` per address are computed purely on-chain via `previewRedeem`
at the snapshot block. The subgraph is only used to enumerate addresses.

All historical reads are batched through Multicall3 (aggregate3, allowFailure=true)
with eth_call pinned at BLOCK. eth_getCode is issued in JSON-RPC batches.

Secrets ({CHAIN}_RPC_URL/RPC_URL, THE_GRAPH_API_KEY) are read ONLY from the environment
or a local gitignored `.env` next to this script. They must never be committed.

    python3 scripts/tasks/lender-snapshot/snapshot_lenders.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_utils import function_signature_to_4byte_selector, to_checksum_address

SCRIPT_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------------------
# HARDCODED (non-secret) configuration
# --------------------------------------------------------------------------------------
DEFAULT_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id/8wcbzcdNirQvk1ETh25wpVzb5GWs8DvugpbwrYnTCcxj"

TARGETS: list[dict[str, Any]] = [
    {
        "chain": "sonic",
        "chain_id": 146,
        "subgraph_url": DEFAULT_SUBGRAPH_URL,
        "silos": [
            {
                "address": "0x6030ad53d90ec2fb67f3805794dbb3fa5fd6eb64",
                "block": 54144258,
            }
        ],
    },
    {
        "chain": "ethereum",
        "chain_id": 1,
        "subgraph_url": DEFAULT_SUBGRAPH_URL,
        # Placeholder until Ethereum silo addresses and snapshot blocks are supplied.
        "silos": [],
    },
]

BLOCK = 0
SILO_ADDRESS = ""
CHAIN = ""
CHAIN_ID = 0
SUBGRAPH_URL = DEFAULT_SUBGRAPH_URL

OUTPUT_JSON = str(SCRIPT_DIR / "distribution_snapshot.json")

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MULTICALL_BATCH = 300

GETCODE_BATCH = 200
SUBGRAPH_PAGE = 1000

# CollateralType enum (ISilo.sol): Protected = 0, Collateral = 1
COLLATERAL_TYPE_PROTECTED = 0
COLLATERAL_TYPE_COLLATERAL = 1

# Secrets (env-only).
RPC_URL = ""
THE_GRAPH_API_KEY = ""


# --------------------------------------------------------------------------------------
# Function selectors
# --------------------------------------------------------------------------------------
def _sel(signature: str) -> bytes:
    return function_signature_to_4byte_selector(signature)


SEL_BALANCE_OF = _sel("balanceOf(address)")
SEL_TOTAL_SUPPLY = _sel("totalSupply()")
SEL_DECIMALS = _sel("decimals()")
SEL_SYMBOL = _sel("symbol()")
SEL_ASSET = _sel("asset()")
SEL_TOTAL_ASSETS = _sel("totalAssets()")
SEL_INCENTIVES_MODULE = _sel("INCENTIVES_MODULE()")
SEL_PREVIEW_REDEEM_ERC4626 = _sel("previewRedeem(uint256)")
SEL_PREVIEW_REDEEM_SILO = _sel("previewRedeem(uint256,uint8)")
SEL_CONFIG = _sel("config(address)")
SEL_SILO_CONFIG = _sel("config()")
SEL_SILO_ID = _sel("SILO_ID()")


# --------------------------------------------------------------------------------------
# Environment / secrets
# --------------------------------------------------------------------------------------
def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no external dependency). Does not overwrite existing env."""
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


def load_secrets() -> None:
    global RPC_URL, THE_GRAPH_API_KEY
    _load_dotenv(SCRIPT_DIR / ".env")
    RPC_URL = os.environ.get("RPC_URL", "").strip()
    THE_GRAPH_API_KEY = os.environ.get("THE_GRAPH_API_KEY", "").strip()
    missing = []
    if not THE_GRAPH_API_KEY:
        missing.append("THE_GRAPH_API_KEY")
    if missing:
        raise SystemExit(
            "Missing required env var(s): "
            + ", ".join(missing)
            + f". Set them in the environment or in {SCRIPT_DIR / '.env'} "
            "(see .env.example)."
        )


def resolve_rpc_url(chain: str) -> str:
    chain_key = f"{chain.upper()}_RPC_URL"
    rpc_url = os.environ.get(chain_key, "").strip() or RPC_URL
    if not rpc_url:
        raise SystemExit(
            f"Missing required env var for {chain}: set {chain_key} or RPC_URL "
            f"in the environment or in {SCRIPT_DIR / '.env'} (see .env.example)."
        )
    return rpc_url


def configure_context(target: dict[str, Any], silo: dict[str, Any]) -> None:
    global BLOCK, SILO_ADDRESS, CHAIN, CHAIN_ID, SUBGRAPH_URL
    CHAIN = str(target["chain"]).lower()
    CHAIN_ID = int(target["chain_id"])
    SUBGRAPH_URL = str(target.get("subgraph_url") or DEFAULT_SUBGRAPH_URL)
    SILO_ADDRESS = norm(str(silo["address"]))
    BLOCK = int(silo["block"])


# --------------------------------------------------------------------------------------
# Address helpers
# --------------------------------------------------------------------------------------
def is_address(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    if not value.startswith("0x") or len(value) != 42:
        return False
    try:
        int(value[2:], 16)
    except ValueError:
        return False
    return True


def norm(addr: str) -> str:
    return addr.strip().lower()


def cs(addr: str) -> str:
    return to_checksum_address(addr)


# --------------------------------------------------------------------------------------
# Raw JSON-RPC client
# --------------------------------------------------------------------------------------
def _http_post_json(url: str, payload: Any, headers: dict[str, str]) -> Any:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    last_err: Exception | None = None
    backoff = 4
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:  # noqa: PERF203
            last_err = exc
            if attempt == 4:
                break
            import time

            time.sleep(backoff)
            backoff *= 2
    raise RuntimeError(f"HTTP POST to {url} failed: {last_err}")


class RpcClient:
    def __init__(self, url: str, block: int) -> None:
        self.url = url
        self.block = block
        self.block_hex = hex(block)
        self._id = 0
        self._headers = {"Content-Type": "application/json"}

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def eth_call(self, to: str, data: bytes) -> bytes:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "eth_call",
            "params": [{"to": cs(to), "data": "0x" + data.hex()}, self.block_hex],
        }
        res = _http_post_json(self.url, payload, self._headers)
        if "error" in res and res["error"]:
            raise RuntimeError(f"eth_call error: {res['error']}")
        return bytes.fromhex(res["result"][2:])

    def get_code_batch(self, addresses: list[str]) -> dict[str, bytes]:
        """Return {address: code bytes} for a batch via JSON-RPC batch request."""
        out: dict[str, bytes] = {}
        if not addresses:
            return out
        for i in range(0, len(addresses), GETCODE_BATCH):
            chunk = addresses[i : i + GETCODE_BATCH]
            payload = []
            id_to_addr: dict[int, str] = {}
            for addr in chunk:
                rid = self._next_id()
                id_to_addr[rid] = addr
                payload.append(
                    {
                        "jsonrpc": "2.0",
                        "id": rid,
                        "method": "eth_getCode",
                        "params": [cs(addr), self.block_hex],
                    }
                )
            res = _http_post_json(self.url, payload, self._headers)
            if not isinstance(res, list):
                raise RuntimeError(f"Unexpected batch response: {res}")
            for item in res:
                addr = id_to_addr.get(item.get("id"))
                if addr is None:
                    continue
                code_hex = item.get("result", "0x")
                out[addr] = bytes.fromhex(code_hex[2:]) if isinstance(code_hex, str) else b""
        return out


# --------------------------------------------------------------------------------------
# Multicall3
# --------------------------------------------------------------------------------------
SEL_AGGREGATE3 = _sel("aggregate3((address,bool,bytes)[])")


class Multicall:
    def __init__(self, rpc: RpcClient, address: str, batch: int) -> None:
        self.rpc = rpc
        self.address = address
        self.batch = batch

    def aggregate(self, calls: list[tuple[str, bytes]]) -> list[tuple[bool, bytes]]:
        """calls: list of (target, calldata). Returns list of (success, returnData)."""
        results: list[tuple[bool, bytes]] = []
        for i in range(0, len(calls), self.batch):
            chunk = calls[i : i + self.batch]
            encoded_calls = [(cs(target), True, calldata) for target, calldata in chunk]
            data = SEL_AGGREGATE3 + abi_encode(["(address,bool,bytes)[]"], [encoded_calls])
            ret = self.rpc.eth_call(self.address, data)
            decoded = abi_decode(["(bool,bytes)[]"], ret)[0]
            for success, return_data in decoded:
                results.append((bool(success), bytes(return_data)))
        return results


# --------------------------------------------------------------------------------------
# Calldata builders / decoders
# --------------------------------------------------------------------------------------
def call_balance_of(account: str) -> bytes:
    return SEL_BALANCE_OF + abi_encode(["address"], [cs(account)])


def call_total_supply() -> bytes:
    return SEL_TOTAL_SUPPLY


def call_decimals() -> bytes:
    return SEL_DECIMALS


def call_symbol() -> bytes:
    return SEL_SYMBOL


def call_asset() -> bytes:
    return SEL_ASSET


def call_total_assets() -> bytes:
    return SEL_TOTAL_ASSETS


def call_incentives_module() -> bytes:
    return SEL_INCENTIVES_MODULE


def call_preview_redeem_erc4626(shares: int) -> bytes:
    return SEL_PREVIEW_REDEEM_ERC4626 + abi_encode(["uint256"], [shares])


def call_preview_redeem_silo(shares: int, collateral_type: int) -> bytes:
    return SEL_PREVIEW_REDEEM_SILO + abi_encode(["uint256", "uint8"], [shares, collateral_type])


def call_config(market: str) -> bytes:
    return SEL_CONFIG + abi_encode(["address"], [cs(market)])


def call_silo_config() -> bytes:
    return SEL_SILO_CONFIG


def call_silo_id() -> bytes:
    return SEL_SILO_ID


def dec_uint(data: bytes) -> int:
    return abi_decode(["uint256"], data)[0]


def dec_address(data: bytes) -> str:
    return norm(abi_decode(["address"], data)[0])


def dec_config(data: bytes) -> tuple[int, bool, int]:
    cap, enabled, removable_at = abi_decode(["uint184", "bool", "uint64"], data)
    return int(cap), bool(enabled), int(removable_at)


def dec_string(data: bytes) -> str:
    try:
        return str(abi_decode(["string"], data)[0])
    except Exception:
        raw = abi_decode(["bytes32"], data)[0]
        return bytes(raw).split(b"\x00", 1)[0].decode("utf-8", errors="replace")


# --------------------------------------------------------------------------------------
# Subgraph
# --------------------------------------------------------------------------------------
def graph_query(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {THE_GRAPH_API_KEY}",
        "User-Agent": "Mozilla/5.0",
    }
    payload = {"query": query, "variables": variables}
    res = _http_post_json(SUBGRAPH_URL, payload, headers)
    if "errors" in res and res["errors"]:
        raise RuntimeError(f"Subgraph error: {res['errors']}")
    return res.get("data", {})


Q_LENDERS_TEMPLATE = """
query Lenders($m:String!,$first:Int!,$skip:Int!){
  positions(
    block:{number:%d}
    first:$first
    skip:$skip
    where:{ or:[ {market:$m, sTokenBalance_gt:0}, {market:$m, spTokenBalance_gt:0} ] }
  ){
    account{ id }
    sToken{ id }
    spToken{ id }
    sTokenBalance
    spTokenBalance
  }
}
"""

Q_IS_VAULT_TEMPLATE = """
query IsVault($v:String!){
  vault(id:$v, block:{number:%d}){ id name }
}
"""

Q_VAULT_DEPOSITORS_TEMPLATE = """
query VaultDepositors($v:String!,$first:Int!,$skip:Int!){
  vaultPositions(
    block:{number:%d}
    first:$first
    skip:$skip
    where:{ vault:$v, shares_gt:0 }
  ){
    account{ id }
    shares
  }
}
"""


def fetch_lenders(market: str) -> tuple[list[str], str | None]:
    """Return (unique lender addresses, protected share token address or None)."""
    accounts: list[str] = []
    seen: set[str] = set()
    sp_token: str | None = None
    skip = 0
    while True:
        data = graph_query(Q_LENDERS_TEMPLATE % BLOCK, {"m": market, "first": SUBGRAPH_PAGE, "skip": skip})
        rows = data.get("positions", [])
        if not rows:
            break
        for row in rows:
            acc = norm(row["account"]["id"])
            if acc not in seen:
                seen.add(acc)
                accounts.append(acc)
            if sp_token is None and row.get("spToken") and row["spToken"].get("id"):
                sp_token = norm(row["spToken"]["id"])
        if len(rows) < SUBGRAPH_PAGE:
            break
        skip += SUBGRAPH_PAGE
    return accounts, sp_token


def fetch_vault_indexed(vault: str) -> dict[str, Any] | None:
    data = graph_query(Q_IS_VAULT_TEMPLATE % BLOCK, {"v": vault})
    return data.get("vault")


def fetch_vault_depositors(vault: str) -> list[str]:
    """Return unique depositor addresses. Share amounts come from RPC balanceOf, not the graph."""
    out: list[str] = []
    seen: set[str] = set()
    skip = 0
    while True:
        data = graph_query(Q_VAULT_DEPOSITORS_TEMPLATE % BLOCK, {"v": vault, "first": SUBGRAPH_PAGE, "skip": skip})
        rows = data.get("vaultPositions", [])
        if not rows:
            break
        for row in rows:
            acc = norm(row["account"]["id"])
            if acc not in seen:
                seen.add(acc)
                out.append(acc)
        if len(rows) < SUBGRAPH_PAGE:
            break
        skip += SUBGRAPH_PAGE
    return out


# --------------------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------------------
def classify_addresses(
    addresses: list[str], rpc: RpcClient, mc: Multicall
) -> tuple[dict[str, str], dict[str, str]]:
    """
    Classify each address at BLOCK.

    Returns (address_type, vault_incentives_module) where address_type is one of
    eoa | silo_vault | erc4626_unresolved | contract_other, and the second map holds
    the non-zero INCENTIVES_MODULE() address for silo_vault entries.
    """
    types: dict[str, str] = {}
    incentives: dict[str, str] = {}

    code = rpc.get_code_batch(addresses)

    contracts = [a for a in addresses if len(code.get(a, b"")) > 0]
    for addr in addresses:
        if len(code.get(addr, b"")) == 0:
            types[addr] = "eoa"

    if not contracts:
        return types, incentives

    # One multicall: INCENTIVES_MODULE() and previewRedeem(uint256) probe per contract.
    calls: list[tuple[str, bytes]] = []
    for addr in contracts:
        calls.append((addr, call_incentives_module()))
        calls.append((addr, call_preview_redeem_erc4626(0)))
    res = mc.aggregate(calls)

    for idx, addr in enumerate(contracts):
        inc_ok, inc_data = res[2 * idx]
        pr_ok, _pr_data = res[2 * idx + 1]
        inc_addr = ""
        if inc_ok and len(inc_data) >= 32:
            try:
                inc_addr = dec_address(inc_data)
            except Exception:
                inc_addr = ""
        if inc_addr and int(inc_addr, 16) != 0:
            types[addr] = "silo_vault"
            incentives[addr] = inc_addr
        elif pr_ok:
            types[addr] = "erc4626_unresolved"
        else:
            types[addr] = "contract_other"

    return types, incentives


# --------------------------------------------------------------------------------------
# Snapshot building
# --------------------------------------------------------------------------------------
def fetch_silo_metadata(rpc: RpcClient, mc: Multicall, protected_token: str) -> dict[str, Any]:
    res = mc.aggregate(
        [
            (SILO_ADDRESS, call_asset()),
            (SILO_ADDRESS, call_total_supply()),
            (protected_token, call_total_supply()),
            (SILO_ADDRESS, call_total_assets()),
            (SILO_ADDRESS, call_silo_config()),
        ]
    )
    asset_addr = dec_address(res[0][1]) if res[0][0] else None
    collateral_total_supply = dec_uint(res[1][1]) if res[1][0] else 0
    protected_total_supply = dec_uint(res[2][1]) if res[2][0] else 0
    total_assets = dec_uint(res[3][1]) if res[3][0] else None
    config_addr = dec_address(res[4][1]) if res[4][0] else None

    decimals = None
    symbol = None
    if asset_addr:
        d = mc.aggregate([(asset_addr, call_decimals()), (asset_addr, call_symbol())])
        if d[0][0]:
            decimals = dec_uint(d[0][1])
        if d[1][0]:
            try:
                symbol = dec_string(d[1][1])
            except Exception:
                symbol = None

    silo_id = None
    if config_addr:
        sid = mc.aggregate([(config_addr, call_silo_id())])
        if sid[0][0]:
            try:
                silo_id = str(dec_uint(sid[0][1]))
            except Exception:
                silo_id = None

    return {
        "silo_id": silo_id,
        "input_token": {"address": asset_addr, "decimals": decimals, "symbol": symbol},
        "total_assets": total_assets,
        "collateral_total_supply": collateral_total_supply,
        "protected_total_supply": protected_total_supply,
    }


def fetch_direct_lender_shares(
    addresses: list[str], mc: Multicall, protected_token: str
) -> dict[str, tuple[int, int]]:
    """Return {addr: (collateral_shares, protected_shares)} via multicall balanceOf."""
    calls: list[tuple[str, bytes]] = []
    for addr in addresses:
        calls.append((SILO_ADDRESS, call_balance_of(addr)))
        calls.append((protected_token, call_balance_of(addr)))
    res = mc.aggregate(calls)
    out: dict[str, tuple[int, int]] = {}
    for idx, addr in enumerate(addresses):
        c_ok, c_data = res[2 * idx]
        p_ok, p_data = res[2 * idx + 1]
        collateral = dec_uint(c_data) if c_ok else 0
        protected = dec_uint(p_data) if p_ok else 0
        out[addr] = (collateral, protected)
    return out


def preview_redeem_pairs(
    shares_pairs: list[tuple[int, int]], mc: Multicall
) -> list[tuple[int, int]]:
    """
    For each (collateral_shares, protected_shares) compute
    (assets_collateral, assets_protected) via Silo.previewRedeem at BLOCK.
    """
    calls: list[tuple[str, bytes]] = []
    for collateral_shares, protected_shares in shares_pairs:
        calls.append((SILO_ADDRESS, call_preview_redeem_silo(collateral_shares, COLLATERAL_TYPE_COLLATERAL)))
        calls.append((SILO_ADDRESS, call_preview_redeem_silo(protected_shares, COLLATERAL_TYPE_PROTECTED)))
    res = mc.aggregate(calls)
    out: list[tuple[int, int]] = []
    for idx in range(len(shares_pairs)):
        c_ok, c_data = res[2 * idx]
        p_ok, p_data = res[2 * idx + 1]
        assets_collateral = dec_uint(c_data) if c_ok else 0
        assets_protected = dec_uint(p_data) if p_ok else 0
        out.append((assets_collateral, assets_protected))
    return out


def expand_vault(
    vault: str,
    vault_shares: tuple[int, int],
    vault_assets: tuple[int, int],
    rpc: RpcClient,
    mc: Multicall,
) -> dict[str, Any]:
    """Build the vaults[vault] entry, including depositor attribution."""
    collateral_shares, protected_shares = vault_shares
    assets_collateral, assets_protected = vault_assets
    vault_silo_assets = assets_collateral + assets_protected

    # config(SILO).enabled -> in withdraw queue?
    cfg = mc.aggregate([(vault, call_config(SILO_ADDRESS))])
    in_withdraw_queue = False
    if cfg[0][0]:
        try:
            _cap, in_withdraw_queue, _removable = dec_config(cfg[0][1])
        except Exception:
            in_withdraw_queue = False

    indexed = fetch_vault_indexed(vault)
    name = indexed.get("name") if isinstance(indexed, dict) else None

    entry: dict[str, Any] = {
        "name": name,
        "indexed_in_subgraph": indexed is not None,
        "in_withdraw_queue": in_withdraw_queue,
        "vault_silo_assets": str(vault_silo_assets),
        "vault_total_supply": None,
        "depositors": {},
    }

    if not in_withdraw_queue:
        entry["status"] = "not_in_withdraw_queue"
        return entry

    if indexed is None:
        entry["status"] = "vault_not_indexed"
        return entry

    entry["status"] = "ok"

    depositor_addrs = fetch_vault_depositors(vault)

    # Total supply + per-depositor balanceOf (raw) via multicall.
    ts_res = mc.aggregate([(vault, call_total_supply())])
    vault_total_supply = dec_uint(ts_res[0][1]) if ts_res[0][0] else 0
    entry["vault_total_supply"] = str(vault_total_supply)

    bal_calls = [(vault, call_balance_of(d)) for d in depositor_addrs]
    bal_res = mc.aggregate(bal_calls)
    balances: dict[str, int] = {}
    for idx, d in enumerate(depositor_addrs):
        ok, data = bal_res[idx]
        balances[d] = dec_uint(data) if ok else 0

    types, _ = classify_addresses(depositor_addrs, rpc, mc)

    for d in depositor_addrs:
        shares = balances[d]
        fraction = (shares / vault_total_supply) if vault_total_supply else 0.0
        attributed = (vault_silo_assets * shares) // vault_total_supply if vault_total_supply else 0
        entry["depositors"][d] = {
            "address_type": types.get(d, "unknown"),
            "vault_shares": str(shares),
            "fraction": f"{fraction:.18f}",
            "attributed_silo_assets": str(attributed),
        }

    return entry


def build_snapshot(rpc_url: str) -> dict[str, Any]:
    rpc = RpcClient(rpc_url, BLOCK)
    mc = Multicall(rpc, MULTICALL3, MULTICALL_BATCH)

    print(f"[info] fetching lenders for silo {SILO_ADDRESS} at block {BLOCK} ...")
    accounts, sp_token = fetch_lenders(SILO_ADDRESS)
    print(f"[info] {len(accounts)} unique lender accounts; protected share token = {sp_token}")
    if sp_token is None:
        raise SystemExit("Could not determine protected share token from subgraph (no positions?).")

    print("[info] fetching silo metadata + total supplies ...")
    meta = fetch_silo_metadata(rpc, mc, sp_token)

    print("[info] classifying lender addresses ...")
    types, _incentives = classify_addresses(accounts, rpc, mc)

    print("[info] reading direct lender share balances ...")
    shares_by_addr = fetch_direct_lender_shares(accounts, mc, sp_token)

    print("[info] computing previewRedeem assets for direct lenders ...")
    ordered = accounts
    pairs = [shares_by_addr[a] for a in ordered]
    assets = preview_redeem_pairs(pairs, mc)

    direct_lenders: dict[str, Any] = {}
    for addr, (collateral_shares, protected_shares), (assets_collateral, assets_protected) in zip(
        ordered, pairs, assets
    ):
        total_assets = assets_collateral + assets_protected
        direct_lenders[addr] = {
            "address_type": types.get(addr, "unknown"),
            "collateral_shares": str(collateral_shares),
            "protected_shares": str(protected_shares),
            "assets_collateral": str(assets_collateral),
            "assets_protected": str(assets_protected),
            "total_assets": str(total_assets),
        }

    vault_addrs = [a for a in accounts if types.get(a) == "silo_vault"]
    print(f"[info] expanding {len(vault_addrs)} SiloVault(s) ...")
    vaults: dict[str, Any] = {}
    for vault in vault_addrs:
        vault_shares = shares_by_addr[vault]
        vault_assets = next(a for x, a in zip(ordered, assets) if x == vault)
        print(f"[info]   vault {vault} ...")
        vaults[vault] = expand_vault(vault, vault_shares, vault_assets, rpc, mc)

    silo_entry: dict[str, Any] = {
        "snapshot_block": BLOCK,
        "silo_id": meta["silo_id"],
        "input_token": meta["input_token"],
        "protected_share_token": sp_token,
        "total_assets": str(meta["total_assets"]) if meta["total_assets"] is not None else None,
        "collateral_total_supply": str(meta["collateral_total_supply"]),
        "protected_total_supply": str(meta["protected_total_supply"]),
        "direct_lenders": direct_lenders,
        "vaults": vaults,
    }
    return silo_entry


# --------------------------------------------------------------------------------------
# Output (incremental, per-chain)
# --------------------------------------------------------------------------------------
def write_output(silo_entry: dict[str, Any], chain: str, chain_id: int, silo_address: str) -> None:
    path = Path(OUTPUT_JSON)
    root: dict[str, Any] = {}
    if path.exists():
        try:
            root = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(root, dict):
                root = {}
        except json.JSONDecodeError:
            root = {}

    chain_obj = root.get(chain)
    if not isinstance(chain_obj, dict):
        chain_obj = {}
    chain_obj["chain_id"] = chain_id
    silos = chain_obj.get("silos")
    if not isinstance(silos, dict):
        silos = {}
    silos[norm(silo_address)] = silo_entry
    chain_obj["silos"] = silos
    root[chain] = chain_obj

    path.write_text(json.dumps(root, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[ok] wrote {path}")


def main() -> int:
    load_secrets()
    completed = 0
    for target in TARGETS:
        silos = target.get("silos") or []
        if not silos:
            print(f"[skip] chain={target['chain']} has no configured silos")
            continue
        rpc_url = resolve_rpc_url(str(target["chain"]))
        for silo in silos:
            configure_context(target, silo)
            silo_entry = build_snapshot(rpc_url)
            write_output(silo_entry, CHAIN, CHAIN_ID, SILO_ADDRESS)
            direct = len(silo_entry["direct_lenders"])
            vaults = len(silo_entry["vaults"])
            print(f"[done] chain={CHAIN} silo={SILO_ADDRESS} direct_lenders={direct} vaults={vaults}")
            completed += 1
    if completed == 0:
        print("[done] no silos configured")
    return 0


if __name__ == "__main__":
    sys.exit(main())
