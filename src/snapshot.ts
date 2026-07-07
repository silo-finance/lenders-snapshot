type RawAmount = string | number | null | undefined;

type RawInputToken = {
  address?: string | null;
  decimals?: number | string | null;
  symbol?: string | null;
};

type RawDirectLender = {
  address_type?: string;
  collateral_shares?: RawAmount;
  assets_collateral?: RawAmount;
  total_assets?: RawAmount;
  total_withdrawals?: RawAmount;
  total_deposits?: RawAmount;
  total_transfers_in?: RawAmount;
  total_transfers_out?: RawAmount;
  pending_assets?: RawAmount;
  withdrawals?: RawWithdrawalEntry[];
  deposits?: RawWithdrawalEntry[];
  transfers?: RawTransferEntry[];
};

type RawDepositor = {
  address_type?: string;
  vault_shares?: RawAmount;
  fraction?: string;
  attributed_silo_assets?: RawAmount;
  total_withdrawals?: RawAmount;
  total_deposits?: RawAmount;
  total_transfers_in?: RawAmount;
  total_transfers_out?: RawAmount;
  pending_assets?: RawAmount;
  withdrawals?: RawWithdrawalEntry[];
  deposits?: RawWithdrawalEntry[];
  transfers?: RawTransferEntry[];
};

type RawWithdrawalEntry = {
  block_number?: number | string;
  tx_hash?: string;
  log_index?: number | string;
  assets?: RawAmount;
  shares?: RawAmount;
  // Vault depositors only: raw vault underlying withdrawn on-chain (full redemption
  // across all silos). `assets` is the snapshot-rate slice attributed to this silo
  // and is what actually reduces `pending_assets`.
  vault_assets?: RawAmount;
};

type RawTransferEntry = RawWithdrawalEntry & {
  // Peer-to-peer share transfer: "in" credits the account, "out" debits it.
  direction?: string;
  counterparty?: string;
};

type RawVault = {
  name?: string | null;
  indexed_in_subgraph?: boolean;
  in_withdraw_queue?: boolean;
  status?: string;
  vault_silo_assets?: RawAmount;
  vault_total_supply?: RawAmount;
  depositors?: Record<string, RawDepositor>;
};

type RawSilo = {
  snapshot_block?: number | string;
  withdrawals_scanned_to_block?: number | string;
  silo_type?: string | null;
  silo_id?: string | number | null;
  input_token?: RawInputToken;
  total_assets?: RawAmount;
  collateral_total_supply?: RawAmount;
  direct_lenders?: Record<string, RawDirectLender>;
  vaults?: Record<string, RawVault>;
};

type RawChain = {
  chain_id?: number;
  silos?: Record<string, RawSilo>;
};

export type RawRoot = Record<string, RawChain>;

export type InputToken = {
  address: string | null;
  decimals: number;
  symbol: string;
};

export type DirectLender = {
  address: string;
  addressType: string;
  collateralShares: bigint;
  totalShares: bigint;
  assetsCollateral: bigint;
  totalAssets: bigint;
  totalWithdrawals: bigint;
  totalDeposits: bigint;
  totalTransfersIn: bigint;
  totalTransfersOut: bigint;
  pendingAssets: bigint;
  withdrawals: WithdrawalEntry[];
  deposits: WithdrawalEntry[];
  transfers: TransferEntry[];
  isVault: boolean;
};

export type VaultDepositor = {
  address: string;
  addressType: string;
  vaultShares: bigint;
  fraction: string;
  attributedSiloAssets: bigint;
  totalWithdrawals: bigint;
  totalDeposits: bigint;
  totalTransfersIn: bigint;
  totalTransfersOut: bigint;
  pendingAssets: bigint;
  withdrawals: WithdrawalEntry[];
  deposits: WithdrawalEntry[];
  transfers: TransferEntry[];
};

export type WithdrawalEntry = {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  assets: bigint;
  shares: bigint;
  // Raw on-chain withdrawn amount. Equals `assets` for direct lenders; for vault
  // depositors it is the full vault redemption (across all silos), while `assets`
  // is the slice attributed to this silo.
  eventAssets: bigint;
};

export type TransferDirection = "in" | "out";

export type TransferEntry = WithdrawalEntry & {
  // Peer-to-peer share transfer: "in" increases the balance, "out" decreases it.
  direction: TransferDirection;
  counterparty: string;
};

export type VaultSnapshot = {
  address: string;
  name: string | null;
  indexedInSubgraph: boolean;
  inWithdrawQueue: boolean;
  status: string;
  vaultSiloAssets: bigint;
  vaultTotalSupply: bigint | null;
  depositors: VaultDepositor[];
};

export type SiloKind = "silo" | "silo_vault";

export type SiloSnapshot = {
  address: string;
  snapshotBlock: number;
  siloType: SiloKind;
  siloId: string | null;
  inputToken: InputToken;
  collateralTotalSupply: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  directLenders: DirectLender[];
  vaults: VaultSnapshot[];
};

export type ChainSnapshot = {
  chain: string;
  label: string;
  chainId: number;
  silos: SiloSnapshot[];
};

const KNOWN_CHAINS: Record<string, { label: string; chainId: number; explorer: string }> = {
  sonic: { label: "Sonic", chainId: 146, explorer: "https://sonicscan.org/address/" },
  ethereum: { label: "Ethereum", chainId: 1, explorer: "https://etherscan.io/address/" },
};

const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  "0x29219dd400f2bf60e5a23d13be72b486d4038894": "USDC",
};

const ZERO = 0n;

function displayAddressType(addressType: string | undefined): string {
  if (addressType === "gnosis_safe") {
    return "Gnosis Safe";
  }
  return addressType ?? "unknown";
}

function toBigInt(value: RawAmount): bigint {
  if (value === null || value === undefined || value === "") {
    return ZERO;
  }
  return BigInt(value);
}

function toNumber(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function prettifyChain(chain: string): string {
  return KNOWN_CHAINS[chain]?.label ?? chain.replace(/(^|[-_])(\w)/g, (_, prefix: string, letter: string) => {
    return `${prefix ? " " : ""}${letter.toUpperCase()}`;
  });
}

function parseSilo(address: string, raw: RawSilo): SiloSnapshot {
  const inputToken: InputToken = {
    address: raw.input_token?.address ?? null,
    decimals: toNumber(raw.input_token?.decimals, 18),
    symbol:
      raw.input_token?.symbol ||
      (raw.input_token?.address ? KNOWN_TOKEN_SYMBOLS[raw.input_token.address.toLowerCase()] : undefined) ||
      "Asset",
  };

  const parseFlows = (entries: RawWithdrawalEntry[] | undefined): WithdrawalEntry[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map((entry) => {
        const assets = toBigInt(entry.assets);
        const shares = toBigInt(entry.shares);
        const rawEventAssets = entry.vault_assets;
        const eventAssets =
          rawEventAssets === undefined || rawEventAssets === null || rawEventAssets === ""
            ? assets
            : toBigInt(rawEventAssets);
        return {
          blockNumber: toNumber(entry.block_number, 0),
          txHash: (entry.tx_hash ?? "").toLowerCase(),
          logIndex: toNumber(entry.log_index, 0),
          assets,
          shares,
          eventAssets,
        };
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash));
  };

  const parseTransfers = (entries: RawTransferEntry[] | undefined): TransferEntry[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .map((entry) => {
        const assets = toBigInt(entry.assets);
        return {
          blockNumber: toNumber(entry.block_number, 0),
          txHash: (entry.tx_hash ?? "").toLowerCase(),
          logIndex: toNumber(entry.log_index, 0),
          assets,
          shares: toBigInt(entry.shares),
          eventAssets: assets,
          direction: (entry.direction === "out" ? "out" : "in") as TransferDirection,
          counterparty: (entry.counterparty ?? "").toLowerCase(),
        };
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash));
  };

  const directLenders = Object.entries(raw.direct_lenders ?? {}).map(([lenderAddress, entry]) => {
    const collateralShares = toBigInt(entry.collateral_shares);
    const assetsCollateral = toBigInt(entry.assets_collateral);
    const totalAssets = toBigInt(entry.total_assets) || assetsCollateral;
    const totalWithdrawals = toBigInt(entry.total_withdrawals);
    const totalDeposits = toBigInt(entry.total_deposits);
    const totalTransfersIn = toBigInt(entry.total_transfers_in);
    const totalTransfersOut = toBigInt(entry.total_transfers_out);
    const pendingAssets =
      entry.pending_assets === undefined || entry.pending_assets === null || entry.pending_assets === ""
        ? totalAssets
        : toBigInt(entry.pending_assets);
    return {
      address: lenderAddress,
      addressType: displayAddressType(entry.address_type),
      collateralShares,
      totalShares: collateralShares,
      assetsCollateral,
      totalAssets,
      totalWithdrawals,
      totalDeposits,
      totalTransfersIn,
      totalTransfersOut,
      pendingAssets,
      withdrawals: parseFlows(entry.withdrawals),
      deposits: parseFlows(entry.deposits),
      transfers: parseTransfers(entry.transfers),
      isVault: entry.address_type === "silo_vault",
    };
  });

  const vaults = Object.entries(raw.vaults ?? {}).map(([vaultAddress, entry]) => ({
    address: vaultAddress,
    name: entry.name ?? null,
    indexedInSubgraph: Boolean(entry.indexed_in_subgraph),
    inWithdrawQueue: Boolean(entry.in_withdraw_queue),
    status: entry.status ?? "unknown",
    vaultSiloAssets: toBigInt(entry.vault_silo_assets),
    vaultTotalSupply:
      entry.vault_total_supply === null || entry.vault_total_supply === undefined
        ? null
        : toBigInt(entry.vault_total_supply),
    depositors: Object.entries(entry.depositors ?? {}).map(([depositorAddress, depositor]) => {
      const attributedSiloAssets = toBigInt(depositor.attributed_silo_assets);
      return {
        address: depositorAddress,
        addressType: displayAddressType(depositor.address_type),
        vaultShares: toBigInt(depositor.vault_shares),
        fraction: depositor.fraction ?? "0",
        attributedSiloAssets,
        totalWithdrawals: toBigInt(depositor.total_withdrawals),
        totalDeposits: toBigInt(depositor.total_deposits),
        totalTransfersIn: toBigInt(depositor.total_transfers_in),
        totalTransfersOut: toBigInt(depositor.total_transfers_out),
        pendingAssets:
          depositor.pending_assets === undefined || depositor.pending_assets === null || depositor.pending_assets === ""
            ? attributedSiloAssets
            : toBigInt(depositor.pending_assets),
        withdrawals: parseFlows(depositor.withdrawals),
        deposits: parseFlows(depositor.deposits),
        transfers: parseTransfers(depositor.transfers),
      };
    }),
  }));

  const totalAssets = toBigInt(raw.total_assets) || directLenders.reduce((sum, lender) => sum + lender.totalAssets, ZERO);
  const collateralTotalSupply = toBigInt(raw.collateral_total_supply);

  return {
    address,
    snapshotBlock: toNumber(raw.snapshot_block, 0),
    siloType: raw.silo_type === "silo_vault" ? "silo_vault" : "silo",
    siloId: raw.silo_id === null || raw.silo_id === undefined ? null : String(raw.silo_id),
    inputToken,
    collateralTotalSupply,
    totalShares: collateralTotalSupply,
    totalAssets,
    directLenders: directLenders.sort((a, b) => compareBigIntDesc(a.totalAssets, b.totalAssets)),
    vaults: vaults.sort((a, b) => compareBigIntDesc(a.vaultSiloAssets, b.vaultSiloAssets)),
  };
}

export function parseSnapshot(root: RawRoot): ChainSnapshot[] {
  const chainNames = Object.keys(root).sort((a, b) => {
    const knownOrder = Object.keys(KNOWN_CHAINS);
    const aIndex = knownOrder.indexOf(a);
    const bIndex = knownOrder.indexOf(b);
    if (aIndex !== -1 || bIndex !== -1) {
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    }
    return a.localeCompare(b);
  });

  return chainNames.map((chain) => {
    const rawChain = root[chain];
    const chainId = rawChain?.chain_id ?? KNOWN_CHAINS[chain]?.chainId ?? 0;
    const silos = Object.entries(rawChain?.silos ?? {}).map(([address, rawSilo]) => parseSilo(address, rawSilo));
    return {
      chain,
      label: prettifyChain(chain),
      chainId,
      silos,
    };
  });
}

// Every silo in a snapshot is captured at the same block, so the first non-zero
// value represents the snapshot block (the "from" / state block) used across the UI.
function computeSnapshotBlock(chains: ChainSnapshot[]): number {
  for (const chain of chains) {
    for (const silo of chain.silos) {
      if (silo.snapshotBlock > 0) {
        return silo.snapshotBlock;
      }
    }
  }
  return 0;
}

function maxFlowEventBlock(chains: ChainSnapshot[]): number {
  let max = 0;
  const consider = (entries: { blockNumber: number }[]) => {
    for (const entry of entries) {
      if (entry.blockNumber > max) {
        max = entry.blockNumber;
      }
    }
  };
  for (const chain of chains) {
    for (const silo of chain.silos) {
      for (const lender of silo.directLenders) {
        consider(lender.withdrawals);
        consider(lender.deposits);
        consider(lender.transfers);
      }
      for (const vault of silo.vaults) {
        for (const depositor of vault.depositors) {
          consider(depositor.withdrawals);
          consider(depositor.deposits);
          consider(depositor.transfers);
        }
      }
    }
  }
  return max;
}

// Highest block up to which post-snapshot events were scanned across a snapshot.
// This is a single value (not per-silo): prefer the maximum
// `withdrawals_scanned_to_block` from the raw JSON, and fall back to the max event
// block for backward compatibility with older snapshots that lack that field.
function computeEventsToBlock(root: RawRoot, chains: ChainSnapshot[]): number {
  let max = 0;
  for (const rawChain of Object.values(root)) {
    for (const rawSilo of Object.values(rawChain?.silos ?? {})) {
      const scannedTo = toNumber(rawSilo.withdrawals_scanned_to_block, 0);
      if (scannedTo > max) {
        max = scannedTo;
      }
    }
  }
  return max > 0 ? max : maxFlowEventBlock(chains);
}

// Parsed, ready-to-render data for a single snapshot category. Built once per category
// (see src/categories.ts) from that category's raw JSON.
export type CategoryData = {
  chains: ChainSnapshot[];
  snapshotBlock: number;
  eventsToBlock: number;
};

export function buildCategoryData(root: RawRoot): CategoryData {
  const chains = parseSnapshot(root);
  return {
    chains,
    snapshotBlock: computeSnapshotBlock(chains),
    eventsToBlock: computeEventsToBlock(root, chains),
  };
}

export type SiloCategory = "usdc" | "eth";

export const SILO_CATEGORY_ORDER: SiloCategory[] = ["usdc", "eth"];

export const SILO_CATEGORY_LABELS: Record<SiloCategory, string> = {
  usdc: "USDC",
  eth: "ETH",
};

/**
 * Bucket a silo by its input token. Any USD-denominated token (USDC, scUSD, ...)
 * is treated as the "USDC" group; everything else (WETH, scETH, ...) is "IF" (ETH).
 * Centralized here so the heuristic is easy to adjust.
 */
export function siloCategory(silo: SiloSnapshot): SiloCategory {
  return silo.inputToken.symbol.toUpperCase().includes("USD") ? "usdc" : "eth";
}

export function findSiloByAddress(
  chains: ChainSnapshot[],
  address: string,
  chainName?: string,
): { chain: ChainSnapshot; silo: SiloSnapshot } | null {
  const normalized = address.toLowerCase();
  const chainsToSearch = chainName
    ? chains.filter((chain) => chain.chain.toLowerCase() === chainName.toLowerCase())
    : chains;

  for (const chain of chainsToSearch) {
    const silo = chain.silos.find((entry) => entry.address.toLowerCase() === normalized);
    if (silo) {
      return { chain, silo };
    }
  }
  return null;
}

export function compareBigIntDesc(a: bigint, b: bigint): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

export function compareBigIntAsc(a: bigint, b: bigint): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function explorerAddressUrl(chain: string, address: string): string {
  const explorer = KNOWN_CHAINS[chain]?.explorer;
  return explorer ? `${explorer}${address}` : "#";
}

export function explorerTxUrl(chain: string, txHash: string): string {
  const explorer = KNOWN_CHAINS[chain]?.explorer;
  if (!explorer) {
    return "#";
  }
  const txBase = explorer.includes("/address/") ? explorer.replace("/address/", "/tx/") : explorer;
  return `${txBase}${txHash}`;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatUnits(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  const wholeFormatted = new Intl.NumberFormat("en-US").format(Number(whole));

  if (fraction === ZERO || maxFractionDigits === 0) {
    return `${negative ? "-" : ""}${wholeFormatted}`;
  }

  const fractionPadded = fraction.toString().padStart(decimals, "0").slice(0, maxFractionDigits);
  const fractionTrimmed = fractionPadded.replace(/0+$/, "");
  return `${negative ? "-" : ""}${wholeFormatted}${fractionTrimmed ? `.${fractionTrimmed}` : ""}`;
}

export function formatUnitsRounded(value: bigint, decimals: number, fractionDigits: number): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const displayScale = 10n ** BigInt(fractionDigits);
  let rounded = (absolute * displayScale) / scale;
  const remainder = (absolute * displayScale) % scale;

  if (remainder * 2n >= scale) {
    rounded += 1n;
  }

  const whole = rounded / displayScale;
  const fraction = rounded % displayScale;
  const wholeFormatted = new Intl.NumberFormat("en-US").format(Number(whole));

  if (fractionDigits === 0) {
    return `${negative ? "-" : ""}${wholeFormatted}`;
  }

  return `${negative ? "-" : ""}${wholeFormatted}.${fraction.toString().padStart(fractionDigits, "0")}`;
}

export function formatUnitsPlain(value: bigint, decimals: number): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;

  if (fraction === ZERO) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  const fractionPadded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fractionPadded}`;
}

export function formatUnitsFixed(value: bigint, decimals: number): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;

  if (decimals === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  return `${negative ? "-" : ""}${whole.toString()}.${fraction.toString().padStart(decimals, "0")}`;
}

export function parseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    return null;
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    return null;
  }

  const wholeRaw = BigInt(whole) * 10n ** BigInt(decimals);
  const fractionRaw = fraction ? BigInt(fraction.padEnd(decimals, "0")) : ZERO;
  return wholeRaw + fractionRaw;
}

export function formatCompactUnits(value: bigint, decimals: number): string {
  const asNumber = Number(value) / 10 ** decimals;
  if (!Number.isFinite(asNumber)) {
    return formatUnits(value, decimals, 2);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(asNumber);
}

export function formatRawInteger(value: bigint): string {
  const raw = value.toString();
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

