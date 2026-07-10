/**
 * Supported chains, their display names, block explorers, and icon assets.
 * Ported from the `actions` project (`src/utils/networks.ts`) and adapted for
 * Vite: icon URLs are resolved against `import.meta.env.BASE_URL` so they work
 * when the app is deployed under a subpath (e.g. `/lenders-snapshot/`).
 */

export interface NetworkConfig {
  chainId: number;
  displayName: string;
  chainName: string;
  explorerBaseUrl: string;
  nativeTokenSymbol: string;
  iconPath: string;
}

export const NETWORK_CONFIGS: NetworkConfig[] = [
  {
    chainId: 1,
    displayName: "Ethereum",
    chainName: "mainnet",
    explorerBaseUrl: "https://etherscan.io",
    nativeTokenSymbol: "ETH",
    iconPath: "/network-icons/ethereum.svg",
  },
  {
    chainId: 10,
    displayName: "Optimism",
    chainName: "optimism",
    explorerBaseUrl: "https://optimistic.etherscan.io",
    nativeTokenSymbol: "ETH",
    iconPath: "/network-icons/optimism.svg",
  },
  {
    chainId: 50,
    displayName: "XDC Network",
    chainName: "xdc",
    explorerBaseUrl: "https://xdcscan.com",
    nativeTokenSymbol: "XDC",
    iconPath: "/network-icons/xdc.svg",
  },
  {
    chainId: 56,
    displayName: "BNB Chain",
    chainName: "bnb",
    explorerBaseUrl: "https://bscscan.com",
    nativeTokenSymbol: "BNB",
    iconPath: "/network-icons/bnb.svg",
  },
  {
    chainId: 146,
    displayName: "Sonic",
    chainName: "sonic",
    explorerBaseUrl: "https://sonicscan.org",
    nativeTokenSymbol: "S",
    iconPath: "/network-icons/sonic.webp",
  },
  {
    chainId: 196,
    displayName: "OKX",
    chainName: "okx",
    explorerBaseUrl: "https://www.okx.com/web3/explorer/xlayer",
    nativeTokenSymbol: "OKB",
    iconPath: "/network-icons/okx.png",
  },
  {
    chainId: 1776,
    displayName: "Injective",
    chainName: "injective",
    explorerBaseUrl: "https://blockscout.injective.network",
    nativeTokenSymbol: "INJ",
    iconPath: "/network-icons/injective.svg",
  },
  {
    chainId: 4326,
    displayName: "MegaETH",
    chainName: "megaeth",
    explorerBaseUrl: "https://mega.etherscan.io",
    nativeTokenSymbol: "ETH",
    iconPath: "/network-icons/megaeth.ico",
  },
  {
    chainId: 5000,
    displayName: "Mantle",
    chainName: "mantle",
    explorerBaseUrl: "https://mantlescan.xyz",
    nativeTokenSymbol: "MNT",
    iconPath: "/network-icons/mantle.ico",
  },
  {
    chainId: 42161,
    displayName: "Arbitrum One",
    chainName: "arbitrum_one",
    explorerBaseUrl: "https://arbiscan.io",
    nativeTokenSymbol: "ETH",
    iconPath: "/network-icons/arbitrum.svg",
  },
  {
    chainId: 43114,
    displayName: "Avalanche C-Chain",
    chainName: "avalanche",
    explorerBaseUrl: "https://snowtrace.io",
    nativeTokenSymbol: "AVAX",
    iconPath: "/network-icons/avalanche.svg",
  },
];

const NETWORK_CONFIG_MAP: Map<number, NetworkConfig> = new Map(
  NETWORK_CONFIGS.map((config) => [config.chainId, config]),
);

function toChainId(chainId: number | string): number {
  return typeof chainId === "string" ? parseInt(chainId, 10) : chainId;
}

// Resolve a `public/`-relative asset path against the Vite base URL so icons
// load correctly under a deployment subpath. `BASE_URL` always ends with "/".
function withBasePath(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${path.replace(/^\//, "")}`;
}

export function getNetworkConfig(chainId: number | string): NetworkConfig | undefined {
  return NETWORK_CONFIG_MAP.get(toChainId(chainId));
}

export function getNetworkName(chainId: number | string): string {
  const config = getNetworkConfig(chainId);
  return config ? config.displayName : `Network ${toChainId(chainId)}`;
}

export function getNetworkIconPath(chainId: number | string): string | null {
  const config = getNetworkConfig(chainId);
  return config?.iconPath ? withBasePath(config.iconPath) : null;
}

export function isChainSupported(chainId: number | string): boolean {
  return NETWORK_CONFIG_MAP.has(toChainId(chainId));
}

// Block-explorer URL for a specific block on the given chain, or null when the chain
// (or block) is unknown so callers can render plain text instead of a dead link.
export function getBlockExplorerUrl(chainId: number | string, block: number): string | null {
  const config = getNetworkConfig(chainId);
  if (!config || block <= 0) {
    return null;
  }
  return `${config.explorerBaseUrl}/block/${block}`;
}
