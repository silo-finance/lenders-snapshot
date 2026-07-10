#!/usr/bin/env python3
"""
Silo lender snapshot.

Builds block-pinned snapshots of all lenders for configured Silos:
  - direct lenders (every account holding collateral shares), and
  - SiloVault depositors (holders of any SiloVault that itself lends into the Silo),
    attributed by their fraction of the vault.

Redeemable `assets` per address are computed purely on-chain via `previewRedeem`
at the snapshot block. The subgraph is only used to enumerate addresses.

All historical reads are batched through Multicall3 (aggregate3, allowFailure=true)
with eth_call pinned at BLOCK. eth_getCode is issued in JSON-RPC batches.

Secrets ({CHAIN}_RPC_URL/RPC_URL, THE_GRAPH_API_KEY) are read ONLY from the environment
or a local gitignored `.env` next to this script. They must never be committed.

A category slug is required (scanning is per-category, never implicitly all):

    python3 scripts/lender-snapshot/snapshot_lenders.py <category-slug>
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
from eth_utils import function_signature_to_4byte_selector, keccak, to_checksum_address

SCRIPT_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------------------
# HARDCODED (non-secret) configuration
# --------------------------------------------------------------------------------------
# Per-chain Silo subgraph deployments (The Graph gateway). DEFAULT_SUBGRAPH_URL is Sonic;
# each non-sonic chain has its own deployment and is referenced by name in CATEGORIES.
DEFAULT_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id/8wcbzcdNirQvk1ETh25wpVzb5GWs8DvugpbwrYnTCcxj"
AVALANCHE_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id/6NLL9WmjPYima4NhUpNEWeDu5eBXFuhP9QheRXkoJXR5"
ARBITRUM_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id/DK5qWsSJSqkeW2GHDQQCB7xHnHwVN3K1LPpP6CYNXMh8"
ETHEREUM_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id/2z5Mn4WW7K4yR1iH9KdignREkTq9EM1S4GX3yLaztRFg"

# eth_getLogs block range per call, hardcoded per chain. Our provider (dRPC) enforces no
# hard block-range cap on eth_getLogs -- the binding limits are 10,000 results and a 10s
# query duration (identical on Sonic/Avalanche/Arbitrum/Ethereum). Since every scan filters
# by a single silo address + event topics, per-chunk log density is tiny and the queries are
# served from the node's log index, so large ranges stay well within both limits. Referenced
# by "block_chunk" in CATEGORIES. The scanner auto-halves the range on any RPC rejection, so
# these are safe upper bounds rather than exact caps.
SONIC_BLOCK_CHUNK = 500_000
AVALANCHE_BLOCK_CHUNK = 500_000
ARBITRUM_BLOCK_CHUNK = 500_000
ETHEREUM_BLOCK_CHUNK = 100_000

# Snapshot categories. Each category is a self-contained snapshot rendered under its own
# path in the UI (e.g. `/lenders-snapshot/stream`) and written to its own data file
# (`data/<slug>.json`). Categories are intentionally HARDCODED here: adding one is a rare,
# deliberate edit (new silo list) followed by a rerun of this script.
#
# Each category maps to a list of chain targets. Each chain target has:
#   "chain" (slug), "chain_id", "subgraph_url", "block" (required; the single snapshot
#   block shared by every silo on that chain), "events_to_block" (required; the single
#   block up to which post-snapshot events are scanned on that chain -- declared per chain
#   because block numbers are chain-specific, and timestamp-matched across chains so the
#   post-snapshot window ends at the same wall-clock time everywhere), "block_chunk"
#   (required; the eth_getLogs block range per call, declared per chain because RPC limits
#   are chain-specific), and a "silos" list.
# Each entry in a chain's `silos` list supports:
#   "address" (required),
#   "type"    (optional): "silo" (default) enumerates collateral lenders via the subgraph
#             `positions`; "silo_vault" enumerates ERC4626 depositors via `vaultPositions`.
#   "borrow_repay_silo" (optional): for a two-sided market (two silos sharing one SILO_ID),
#             the paired silo address whose asset is borrowed against this silo's collateral.
#             Its post-snapshot Borrow (debit) and Repay (credit) events are folded into this
#             silo's lenders' pending, converted to this silo's asset decimals. The paired
#             silo is NOT listed as its own entry.
CATEGORIES: dict[str, dict[str, Any]] = {
    # The following three categories were classified from on-chain liquidation thresholds:
    # only the borrowable/lending side of each market is kept. Non-sonic chains use their
    # own Silo subgraph deployment and require the matching {CHAIN}_RPC_URL env var.
    "pendle": {
        "targets": [
            {
                "chain": "sonic",
                "chain_id": 146,
                "subgraph_url": DEFAULT_SUBGRAPH_URL,
                "block": 54144258,
                "events_to_block": 75700045,
                "block_chunk": SONIC_BLOCK_CHUNK,
                "silos": [
                    {"address": "0xcd95a588c0190bf9810381a19ecad8bc8306d7f2"},  # WETH
                    {"address": "0x08c320a84a59c6f533e0dca655cf497594bca1f9"},  # WETH
                    {"address": "0x24c74b30d1a4261608e84bf5a618693032681dac"},  # scETH
                    {"address": "0x4f55e28d36b30a638c3aa1d5cbf9c4ccb3831506"},  # USDC
                    {"address": "0x27968d36b937dcb26f33902fa489e5b228b104be"},  # dUSD
                    {"address": "0x6030ad53d90ec2fb67f3805794dbb3fa5fd6eb64"},  # USDC
                    {"address": "0xda14a41dbda731f03a94cb722191639dd22b35b2"},  # frxUSD
                ],
            },
        ],
    },
    "trevee": {
        "targets": [
            {
                "chain": "sonic",
                "chain_id": 146,
                "subgraph_url": DEFAULT_SUBGRAPH_URL,
                "block": 54144258,
                "events_to_block": 75700045,
                "block_chunk": SONIC_BLOCK_CHUNK,
                "silos": [
                    {"address": "0x219656f33c58488d09d518badf50aa8cdcaca2aa"},  # WETH
                    {"address": "0x5954ce6671d97d24b782920ddcdbb4b1e63ab2de"},  # USDC
                    {"address": "0x4935fadb17df859667cc4f7bfe6a8cb24f86f8d0"},  # USDC
                ],
            },
        ],
    },
    "stream": {
        "targets": [
            {
                "chain": "sonic",
                "chain_id": 146,
                "subgraph_url": DEFAULT_SUBGRAPH_URL,
                "block": 54144258,
                "events_to_block": 75700045,
                "block_chunk": SONIC_BLOCK_CHUNK,
                "silos": [
                    # Two-sided markets: the stable silo is the lender silo; its paired xUSD
                    # silo supplies Borrow/Repay (not listed as its own entry).
                    {
                        "address": "0xa1627a0e1d0ebca9326d2219b84df0c600bed4b1",  # USDC, silo_id=112
                        "borrow_repay_silo": "0x172a687c397e315dbe56ed78ab347d7743d0d4fa",  # xUSD
                    },
                    {
                        "address": "0xb1412442aa998950f2f652667d5eba35fe66e43f",  # scUSD, silo_id=118
                        "borrow_repay_silo": "0x596aef68a03a0e35c4d8e624fbbdb0df0862f172",  # xUSD
                    },
                ],
            },
            {
                "chain": "avalanche",
                "chain_id": 43114,
                "subgraph_url": AVALANCHE_SUBGRAPH_URL,
                "block": 71568801,  # timestamp-matched to sonic block 54144258
                "events_to_block": 89947428,  # timestamp-matched to sonic block 75700045
                "block_chunk": AVALANCHE_BLOCK_CHUNK,
                "silos": [
                    {"address": "0x7437ac81457fa98ffb2d0c8f9943ecfe4813e2f1"},  # BTC.b
                    {"address": "0x672b77f0538b53dc117c9ddfeb7377a678d321a6"},  # USDC
                    {"address": "0x9c4d4800b489d217724155399cd64d07eae603f3"},  # AUSD
                    {"address": "0xe0fc62e685e2b3183b4b88b1fe674cfec55a63f7"},  # USDt
                ],
            },
            {
                "chain": "arbitrum",
                "chain_id": 42161,
                "subgraph_url": ARBITRUM_SUBGRAPH_URL,
                "block": 397731482,  # timestamp-matched to sonic block 54144258
                "events_to_block": 482328398,  # timestamp-matched to sonic block 75700045
                "block_chunk": ARBITRUM_BLOCK_CHUNK,
                "silos": [
                    # Two-sided market: USDC is the lender silo; paired xUSD supplies Borrow/Repay.
                    {
                        "address": "0xacb7432a4bb15402ce2afe0a7c9d5b738604f6f9",  # USDC, silo_id=146
                        "borrow_repay_silo": "0xf0543d476e7906374863091034fe679a7be8ee20",  # xUSD
                    },
                ],
            },
            {
                "chain": "ethereum",
                "chain_id": 1,
                "subgraph_url": ETHEREUM_SUBGRAPH_URL,
                "block": 23747116,  # timestamp-matched to sonic block 54144258
                "events_to_block": 25501084,  # timestamp-matched to sonic block 75700045
                "block_chunk": ETHEREUM_BLOCK_CHUNK,
                "silos": [
                    {"address": "0x1de3ba67da79a81bc0c3922689c98550e4bd9bc2"},  # USDC
                ],
            },
        ],
    },
}

BLOCK = 0
SILO_ADDRESS = ""
# For two-sided markets: the paired silo whose Borrow/Repay events adjust this silo's
# lenders' pending. Empty for ordinary (one-sided) silos.
BORROW_REPAY_SILO = ""
# Either "silo" (collateral lenders via subgraph `positions`) or "silo_vault"
# (ERC4626 depositors via subgraph `vaultPositions`). A SiloVault shares the Silo read
# interface, but its holders are indexed as vault depositors, not silo positions.
SILO_TYPE = "silo"
CHAIN = ""
CHAIN_ID = 0
SUBGRAPH_URL = DEFAULT_SUBGRAPH_URL

SILO_TYPE_SILO = "silo"
SILO_TYPE_VAULT = "silo_vault"
VALID_SILO_TYPES = (SILO_TYPE_SILO, SILO_TYPE_VAULT)

# Per-category snapshot files live under `data/<slug>.json`. This directory is also what
# the frontend imports from (see src/categories.ts).
DATA_DIR = SCRIPT_DIR / "data"


def category_output_path(slug: str, category: dict[str, Any]) -> Path:
    """Resolve the output JSON path for a category (defaults to `data/<slug>.json`)."""
    filename = str(category.get("output") or f"{slug}.json")
    return DATA_DIR / filename

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MULTICALL_BATCH = 300

GETCODE_BATCH = 200
SUBGRAPH_PAGE = 1000

# CollateralType enum (ISilo.sol): Collateral = 1
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
# Silo.maxRepay(address) -> assets: the borrower's outstanding debt in the silo's asset units.
SEL_MAX_REPAY = _sel("maxRepay(address)")
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
SEL_SAFE_VERSION = _sel("VERSION()")
SEL_SAFE_CHAIN_ID = _sel("getChainId()")
SEL_SAFE_OWNERS = _sel("getOwners()")
SEL_SAFE_THRESHOLD = _sel("getThreshold()")
SEL_SAFE_NONCE = _sel("nonce()")
TOPIC_WITHDRAW = "0x" + keccak(text="Withdraw(address,address,address,uint256,uint256)").hex()
# ERC4626 Deposit(sender, receiver, assets, shares): two indexed addresses, so the credited
# account (receiver) is topics[2]. Only collateral deposits hit the Silo/Vault share token;
# protected collateral lives in a separate token, so this naturally excludes protected.
TOPIC_DEPOSIT = "0x" + keccak(text="Deposit(address,address,uint256,uint256)").hex()
# ERC20 Transfer(from, to, value): both addresses indexed. Share tokens (Silo collateral
# token and vault shares) are transferable, so peer-to-peer transfers move a position
# without a Deposit/Withdraw event. Mint (from==0x0) and burn (to==0x0) are skipped because
# they are already accounted for by the Deposit/Withdraw scans.
TOPIC_TRANSFER = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
# Silo Borrow(sender, receiver, owner, assets, shares): three indexed addresses like the
# ERC4626 Withdraw, so the borrower (owner) is topics[3]. Used only for two-sided markets.
TOPIC_BORROW = "0x" + keccak(text="Borrow(address,address,address,uint256,uint256)").hex()
# Silo Repay(sender, owner, assets, shares): two indexed addresses, so the borrower (owner)
# being repaid is topics[2].
TOPIC_REPAY = "0x" + keccak(text="Repay(address,address,uint256,uint256)").hex()
ZERO_ADDRESS = "0x" + "0" * 40


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
    global BLOCK, SILO_ADDRESS, SILO_TYPE, CHAIN, CHAIN_ID, SUBGRAPH_URL, BORROW_REPAY_SILO
    CHAIN = str(target["chain"]).lower()
    CHAIN_ID = int(target["chain_id"])
    SUBGRAPH_URL = str(target.get("subgraph_url") or DEFAULT_SUBGRAPH_URL)
    SILO_ADDRESS = norm(str(silo["address"]))
    # The snapshot block is defined once per chain target and shared by all its silos.
    BLOCK = int(target["block"])
    paired = silo.get("borrow_repay_silo")
    BORROW_REPAY_SILO = norm(str(paired)) if paired else ""
    silo_type = str(silo.get("type", SILO_TYPE_SILO)).strip().lower()
    if silo_type not in VALID_SILO_TYPES:
        raise SystemExit(
            f"Invalid silo type {silo_type!r} for {SILO_ADDRESS}; expected one of {VALID_SILO_TYPES}."
        )
    SILO_TYPE = silo_type


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

    def eth_block_number(self) -> int:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "eth_blockNumber",
            "params": [],
        }
        res = _http_post_json(self.url, payload, self._headers)
        if "error" in res and res["error"]:
            raise RuntimeError(f"eth_blockNumber error: {res['error']}")
        return int(res["result"], 16)

    def eth_get_logs(self, address: str, topics: list[str], from_block: int, to_block: int) -> list[dict[str, Any]]:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "eth_getLogs",
            "params": [
                {
                    "address": cs(address),
                    "topics": topics,
                    "fromBlock": hex(from_block),
                    "toBlock": hex(to_block),
                }
            ],
        }
        res = _http_post_json(self.url, payload, self._headers)
        if "error" in res and res["error"]:
            raise RuntimeError(f"eth_getLogs error: {res['error']}")
        logs = res.get("result", [])
        if not isinstance(logs, list):
            raise RuntimeError(f"eth_getLogs invalid result: {logs!r}")
        return logs

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
                    raise RuntimeError(f"eth_getCode batch returned unknown id: {item!r}")
                if item.get("error"):
                    raise RuntimeError(f"eth_getCode error for {addr}: {item['error']}")
                code_hex = item.get("result")
                if not isinstance(code_hex, str):
                    raise RuntimeError(f"eth_getCode invalid result for {addr}: {code_hex!r}")
                out[addr] = bytes.fromhex(code_hex[2:])
            # Misclassification (e.g. a missing contract treated as EOA) would silently drop
            # data downstream, so every requested address must have a result.
            missing = [addr for addr in chunk if addr not in out]
            if missing:
                raise RuntimeError(f"eth_getCode batch missing results for {len(missing)} address(es): {missing}")
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


def call_max_repay(account: str) -> bytes:
    return SEL_MAX_REPAY + abi_encode(["address"], [cs(account)])


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


def call_safe_version() -> bytes:
    return SEL_SAFE_VERSION


def call_safe_chain_id() -> bytes:
    return SEL_SAFE_CHAIN_ID


def call_safe_owners() -> bytes:
    return SEL_SAFE_OWNERS


def call_safe_threshold() -> bytes:
    return SEL_SAFE_THRESHOLD


def call_safe_nonce() -> bytes:
    return SEL_SAFE_NONCE


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


def dec_address_array(data: bytes) -> list[str]:
    return [norm(addr) for addr in abi_decode(["address[]"], data)[0]]


def dec_config(data: bytes) -> tuple[int, bool, int]:
    cap, enabled, removable_at = abi_decode(["uint184", "bool", "uint64"], data)
    return int(cap), bool(enabled), int(removable_at)


def dec_string(data: bytes) -> str:
    try:
        return str(abi_decode(["string"], data)[0])
    except Exception:
        raw = abi_decode(["bytes32"], data)[0]
        return bytes(raw).split(b"\x00", 1)[0].decode("utf-8", errors="replace")


def dec_event_topic_address(topic: str) -> str:
    if not isinstance(topic, str) or not topic.startswith("0x") or len(topic) != 66:
        raise ValueError(f"invalid topic address: {topic!r}")
    return norm("0x" + topic[-40:])


def dec_flow_data(data_hex: str) -> tuple[int, int]:
    """Decode the (assets, shares) data payload shared by ERC4626 Withdraw and Deposit."""
    if not isinstance(data_hex, str) or not data_hex.startswith("0x"):
        raise ValueError(f"invalid flow event data: {data_hex!r}")
    payload = bytes.fromhex(data_hex[2:])
    assets, shares = abi_decode(["uint256", "uint256"], payload)
    return int(assets), int(shares)


def is_gnosis_safe_probe(
    version_ok: bool,
    version_data: bytes,
    chain_id_ok: bool,
    chain_id_data: bytes,
    owners_ok: bool,
    owners_data: bytes,
    threshold_ok: bool,
    threshold_data: bytes,
    nonce_ok: bool,
    nonce_data: bytes,
) -> bool:
    """Return true when a contract satisfies the core Gnosis Safe read interface."""
    if not (version_ok and chain_id_ok and owners_ok and threshold_ok and nonce_ok):
        return False
    try:
        version = dec_string(version_data).strip()
        chain_id = dec_uint(chain_id_data)
        owners = dec_address_array(owners_data)
        threshold = dec_uint(threshold_data)
        dec_uint(nonce_data)
    except Exception:
        return False
    return bool(version) and chain_id > 0 and len(owners) > 0 and threshold > 0


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
    data = res.get("data")
    if data is None:
        # No errors but no data: do not let pagination silently treat this as "empty".
        raise RuntimeError(f"Subgraph returned no data (response keys: {sorted(res.keys())})")
    return data


# Cursor pagination ordered by the primary key `id` (always indexed). skip-based
# pagination is unstable: without orderBy The Graph does not guarantee a consistent
# order across pages, so skip can drop or duplicate rows between runs.
Q_LENDERS_TEMPLATE = """
query Lenders($m:String!,$first:Int!,$lastId:String!){
  positions(
    block:{number:%d}
    first:$first
    orderBy:id
    orderDirection:asc
    where:{ market:$m, sTokenBalance_gt:0, id_gt:$lastId }
  ){
    id
    account{ id }
    sToken{ id }
    sTokenBalance
  }
}
"""

Q_IS_VAULT_TEMPLATE = """
query IsVault($v:String!){
  vault(id:$v, block:{number:%d}){ id name }
}
"""

Q_VAULT_DEPOSITORS_TEMPLATE = """
query VaultDepositors($v:String!,$first:Int!,$lastId:ID!){
  vaultPositions(
    block:{number:%d}
    first:$first
    orderBy:id
    orderDirection:asc
    where:{ vault:$v, shares_gt:0, id_gt:$lastId }
  ){
    id
    account{ id }
    shares
  }
}
"""


def fetch_lenders(market: str) -> list[str]:
    """Return unique collateral lender addresses."""
    accounts: list[str] = []
    seen: set[str] = set()
    last_id = ""
    while True:
        data = graph_query(Q_LENDERS_TEMPLATE % BLOCK, {"m": market, "first": SUBGRAPH_PAGE, "lastId": last_id})
        rows = data.get("positions", [])
        if not rows:
            break
        for row in rows:
            acc = norm(row["account"]["id"])
            if acc not in seen:
                seen.add(acc)
                accounts.append(acc)
        if len(rows) < SUBGRAPH_PAGE:
            break
        last_id = rows[-1]["id"]
    return accounts


def fetch_vault_indexed(vault: str) -> dict[str, Any] | None:
    data = graph_query(Q_IS_VAULT_TEMPLATE % BLOCK, {"v": vault})
    return data.get("vault")


def fetch_vault_depositors(vault: str) -> list[str]:
    """Return unique depositor addresses. Share amounts come from RPC balanceOf, not the graph."""
    out: list[str] = []
    seen: set[str] = set()
    last_id = ""
    while True:
        data = graph_query(Q_VAULT_DEPOSITORS_TEMPLATE % BLOCK, {"v": vault, "first": SUBGRAPH_PAGE, "lastId": last_id})
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
        last_id = rows[-1]["id"]
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
    eoa | silo_vault | gnosis_safe | erc4626_unresolved | contract_other, and the
    second map holds the non-zero INCENTIVES_MODULE() address for silo_vault entries.
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

    # One multicall: SiloVault, Gnosis Safe, and ERC4626 probes per contract.
    calls: list[tuple[str, bytes]] = []
    for addr in contracts:
        calls.append((addr, call_incentives_module()))
        calls.append((addr, call_preview_redeem_erc4626(0)))
        calls.append((addr, call_safe_version()))
        calls.append((addr, call_safe_chain_id()))
        calls.append((addr, call_safe_owners()))
        calls.append((addr, call_safe_threshold()))
        calls.append((addr, call_safe_nonce()))
    res = mc.aggregate(calls)

    for idx, addr in enumerate(contracts):
        base = 7 * idx
        inc_ok, inc_data = res[base]
        pr_ok, _pr_data = res[base + 1]
        version_ok, version_data = res[base + 2]
        chain_id_ok, chain_id_data = res[base + 3]
        owners_ok, owners_data = res[base + 4]
        threshold_ok, threshold_data = res[base + 5]
        nonce_ok, nonce_data = res[base + 6]
        inc_addr = ""
        if inc_ok and len(inc_data) >= 32:
            try:
                inc_addr = dec_address(inc_data)
            except Exception:
                inc_addr = ""
        if inc_addr and int(inc_addr, 16) != 0:
            types[addr] = "silo_vault"
            incentives[addr] = inc_addr
        elif is_gnosis_safe_probe(
            version_ok,
            version_data,
            chain_id_ok,
            chain_id_data,
            owners_ok,
            owners_data,
            threshold_ok,
            threshold_data,
            nonce_ok,
            nonce_data,
        ):
            types[addr] = "gnosis_safe"
        elif pr_ok:
            types[addr] = "erc4626_unresolved"
        else:
            types[addr] = "contract_other"

    return types, incentives


# --------------------------------------------------------------------------------------
# Snapshot building
# --------------------------------------------------------------------------------------
def _fetch_asset_meta(silo_address: str, mc: Multicall) -> tuple[int, str | None]:
    """Read a silo's underlying-asset ERC20 decimals and symbol.

    Used to convert a paired (two-sided) silo's Borrow/Repay amounts into the main silo's
    asset units and to label those amounts in the UI. A decimals revert is fatal: without it
    the conversion would be silently wrong. Symbol is best-effort (None on failure).
    """
    res = mc.aggregate([(silo_address, call_asset())])
    if not res[0][0]:
        raise RuntimeError(f"asset() reverted for paired silo {silo_address} at block {BLOCK}")
    asset_addr = dec_address(res[0][1])
    if not asset_addr:
        raise RuntimeError(f"asset() returned empty for paired silo {silo_address} at block {BLOCK}")
    d = mc.aggregate([(asset_addr, call_decimals()), (asset_addr, call_symbol())])
    if not d[0][0]:
        raise RuntimeError(f"decimals() reverted for asset {asset_addr} of paired silo {silo_address}")
    decimals = dec_uint(d[0][1])
    symbol = None
    if d[1][0]:
        try:
            symbol = dec_string(d[1][1])
        except Exception:
            symbol = None
    return decimals, symbol


def fetch_silo_metadata(rpc: RpcClient, mc: Multicall) -> dict[str, Any]:
    res = mc.aggregate(
        [
            (SILO_ADDRESS, call_asset()),
            (SILO_ADDRESS, call_total_supply()),
            (SILO_ADDRESS, call_total_assets()),
            (SILO_ADDRESS, call_silo_config()),
        ]
    )
    # Critical fields drive share->asset valuation; a revert here must fail loudly.
    if not res[0][0]:
        raise RuntimeError(f"asset() reverted for silo {SILO_ADDRESS} at block {BLOCK}")
    if not res[1][0]:
        raise RuntimeError(f"totalSupply() reverted for silo {SILO_ADDRESS} at block {BLOCK}")
    if not res[2][0]:
        raise RuntimeError(f"totalAssets() reverted for silo {SILO_ADDRESS} at block {BLOCK}")
    if not res[3][0]:
        raise RuntimeError(f"silo_config() reverted for silo {SILO_ADDRESS} at block {BLOCK}")
    asset_addr = dec_address(res[0][1])
    collateral_total_supply = dec_uint(res[1][1])
    total_assets = dec_uint(res[2][1])
    config_addr = dec_address(res[3][1])

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
    }


def fetch_vault_metadata(rpc: RpcClient, mc: Multicall) -> dict[str, Any]:
    """Metadata for a standalone SiloVault target (ERC4626): asset, supply, total assets."""
    res = mc.aggregate(
        [
            (SILO_ADDRESS, call_asset()),
            (SILO_ADDRESS, call_total_supply()),
            (SILO_ADDRESS, call_total_assets()),
        ]
    )
    # Critical fields drive share->asset valuation; a revert here must fail loudly.
    if not res[0][0]:
        raise RuntimeError(f"asset() reverted for vault {SILO_ADDRESS} at block {BLOCK}")
    if not res[1][0]:
        raise RuntimeError(f"totalSupply() reverted for vault {SILO_ADDRESS} at block {BLOCK}")
    if not res[2][0]:
        raise RuntimeError(f"totalAssets() reverted for vault {SILO_ADDRESS} at block {BLOCK}")
    asset_addr = dec_address(res[0][1])
    total_supply = dec_uint(res[1][1])
    total_assets = dec_uint(res[2][1])

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

    return {
        # Vaults do not expose SILO_ID(); they are identified by address only.
        "silo_id": None,
        "input_token": {"address": asset_addr, "decimals": decimals, "symbol": symbol},
        "total_assets": total_assets,
        "collateral_total_supply": total_supply,
    }


def fetch_direct_lender_shares(addresses: list[str], mc: Multicall) -> dict[str, int]:
    """Return {addr: collateral_shares} via multicall balanceOf."""
    calls = [(SILO_ADDRESS, call_balance_of(addr)) for addr in addresses]
    res = mc.aggregate(calls)
    out: dict[str, int] = {}
    for idx, addr in enumerate(addresses):
        ok, data = res[idx]
        if not ok:
            raise RuntimeError(f"balanceOf reverted for lender {addr} on {SILO_ADDRESS} at block {BLOCK}")
        out[addr] = dec_uint(data)
    return out


def preview_redeem_collateral(shares: list[int], mc: Multicall) -> list[int]:
    """Compute collateral assets via Silo.previewRedeem at BLOCK."""
    calls = [(SILO_ADDRESS, call_preview_redeem_silo(amount, COLLATERAL_TYPE_COLLATERAL)) for amount in shares]
    res = mc.aggregate(calls)
    out: list[int] = []
    for idx, (ok, data) in enumerate(res):
        if not ok:
            raise RuntimeError(
                f"Silo previewRedeem reverted for shares={shares[idx]} on {SILO_ADDRESS} at block {BLOCK}"
            )
        out.append(dec_uint(data))
    return out


def preview_redeem_vault_shares(shares: list[int], mc: Multicall) -> list[int]:
    """Compute underlying assets via ERC4626 previewRedeem(uint256) at BLOCK."""
    calls = [(SILO_ADDRESS, call_preview_redeem_erc4626(amount)) for amount in shares]
    res = mc.aggregate(calls)
    out: list[int] = []
    for idx, (ok, data) in enumerate(res):
        if not ok:
            raise RuntimeError(
                f"ERC4626 previewRedeem reverted for shares={shares[idx]} on {SILO_ADDRESS} at block {BLOCK}"
            )
        out.append(dec_uint(data))
    return out


def _fetch_flow_events(
    rpc: RpcClient,
    contract_address: str,
    topic: str,
    owner_topic_index: int,
    min_topics: int,
    kind: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    """Scan ERC4626 Withdraw/Deposit logs for one contract.

    `owner_topic_index` selects the account a flow is attributed to: Withdraw credits the
    burning `owner` (topics[3]); Deposit credits the minted-to `receiver` (topics[2]).
    """
    if to_block < from_block:
        return []

    tag = label or contract_address
    total_blocks = to_block - from_block + 1
    progress_step = max(block_chunk, total_blocks // 20)
    next_progress_at = from_block + progress_step

    events: list[dict[str, Any]] = []
    start = from_block
    chunk = block_chunk
    print(f"[info]   [{tag}] scanning {kind} logs in blocks {from_block}..{to_block} ({total_blocks} blocks) ...")
    while start <= to_block:
        end = min(start + chunk - 1, to_block)
        try:
            logs = rpc.eth_get_logs(contract_address, [topic], start, end)
        except RuntimeError as exc:
            if chunk <= 100:
                raise
            chunk = max(100, chunk // 2)
            print(
                f"[warn] reducing eth_getLogs chunk for {contract_address} to {chunk} "
                f"blocks after error: {exc}"
            )
            continue

        if end >= next_progress_at or end == to_block:
            done_blocks = end - from_block + 1
            pct = (done_blocks * 100) // total_blocks
            print(
                f"[info]   [{tag}] progress: block {end} ({done_blocks}/{total_blocks} = {pct}%), "
                f"events so far: {len(events) + len(logs)}"
            )
            next_progress_at = end + progress_step

        for log in logs:
            topics = log.get("topics")
            # The topic0 filter guarantees a fixed event shape; a mismatch is an anomaly,
            # not something to silently skip (that would drop a real flow event).
            if not isinstance(topics, list) or len(topics) < min_topics:
                raise RuntimeError(
                    f"{kind} log with unexpected topic count on {contract_address} "
                    f"(tx={log.get('transactionHash')}, logIndex={log.get('logIndex')}): {topics!r}"
                )
            assets, shares = dec_flow_data(str(log.get("data", "0x")))
            event = {
                "block_number": int(str(log.get("blockNumber", "0x0")), 16),
                "tx_hash": str(log.get("transactionHash", "")).lower(),
                "log_index": int(str(log.get("logIndex", "0x0")), 16),
                "owner": dec_event_topic_address(topics[owner_topic_index]),
                "assets": assets,
                "shares": shares,
            }
            events.append(event)

        start = end + 1

    events.sort(key=lambda item: (item["block_number"], item["log_index"], item["tx_hash"]))
    print(f"[info]   [{tag}] done: {len(events)} {kind} event(s) found")
    return events


def fetch_withdraw_events(
    rpc: RpcClient,
    contract_address: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    return _fetch_flow_events(
        rpc,
        contract_address,
        TOPIC_WITHDRAW,
        owner_topic_index=3,
        min_topics=4,
        kind="Withdraw",
        from_block=from_block,
        to_block=to_block,
        label=label,
        block_chunk=block_chunk,
    )


def fetch_deposit_events(
    rpc: RpcClient,
    contract_address: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    return _fetch_flow_events(
        rpc,
        contract_address,
        TOPIC_DEPOSIT,
        owner_topic_index=2,
        min_topics=3,
        kind="Deposit",
        from_block=from_block,
        to_block=to_block,
        label=label,
        block_chunk=block_chunk,
    )


def fetch_borrow_events(
    rpc: RpcClient,
    contract_address: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    """Scan Silo Borrow logs for one silo (owner = borrower = topics[3])."""
    return _fetch_flow_events(
        rpc,
        contract_address,
        TOPIC_BORROW,
        owner_topic_index=3,
        min_topics=4,
        kind="Borrow",
        from_block=from_block,
        to_block=to_block,
        label=label,
        block_chunk=block_chunk,
    )


def fetch_repay_events(
    rpc: RpcClient,
    contract_address: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    """Scan Silo Repay logs for one silo (owner = borrower = topics[2])."""
    return _fetch_flow_events(
        rpc,
        contract_address,
        TOPIC_REPAY,
        owner_topic_index=2,
        min_topics=3,
        kind="Repay",
        from_block=from_block,
        to_block=to_block,
        label=label,
        block_chunk=block_chunk,
    )


def fetch_transfer_events(
    rpc: RpcClient,
    contract_address: str,
    from_block: int,
    to_block: int,
    block_chunk: int,
    label: str = "",
) -> list[dict[str, Any]]:
    """Scan peer-to-peer ERC20 Transfer logs for one share token.

    Returns {block_number, tx_hash, log_index, from, to, value(shares)}. Mint (from==0x0)
    and burn (to==0x0) transfers are skipped: they accompany Deposit/Withdraw and are already
    counted by those scans, so including them here would double-count.
    """
    if to_block < from_block:
        return []

    tag = label or contract_address
    total_blocks = to_block - from_block + 1
    progress_step = max(block_chunk, total_blocks // 20)
    next_progress_at = from_block + progress_step

    events: list[dict[str, Any]] = []
    start = from_block
    chunk = block_chunk
    print(f"[info]   [{tag}] scanning Transfer logs in blocks {from_block}..{to_block} ({total_blocks} blocks) ...")
    while start <= to_block:
        end = min(start + chunk - 1, to_block)
        try:
            logs = rpc.eth_get_logs(contract_address, [TOPIC_TRANSFER], start, end)
        except RuntimeError as exc:
            if chunk <= 100:
                raise
            chunk = max(100, chunk // 2)
            print(
                f"[warn] reducing eth_getLogs chunk for {contract_address} to {chunk} "
                f"blocks after error: {exc}"
            )
            continue

        if end >= next_progress_at or end == to_block:
            done_blocks = end - from_block + 1
            pct = (done_blocks * 100) // total_blocks
            print(
                f"[info]   [{tag}] progress: block {end} ({done_blocks}/{total_blocks} = {pct}%), "
                f"events so far: {len(events) + len(logs)}"
            )
            next_progress_at = end + progress_step

        for log in logs:
            topics = log.get("topics")
            # The Transfer topic0 filter guarantees indexed from/to topics; a mismatch is
            # an anomaly, not something to silently skip (that would drop a real transfer).
            if not isinstance(topics, list) or len(topics) < 3:
                raise RuntimeError(
                    f"Transfer log with unexpected topic count on {contract_address} "
                    f"(tx={log.get('transactionHash')}, logIndex={log.get('logIndex')}): {topics!r}"
                )
            sender = dec_event_topic_address(topics[1])
            receiver = dec_event_topic_address(topics[2])
            if sender == ZERO_ADDRESS or receiver == ZERO_ADDRESS:
                # Mint / burn: already represented by Deposit / Withdraw scans.
                continue
            value = int(str(log.get("data", "0x")), 16)
            event = {
                "block_number": int(str(log.get("blockNumber", "0x0")), 16),
                "tx_hash": str(log.get("transactionHash", "")).lower(),
                "log_index": int(str(log.get("logIndex", "0x0")), 16),
                "from": sender,
                "to": receiver,
                "value": value,
            }
            events.append(event)

        start = end + 1

    events.sort(key=lambda item: (item["block_number"], item["log_index"], item["tx_hash"]))
    print(f"[info]   [{tag}] done: {len(events)} peer Transfer event(s) found")
    return events


def resolve_events_to_block(target: dict[str, Any]) -> int:
    """The post-snapshot scan-end block is declared once per chain target and is required.

    Block numbers are chain-specific, so a single value cannot be shared across chains (a
    Sonic block reused elsewhere would skip or truncate the scan). The value is
    timestamp-matched across chains so every chain's post-snapshot window ends at the same
    wall-clock time. No per-silo or env override.
    """
    raw = target.get("events_to_block")
    if raw in (None, ""):
        raise SystemExit(
            f"Missing 'events_to_block' for chain target {target.get('chain')!r}; "
            "it must be declared per chain."
        )
    value = int(raw)
    if value < 0:
        raise ValueError("events_to_block must be non-negative")
    return value


def resolve_block_chunk(target: dict[str, Any]) -> int:
    """The eth_getLogs chunk is declared once per chain target and is required.

    Different chains' RPCs tolerate different `eth_getLogs` ranges (and some load
    balancers silently truncate oversized ranges), so the value is chain-specific
    with no per-silo or env override.
    """
    raw = target.get("block_chunk")
    if raw in (None, ""):
        raise SystemExit(
            f"Missing 'block_chunk' for chain target {target.get('chain')!r}; "
            "it must be declared per chain."
        )
    value = int(raw)
    if value <= 0:
        raise ValueError("block_chunk must be positive")
    return value


FLOW_FIELD_KEYS = (
    "withdrawals",
    "total_withdrawals",
    "deposits",
    "total_deposits",
    "transfers",
    "total_transfers_in",
    "total_transfers_out",
    # Two-sided markets only (absent otherwise): Borrow debits, Repay credits.
    "borrows",
    "total_borrows",
    "repays",
    "total_repays",
    # Two-sided markets only: outstanding debt at the snapshot block (maxRepay), a debit.
    "debt_at_snapshot",
    "pending_assets",
)


def _init_flow_fields(entry: dict[str, Any], base_assets: int) -> None:
    entry["withdrawals"] = []
    entry["total_withdrawals"] = "0"
    entry["deposits"] = []
    entry["total_deposits"] = "0"
    entry["transfers"] = []
    entry["total_transfers_in"] = "0"
    entry["total_transfers_out"] = "0"
    entry["pending_assets"] = str(base_assets)


def _append_flow(
    entry: dict[str, Any],
    list_key: str,
    total_key: str,
    event: dict[str, Any],
    assets: int,
    extra: dict[str, Any] | None = None,
) -> None:
    rows = entry.get(list_key)
    if not isinstance(rows, list):
        rows = []
        entry[list_key] = rows
    row = {
        "block_number": event["block_number"],
        "tx_hash": event["tx_hash"],
        "log_index": event["log_index"],
        "assets": str(assets),
        "shares": str(event["shares"]),
    }
    if extra:
        row.update(extra)
    rows.append(row)
    entry[total_key] = str(int(entry.get(total_key, 0)) + assets)


def _append_transfer(
    entry: dict[str, Any],
    event: dict[str, Any],
    assets: int,
    direction: str,
    counterparty: str,
) -> None:
    """Record a peer-to-peer share transfer ('in' credits, 'out' debits the account)."""
    rows = entry.get("transfers")
    if not isinstance(rows, list):
        rows = []
        entry["transfers"] = rows
    rows.append(
        {
            "block_number": event["block_number"],
            "tx_hash": event["tx_hash"],
            "log_index": event["log_index"],
            "assets": str(assets),
            "shares": str(event["value"]),
            "direction": direction,
            "counterparty": counterparty,
        }
    )
    total_key = "total_transfers_in" if direction == "in" else "total_transfers_out"
    entry[total_key] = str(int(entry.get(total_key, 0)) + assets)


def _finalize_pending(entry: dict[str, Any], base_assets: int) -> None:
    """pending = base - debt_at_snapshot + deposits + transfers_in + repays - withdrawals - transfers_out - borrows.

    Signed on purpose (NOT clamped to zero): a negative result surfaces unreconciled flows
    (e.g. interest accrued between snapshot and withdrawal) instead of silently hiding them.

    Borrows/repays and debt_at_snapshot only exist for two-sided markets (converted to this
    silo's asset decimals upstream); they default to 0 for one-sided silos.
    """
    total_deposits = int(entry.get("total_deposits", 0))
    total_withdrawals = int(entry.get("total_withdrawals", 0))
    total_transfers_in = int(entry.get("total_transfers_in", 0))
    total_transfers_out = int(entry.get("total_transfers_out", 0))
    total_borrows = int(entry.get("total_borrows", 0))
    total_repays = int(entry.get("total_repays", 0))
    debt_at_snapshot = int(entry.get("debt_at_snapshot", 0))
    entry["pending_assets"] = str(
        base_assets
        - debt_at_snapshot
        + total_deposits
        + total_transfers_in
        + total_repays
        - total_withdrawals
        - total_transfers_out
        - total_borrows
    )


def _new_direct_lender_entry(address_type: str) -> dict[str, Any]:
    """A lender that first appears via a post-snapshot deposit (zero balance at snapshot)."""
    entry: dict[str, Any] = {
        "address_type": address_type,
        "collateral_shares": "0",
        "assets_collateral": "0",
        "total_assets": "0",
    }
    _init_flow_fields(entry, 0)
    return entry


def _new_depositor_entry(address_type: str) -> dict[str, Any]:
    """A vault depositor that first appears via a post-snapshot deposit."""
    entry: dict[str, Any] = {
        "address_type": address_type,
        "vault_shares": "0",
        "fraction": "0",
        "attributed_silo_assets": "0",
    }
    _init_flow_fields(entry, 0)
    return entry


def enrich_snapshot_with_flows(
    silo_entry: dict[str, Any],
    rpc: RpcClient,
    mc: Multicall,
    from_block: int,
    to_block: int,
    block_chunk: int,
) -> None:
    """Apply post-snapshot collateral Deposit (+) and Withdraw (-) flows to each position.

    Addresses that first appear via a post-snapshot deposit are added as new recipients.

    For two-sided markets (when `BORROW_REPAY_SILO` is set) the paired silo's Borrow (-) and
    Repay (+) events are also folded into this silo's direct lenders, converted to this silo's
    asset decimals.
    """
    direct_lenders = silo_entry.get("direct_lenders")
    if not isinstance(direct_lenders, dict):
        direct_lenders = {}
    vaults = silo_entry.get("vaults")
    if not isinstance(vaults, dict):
        vaults = {}

    for entry in direct_lenders.values():
        if not isinstance(entry, dict):
            continue
        if entry.get("address_type") == "silo_vault":
            # We do not distribute directly to vault contracts.
            for key in FLOW_FIELD_KEYS:
                entry.pop(key, None)
            continue
        _init_flow_fields(entry, int(entry.get("assets_collateral", 0)))

    for vault in vaults.values():
        if not isinstance(vault, dict):
            continue
        depositors = vault.get("depositors")
        if not isinstance(depositors, dict):
            continue
        for depositor in depositors.values():
            if not isinstance(depositor, dict):
                continue
            _init_flow_fields(depositor, int(depositor.get("attributed_silo_assets", 0)))

    scannable_vaults = [
        vault_addr
        for vault_addr, vault in vaults.items()
        if isinstance(vault, dict) and vault.get("status") == "ok" and isinstance(vault.get("depositors"), dict)
    ]
    print(f"[info] flow scan plan: 1 silo contract + {len(scannable_vaults)} vault contract(s)")

    silo_withdraws = fetch_withdraw_events(
        rpc, SILO_ADDRESS, from_block, to_block, label=f"silo {SILO_ADDRESS}", block_chunk=block_chunk
    )
    silo_deposits = fetch_deposit_events(
        rpc, SILO_ADDRESS, from_block, to_block, label=f"silo {SILO_ADDRESS}", block_chunk=block_chunk
    )
    silo_transfers = fetch_transfer_events(
        rpc, SILO_ADDRESS, from_block, to_block, label=f"silo {SILO_ADDRESS}", block_chunk=block_chunk
    )
    # Convert transferred collateral shares to assets at the snapshot rate (same valuation
    # basis as `assets_collateral`): assets = total_assets * shares / collateral_total_supply.
    silo_total_assets = int(silo_entry.get("total_assets") or 0)
    silo_total_supply = int(silo_entry.get("collateral_total_supply") or 0)

    def silo_shares_to_assets(shares: int) -> int:
        return (silo_total_assets * shares) // silo_total_supply if silo_total_supply else 0

    # Two-sided market: fold Borrow (debit) / Repay (credit) from the paired silo into this
    # silo's lenders. Event amounts are in the paired silo's asset units and are converted to
    # this silo's asset decimals in place (par 1:1 value assumption), so all downstream
    # bookkeeping stays in the main silo's units.
    silo_borrows: list[dict[str, Any]] = []
    silo_repays: list[dict[str, Any]] = []
    if BORROW_REPAY_SILO:
        main_decimals = int((silo_entry.get("input_token") or {}).get("decimals") or 0)
        paired_decimals, paired_symbol = _fetch_asset_meta(BORROW_REPAY_SILO, mc)
        # Record the debt asset so the UI can label Borrow/Repay/DEBT amounts distinctly.
        silo_entry["borrow_repay_token"] = {"symbol": paired_symbol, "decimals": paired_decimals}
        print(
            f"[info] two-sided market: scanning Borrow/Repay on paired silo {BORROW_REPAY_SILO} "
            f"(asset {paired_symbol}, decimals {paired_decimals} -> {main_decimals})"
        )

        def _to_main_assets(assets: int) -> int:
            if paired_decimals == main_decimals:
                return assets
            return assets * (10 ** main_decimals) // (10 ** paired_decimals)

        silo_borrows = fetch_borrow_events(
            rpc, BORROW_REPAY_SILO, from_block, to_block, label=f"paired {BORROW_REPAY_SILO}", block_chunk=block_chunk
        )
        silo_repays = fetch_repay_events(
            rpc, BORROW_REPAY_SILO, from_block, to_block, label=f"paired {BORROW_REPAY_SILO}", block_chunk=block_chunk
        )
        for event in (*silo_borrows, *silo_repays):
            event["assets"] = _to_main_assets(event["assets"])

    # Add lenders that first appear via a post-snapshot flow, classified at the snapshot block.
    existing_addrs = set(direct_lenders.keys())
    candidate_new: list[str] = []
    seen_new: set[str] = set()

    def _consider_new(addr: str) -> None:
        if addr in existing_addrs or addr in seen_new:
            return
        seen_new.add(addr)
        candidate_new.append(addr)

    for event in (*silo_deposits, *silo_withdraws):
        _consider_new(event["owner"])
    for event in silo_transfers:
        # Both sides of a peer transfer are real position changes (sender loses, receiver gains).
        _consider_new(event["from"])
        _consider_new(event["to"])
    for event in (*silo_borrows, *silo_repays):
        # A borrower posts collateral in this silo, so it is usually already a lender; still
        # consider it new so a borrow/repay never silently misses its account.
        _consider_new(event["owner"])
    new_types: dict[str, str] = {}
    if candidate_new:
        print(f"[info]   [silo] classifying {len(candidate_new)} new post-snapshot address(es) ...")
        new_types, _new_incentives = classify_addresses(candidate_new, rpc, mc)
        for owner in candidate_new:
            owner_type = new_types.get(owner, "unknown")
            if owner_type == "silo_vault":
                # New vault appearing post-snapshot: non-attributable rebalancer, not expanded.
                continue
            direct_lenders[owner] = _new_direct_lender_entry(owner_type)

    vault_addresses = {addr for addr, entry in direct_lenders.items() if entry.get("address_type") == "silo_vault"}
    vault_addresses |= {owner for owner in candidate_new if new_types.get(owner) == "silo_vault"}

    matched_withdraws = 0
    matched_deposits = 0
    skipped_rebalances = 0
    for event in silo_withdraws:
        owner = event["owner"]
        if owner in vault_addresses:
            # Vault rebalance at silo level, not an end-user flow.
            skipped_rebalances += 1
            continue
        entry = direct_lenders.get(owner)
        if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
            continue
        _append_flow(entry, "withdrawals", "total_withdrawals", event, event["assets"])
        matched_withdraws += 1
    for event in silo_deposits:
        owner = event["owner"]
        if owner in vault_addresses:
            skipped_rebalances += 1
            continue
        entry = direct_lenders.get(owner)
        if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
            continue
        _append_flow(entry, "deposits", "total_deposits", event, event["assets"])
        matched_deposits += 1

    matched_transfers = 0
    for event in silo_transfers:
        assets = silo_shares_to_assets(event["value"])
        for addr, direction in ((event["to"], "in"), (event["from"], "out")):
            if addr in vault_addresses:
                # Transfer to/from a vault contract: the vault side is non-attributable.
                continue
            entry = direct_lenders.get(addr)
            if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
                continue
            counterparty = event["from"] if direction == "in" else event["to"]
            _append_transfer(entry, event, assets, direction, counterparty)
            matched_transfers += 1

    # Borrow debits and Repay credits the borrower's position (paired-silo, two-sided market).
    matched_borrows = 0
    for event in silo_borrows:
        owner = event["owner"]
        if owner in vault_addresses:
            skipped_rebalances += 1
            continue
        entry = direct_lenders.get(owner)
        if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
            continue
        _append_flow(entry, "borrows", "total_borrows", event, event["assets"])
        matched_borrows += 1
    matched_repays = 0
    for event in silo_repays:
        owner = event["owner"]
        if owner in vault_addresses:
            skipped_rebalances += 1
            continue
        entry = direct_lenders.get(owner)
        if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
            continue
        _append_flow(entry, "repays", "total_repays", event, event["assets"])
        matched_repays += 1

    # Initial debt at the snapshot block: maxRepay(borrower) on the paired (debt) silo gives
    # each address's outstanding debt, which is folded into pending as a starting debit. Done
    # for every direct lender (incl. borrowers newly discovered above) once the set is final.
    matched_debts = 0
    if BORROW_REPAY_SILO:
        debt_addrs = [
            addr
            for addr, entry in direct_lenders.items()
            if isinstance(entry, dict) and entry.get("address_type") != "silo_vault"
        ]
        if debt_addrs:
            debt_res = mc.aggregate([(BORROW_REPAY_SILO, call_max_repay(addr)) for addr in debt_addrs])
            for addr, (ok, data) in zip(debt_addrs, debt_res):
                if not ok:
                    continue
                debt = _to_main_assets(dec_uint(data))
                if debt > 0:
                    direct_lenders[addr]["debt_at_snapshot"] = str(debt)
                    matched_debts += 1

    for entry in direct_lenders.values():
        if not isinstance(entry, dict) or entry.get("address_type") == "silo_vault":
            continue
        _finalize_pending(entry, int(entry.get("assets_collateral", 0)))

    print(
        f"[info]   [silo] matched {matched_deposits} deposit(s), {matched_withdraws} withdrawal(s), "
        f"{matched_transfers} transfer-side(s), skipped {skipped_rebalances} vault rebalance event(s); "
        f"added {len(direct_lenders) - len(existing_addrs)} new lender(s)"
    )
    if BORROW_REPAY_SILO:
        print(
            f"[info]   [silo] matched {matched_borrows} borrow(s), {matched_repays} repay(s), "
            f"{matched_debts} snapshot-debt position(s) from paired silo"
        )

    vault_index = 0
    for vault_addr, vault in vaults.items():
        if not isinstance(vault, dict):
            continue
        if vault.get("status") != "ok":
            continue
        depositors = vault.get("depositors")
        if not isinstance(depositors, dict):
            continue

        vault_index += 1
        vault_label = f"vault {vault_index}/{len(scannable_vaults)} {vault_addr}"
        vault_withdraws = fetch_withdraw_events(
            rpc, vault_addr, from_block, to_block, label=vault_label, block_chunk=block_chunk
        )
        vault_deposits = fetch_deposit_events(
            rpc, vault_addr, from_block, to_block, label=vault_label, block_chunk=block_chunk
        )
        vault_transfers = fetch_transfer_events(
            rpc, vault_addr, from_block, to_block, label=vault_label, block_chunk=block_chunk
        )
        # A SiloVault can lend into multiple silos, and a vault Withdraw/Deposit moves vault
        # shares for the vault's *total* underlying across all of them. Attributing the raw
        # event assets to every silo entry would both double-count across silos and credit
        # flows to silos where the vault held nothing at the snapshot block. Instead,
        # translate the moved vault shares into the assets attributable to THIS silo at the
        # snapshot rate:
        #   attributed = vault_silo_assets * shares / vault_total_supply
        # This keeps the same valuation basis as attributed_silo_assets, scales each silo by
        # its own position (no cross-silo double counting), and yields 0 for silos where the
        # vault's position was empty/dust at the snapshot block.
        vault_silo_assets = int(vault.get("vault_silo_assets", 0) or 0)
        vault_total_supply = int(vault.get("vault_total_supply", 0) or 0)

        def vault_shares_to_assets(shares: int, _sa: int = vault_silo_assets, _ts: int = vault_total_supply) -> int:
            return (_sa * shares) // _ts if _ts else 0

        # Add depositors that first appear via a post-snapshot deposit or transfer.
        existing_depositors = set(depositors.keys())
        candidate_dep: list[str] = []
        seen_dep: set[str] = set()

        def _consider_dep(addr: str) -> None:
            if addr in existing_depositors or addr in seen_dep:
                return
            seen_dep.add(addr)
            candidate_dep.append(addr)

        for event in vault_deposits:
            _consider_dep(event["owner"])
        for event in vault_transfers:
            _consider_dep(event["from"])
            _consider_dep(event["to"])
        if candidate_dep:
            dep_types, _dep_incentives = classify_addresses(candidate_dep, rpc, mc)
            for owner in candidate_dep:
                depositors[owner] = _new_depositor_entry(dep_types.get(owner, "unknown"))

        matched_dep_withdraws = 0
        matched_dep_deposits = 0
        matched_dep_transfers = 0
        for event in vault_withdraws:
            depositor = depositors.get(event["owner"])
            if not isinstance(depositor, dict):
                continue
            _append_flow(
                depositor,
                "withdrawals",
                "total_withdrawals",
                event,
                vault_shares_to_assets(int(event["shares"])),
                extra={"vault_assets": str(event["assets"])},
            )
            matched_dep_withdraws += 1
        for event in vault_deposits:
            depositor = depositors.get(event["owner"])
            if not isinstance(depositor, dict):
                continue
            _append_flow(
                depositor,
                "deposits",
                "total_deposits",
                event,
                vault_shares_to_assets(int(event["shares"])),
                extra={"vault_assets": str(event["assets"])},
            )
            matched_dep_deposits += 1
        for event in vault_transfers:
            assets = vault_shares_to_assets(event["value"])
            for addr, direction in ((event["to"], "in"), (event["from"], "out")):
                depositor = depositors.get(addr)
                if not isinstance(depositor, dict):
                    continue
                counterparty = event["from"] if direction == "in" else event["to"]
                _append_transfer(depositor, event, assets, direction, counterparty)
                matched_dep_transfers += 1

        for depositor in depositors.values():
            if not isinstance(depositor, dict):
                continue
            _finalize_pending(depositor, int(depositor.get("attributed_silo_assets", 0)))

        print(
            f"[info]   [{vault_label}] matched {matched_dep_deposits} deposit(s), "
            f"{matched_dep_withdraws} withdrawal(s), {matched_dep_transfers} transfer-side(s); "
            f"added {len(depositors) - len(existing_depositors)} new depositor(s)"
        )


def expand_vault(
    vault: str,
    vault_shares: int,
    vault_silo_assets: int,
    rpc: RpcClient,
    mc: Multicall,
) -> dict[str, Any]:
    """Build the vaults[vault] entry, including depositor attribution."""
    # config(SILO).enabled -> in withdraw queue?
    cfg = mc.aggregate([(vault, call_config(SILO_ADDRESS))])
    # A clean revert (ok=False) is a valid signal: the silo is not configured in this
    # vault, i.e. not in the withdraw queue. But if the call succeeded we MUST be able to
    # decode it; a decode failure on returned data is an anomaly, not a "not in queue".
    in_withdraw_queue = False
    if cfg[0][0]:
        _cap, in_withdraw_queue, _removable = dec_config(cfg[0][1])

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
    if not ts_res[0][0]:
        raise RuntimeError(f"totalSupply reverted for vault {vault} at block {BLOCK}")
    vault_total_supply = dec_uint(ts_res[0][1])
    entry["vault_total_supply"] = str(vault_total_supply)

    bal_calls = [(vault, call_balance_of(d)) for d in depositor_addrs]
    bal_res = mc.aggregate(bal_calls)
    balances: dict[str, int] = {}
    for idx, d in enumerate(depositor_addrs):
        ok, data = bal_res[idx]
        if not ok:
            raise RuntimeError(f"balanceOf reverted for depositor {d} on vault {vault} at block {BLOCK}")
        balances[d] = dec_uint(data)

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


def build_snapshot(
    rpc_url: str,
    withdrawals_block_chunk: int,
    withdrawals_to_block: int | None = None,
    latest_block: int | None = None,
) -> dict[str, Any]:
    rpc = RpcClient(rpc_url, BLOCK)
    mc = Multicall(rpc, MULTICALL3, MULTICALL_BATCH)

    is_vault_target = SILO_TYPE == SILO_TYPE_VAULT

    if is_vault_target:
        print(f"[info] fetching vault depositors for silo_vault {SILO_ADDRESS} at block {BLOCK} ...")
        accounts = fetch_vault_depositors(SILO_ADDRESS)
        print(f"[info] {len(accounts)} unique vault depositor accounts")
        print("[info] fetching vault metadata + total supplies ...")
        meta = fetch_vault_metadata(rpc, mc)
    else:
        print(f"[info] fetching lenders for silo {SILO_ADDRESS} at block {BLOCK} ...")
        accounts = fetch_lenders(SILO_ADDRESS)
        print(f"[info] {len(accounts)} unique collateral lender accounts")
        print("[info] fetching silo metadata + total supplies ...")
        meta = fetch_silo_metadata(rpc, mc)

    print("[info] classifying lender addresses ...")
    types, _incentives = classify_addresses(accounts, rpc, mc)

    print("[info] reading direct lender share balances ...")
    shares_by_addr = fetch_direct_lender_shares(accounts, mc)

    ordered = accounts
    shares = [shares_by_addr[a] for a in ordered]
    if is_vault_target:
        print("[info] computing ERC4626 previewRedeem assets for vault depositors ...")
        assets = preview_redeem_vault_shares(shares, mc)
    else:
        print("[info] computing previewRedeem assets for direct lenders ...")
        assets = preview_redeem_collateral(shares, mc)

    direct_lenders: dict[str, Any] = {}
    for addr, collateral_shares, assets_collateral in zip(ordered, shares, assets):
        direct_lenders[addr] = {
            "address_type": types.get(addr, "unknown"),
            "collateral_shares": str(collateral_shares),
            "assets_collateral": str(assets_collateral),
            "total_assets": str(assets_collateral),
        }

    vaults: dict[str, Any] = {}
    if is_vault_target:
        # Depositors of a standalone vault are treated as the leaf lenders directly; we do
        # not recurse into vault-of-vault positions here.
        print("[info] vault target: skipping nested SiloVault expansion")
    else:
        vault_addrs = [a for a in accounts if types.get(a) == "silo_vault"]
        assets_by_addr = dict(zip(ordered, assets))
        print(f"[info] expanding {len(vault_addrs)} SiloVault(s) ...")
        for vault in vault_addrs:
            vault_shares = shares_by_addr[vault]
            vault_assets = assets_by_addr[vault]
            print(f"[info]   vault {vault} ...")
            vaults[vault] = expand_vault(vault, vault_shares, vault_assets, rpc, mc)

    silo_entry: dict[str, Any] = {
        "snapshot_block": BLOCK,
        "silo_type": SILO_TYPE,
        "silo_id": meta["silo_id"],
        "input_token": meta["input_token"],
        "total_assets": str(meta["total_assets"]) if meta["total_assets"] is not None else None,
        "collateral_total_supply": str(meta["collateral_total_supply"]),
        # Two-sided market marker: the paired silo whose Borrow/Repay events were folded in
        # (None for ordinary one-sided silos). Lets the UI flag lender/borrower silos.
        "borrow_repay_silo": BORROW_REPAY_SILO or None,
        "direct_lenders": direct_lenders,
        "vaults": vaults,
    }
    latest = latest_block if latest_block is not None else rpc.eth_block_number()
    scan_to = latest if withdrawals_to_block is None else min(withdrawals_to_block, latest)
    scan_from = BLOCK + 1
    target_label = "latest" if withdrawals_to_block is None else str(withdrawals_to_block)
    print(
        f"[info] withdrawals target for silo {SILO_ADDRESS}: requested={target_label}, "
        f"resolved_to={scan_to}, chunk={withdrawals_block_chunk}"
    )
    if scan_to >= scan_from:
        print(f"[info] fetching Deposit + Withdraw events from blocks {scan_from}..{scan_to} ...")
        enrich_snapshot_with_flows(silo_entry, rpc, mc, scan_from, scan_to, withdrawals_block_chunk)
    else:
        print(f"[info] skipping flow scan: target block {scan_to} is before {scan_from}")
        enrich_snapshot_with_flows(silo_entry, rpc, mc, scan_from, scan_from - 1, withdrawals_block_chunk)
    silo_entry["withdrawals_scanned_to_block"] = scan_to
    return silo_entry


# --------------------------------------------------------------------------------------
# Output (incremental, per-chain)
# --------------------------------------------------------------------------------------
# The RPC endpoint is load-balanced and eth_getLogs can silently return an INCOMPLETE set
# of logs for a block range (different backends answer identical queries with different
# result counts). A plain overwrite would let an unlucky run replace a more complete result
# with a smaller one. To guarantee we never lose data, each write UNIONS the freshly fetched
# flow events with whatever is already on disk (dedup by tx_hash+log_index[+direction]) and
# recomputes the derived totals. Runs are therefore append-only per event: repeating the run
# can only ever grow the recorded set. To start clean, delete the output JSON file.
def _event_dedup_key(list_key: str, row: dict[str, Any]) -> tuple[Any, ...]:
    # A single Transfer log credits one side ('in') and debits the other ('out'); for one
    # account the same log can legitimately appear under both directions, so direction is
    # part of the identity. Deposit/Withdraw are one row per (tx, logIndex).
    if list_key == "transfers":
        return (row.get("tx_hash"), row.get("log_index"), row.get("direction"))
    return (row.get("tx_hash"), row.get("log_index"))


def _merge_event_list(
    old_rows: Any, new_rows: Any, list_key: str
) -> list[dict[str, Any]]:
    merged: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in list(old_rows or []) + list(new_rows or []):
        if isinstance(row, dict):
            # Later writes win on collision; identical events carry identical payloads.
            merged[_event_dedup_key(list_key, row)] = row
    out = list(merged.values())
    out.sort(key=lambda r: (r.get("block_number", 0), r.get("log_index", 0), str(r.get("tx_hash", ""))))
    return out


def _entry_base_assets(entry: dict[str, Any]) -> int:
    # Direct lenders reconcile against collateral assets; vault depositors against the
    # assets attributed to them at the snapshot block.
    if "assets_collateral" in entry:
        return int(entry.get("assets_collateral") or 0)
    if "attributed_silo_assets" in entry:
        return int(entry.get("attributed_silo_assets") or 0)
    return 0


def _recompute_flow_totals(entry: dict[str, Any]) -> None:
    withdrawals = entry.get("withdrawals") or []
    deposits = entry.get("deposits") or []
    transfers = entry.get("transfers") or []
    borrows = entry.get("borrows") or []
    repays = entry.get("repays") or []
    total_w = sum(int(r.get("assets", 0)) for r in withdrawals if isinstance(r, dict))
    total_d = sum(int(r.get("assets", 0)) for r in deposits if isinstance(r, dict))
    total_in = sum(int(r.get("assets", 0)) for r in transfers if isinstance(r, dict) and r.get("direction") == "in")
    total_out = sum(int(r.get("assets", 0)) for r in transfers if isinstance(r, dict) and r.get("direction") == "out")
    total_b = sum(int(r.get("assets", 0)) for r in borrows if isinstance(r, dict))
    total_r = sum(int(r.get("assets", 0)) for r in repays if isinstance(r, dict))
    entry["total_withdrawals"] = str(total_w)
    entry["total_deposits"] = str(total_d)
    entry["total_transfers_in"] = str(total_in)
    entry["total_transfers_out"] = str(total_out)
    if borrows or "total_borrows" in entry:
        entry["total_borrows"] = str(total_b)
    if repays or "total_repays" in entry:
        entry["total_repays"] = str(total_r)
    base = _entry_base_assets(entry)
    debt_at_snapshot = int(entry.get("debt_at_snapshot", 0))
    # Same signed reconciliation as _finalize_pending (NOT clamped to zero).
    entry["pending_assets"] = str(base - debt_at_snapshot + total_d + total_in + total_r - total_w - total_out - total_b)


def _merge_flow_entry(old_entry: Any, new_entry: Any) -> Any:
    """Union the flow lists of two entries for the same account and recompute totals.

    Base fields (address_type, balances, previewRedeem assets) are deterministic reads at the
    snapshot block, so the fresh run's values are kept; only the volatile event lists merge.
    """
    if not isinstance(old_entry, dict):
        return new_entry
    if not isinstance(new_entry, dict):
        return old_entry
    flow_lists = ("withdrawals", "deposits", "transfers", "borrows", "repays")
    has_flows = any(k in old_entry for k in flow_lists) or any(k in new_entry for k in flow_lists)
    if not has_flows:
        # e.g. a silo_vault direct-lender entry: flow fields are intentionally absent.
        return new_entry
    merged = dict(new_entry)
    for list_key in flow_lists:
        old_list = old_entry.get(list_key)
        new_list = new_entry.get(list_key)
        # borrows/repays exist only for two-sided markets; skip if neither side has them so we
        # do not materialize empty lists on one-sided silos.
        if old_list is None and new_list is None:
            continue
        merged[list_key] = _merge_event_list(old_list, new_list, list_key)
    _recompute_flow_totals(merged)
    return merged


def _merge_entry_map(old_map: Any, new_map: Any) -> dict[str, Any]:
    """Merge two {address: entry} maps, never dropping an address present in either."""
    if not isinstance(new_map, dict):
        return old_map if isinstance(old_map, dict) else {}
    if not isinstance(old_map, dict):
        return new_map
    out = dict(new_map)
    for addr, old_entry in old_map.items():
        if addr in out:
            out[addr] = _merge_flow_entry(old_entry, out[addr])
        else:
            # Present only in the prior file (e.g. a post-snapshot lender whose events did
            # not come back this run): keep it verbatim so we never lose it.
            out[addr] = old_entry
    return out


def _merge_vaults(old_vaults: Any, new_vaults: Any) -> dict[str, Any]:
    if not isinstance(new_vaults, dict):
        return old_vaults if isinstance(old_vaults, dict) else {}
    if not isinstance(old_vaults, dict):
        return new_vaults
    out = dict(new_vaults)
    for vault_addr, old_v in old_vaults.items():
        new_v = out.get(vault_addr)
        if not isinstance(new_v, dict) or not isinstance(old_v, dict):
            if vault_addr not in out:
                out[vault_addr] = old_v
            continue
        merged_v = dict(new_v)
        merged_v["depositors"] = _merge_entry_map(old_v.get("depositors"), new_v.get("depositors"))
        out[vault_addr] = merged_v
    return out


def _merge_silo_entry(old_silo: Any, new_silo: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(old_silo, dict):
        return new_silo
    merged = dict(new_silo)
    # Scalar metadata are deterministic snapshot-block reads; prefer the fresh value but fall
    # back to the prior one if this run failed to resolve it (None/empty).
    for key in ("silo_id", "input_token", "total_assets", "collateral_total_supply", "borrow_repay_silo", "borrow_repay_token"):
        if merged.get(key) in (None, "") and old_silo.get(key) not in (None, ""):
            merged[key] = old_silo[key]
    old_scan = old_silo.get("withdrawals_scanned_to_block")
    new_scan = merged.get("withdrawals_scanned_to_block")
    if isinstance(old_scan, int) and isinstance(new_scan, int):
        merged["withdrawals_scanned_to_block"] = max(old_scan, new_scan)
    elif isinstance(old_scan, int) and not isinstance(new_scan, int):
        merged["withdrawals_scanned_to_block"] = old_scan
    merged["direct_lenders"] = _merge_entry_map(old_silo.get("direct_lenders"), new_silo.get("direct_lenders"))
    merged["vaults"] = _merge_vaults(old_silo.get("vaults"), new_silo.get("vaults"))
    return merged


def write_output(
    silo_entry: dict[str, Any], chain: str, chain_id: int, silo_address: str, output_path: Path
) -> None:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    root: dict[str, Any] = {}
    if path.exists():
        # Silently resetting a corrupt/unexpected output file would wipe previously written
        # chains/silos. Fail loudly instead so no prior result is lost unnoticed.
        try:
            root = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Existing output {path} is not valid JSON; refusing to overwrite: {exc}") from exc
        if not isinstance(root, dict):
            raise RuntimeError(f"Existing output {path} is not a JSON object; refusing to overwrite.")

    chain_obj = root.get(chain)
    if not isinstance(chain_obj, dict):
        chain_obj = {}
    chain_obj["chain_id"] = chain_id
    silos = chain_obj.get("silos")
    if not isinstance(silos, dict):
        silos = {}
    key = norm(silo_address)
    # Merge (union) with any previously written result for this silo so a run that fetched
    # fewer logs (incomplete RPC response) can never shrink the recorded data.
    silos[key] = _merge_silo_entry(silos.get(key), silo_entry)
    chain_obj["silos"] = silos
    root[chain] = chain_obj

    path.write_text(json.dumps(root, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[ok] wrote {path}")


def run_category(slug: str, category: dict[str, Any]) -> int:
    """Scan every silo configured for one category and write `data/<slug>.json`.

    Returns the number of silos completed for this category.
    """
    import time

    targets = category.get("targets") or []
    output_path = category_output_path(slug, category)
    total_silos = sum(len(target.get("silos") or []) for target in targets)
    print(
        f"[info] ##### category '{slug}': {total_silos} silo(s) across {len(targets)} chain(s) "
        f"-> {output_path} #####"
    )
    completed = 0
    silo_index = 0
    started_at = time.monotonic()
    for target in targets:
        silos = target.get("silos") or []
        if not silos:
            print(f"[skip] category={slug} chain={target['chain']} has no configured silos")
            continue
        rpc_url = resolve_rpc_url(str(target["chain"]))
        # Both the eth_getLogs chunk and the chain head are per-chain: resolve them
        # once so every silo on this chain shares them (one eth_blockNumber call).
        chain_block_chunk = resolve_block_chunk(target)
        chain_events_to_block = resolve_events_to_block(target)
        chain_latest_block = RpcClient(rpc_url, 0).eth_block_number()
        print(
            f"[info] chain={target['chain']} latest block={chain_latest_block} "
            f"events_to_block={chain_events_to_block} block_chunk={chain_block_chunk} "
            f"(shared across silos)"
        )
        for silo in silos:
            silo_index += 1
            configure_context(target, silo)
            print(
                f"[info] ===== [{slug}] silo {silo_index}/{total_silos}: chain={CHAIN} "
                f"silo={SILO_ADDRESS} block={BLOCK} ====="
            )
            silo_started_at = time.monotonic()
            withdrawals_to_block = chain_events_to_block
            withdrawals_block_chunk = chain_block_chunk
            silo_entry = build_snapshot(
                rpc_url,
                withdrawals_to_block=withdrawals_to_block,
                withdrawals_block_chunk=withdrawals_block_chunk,
                latest_block=chain_latest_block,
            )
            write_output(silo_entry, CHAIN, CHAIN_ID, SILO_ADDRESS, output_path)
            direct = len(silo_entry["direct_lenders"])
            vaults = len(silo_entry["vaults"])
            elapsed = time.monotonic() - silo_started_at
            print(
                f"[done] [{slug}] silo {silo_index}/{total_silos} chain={CHAIN} silo={SILO_ADDRESS} "
                f"direct_lenders={direct} vaults={vaults} elapsed={elapsed:.1f}s"
            )
            completed += 1
    if completed == 0:
        print(f"[done] category '{slug}': no silos configured")
    else:
        total_elapsed = time.monotonic() - started_at
        print(f"[done] category '{slug}': {completed}/{total_silos} silo(s) completed in {total_elapsed:.1f}s")
    return completed


def main() -> int:
    load_secrets()

    # Positional args select which categories to scan. At least one slug is REQUIRED:
    # scanning is deliberate and per-category, so we never scan everything implicitly.
    # This is the "new silo list -> new file" workflow: `./run.sh snapshot_lenders.py <slug>`.
    available = ", ".join(sorted(CATEGORIES)) or "(none)"
    requested = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if not requested:
        raise SystemExit(f"No category slug provided. Specify at least one of: {available}")
    unknown = [slug for slug in requested if slug not in CATEGORIES]
    if unknown:
        raise SystemExit(f"Unknown category slug(s): {', '.join(unknown)}. Available: {available}")
    selected = requested

    print(f"[info] scanning {len(selected)} categor(y/ies): {', '.join(selected)}")
    total_completed = 0
    for slug in selected:
        total_completed += run_category(slug, CATEGORIES[slug])

    if total_completed == 0:
        print("[done] no silos configured")
    else:
        print(f"[done] all categories complete: {total_completed} silo(s) total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
