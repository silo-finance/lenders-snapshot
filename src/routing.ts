const SILO_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/i;
const CHAIN_NAME_PATTERN = /^[a-z0-9_-]+$/i;

export type SiloPathMatch = {
  address: string;
  chain?: string;
};

export function getAppBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function parseSiloPathFromUrl(): SiloPathMatch | null {
  const base = getAppBasePath();
  let pathname = window.location.pathname;

  if (base && pathname.startsWith(base)) {
    pathname = pathname.slice(base.length);
  }

  const segments = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  if (segments.length >= 2 && CHAIN_NAME_PATTERN.test(segments[0]) && SILO_ADDRESS_PATTERN.test(segments[1])) {
    return {
      chain: segments[0].toLowerCase(),
      address: segments[1],
    };
  }

  if (segments.length === 1 && SILO_ADDRESS_PATTERN.test(segments[0])) {
    return { address: segments[0] };
  }

  return null;
}

export function buildSiloPath(chain: string, address: string): string {
  const base = getAppBasePath();
  const segment = `${chain.toLowerCase()}/${address}`;
  return base ? `${base}/${segment}` : `/${segment}`;
}

export function explorerHomePath(): string {
  const base = getAppBasePath();
  return base ? `${base}/` : "/";
}

export type ExplorerSelection = {
  chain?: string;
  address?: string;
  filter?: string;
};

export function parseExplorerSelectionFromUrl(): ExplorerSelection {
  const params = new URLSearchParams(window.location.search);
  const chain = params.get("chain") ?? undefined;
  const address = params.get("silo") ?? undefined;
  const filter = params.get("filter")?.trim() || undefined;
  return {
    chain: chain && CHAIN_NAME_PATTERN.test(chain) ? chain.toLowerCase() : undefined,
    address: address && SILO_ADDRESS_PATTERN.test(address) ? address : undefined,
    filter,
  };
}

export function buildExplorerSelectionUrl(chain: string, address: string, filter?: string): string {
  const params = new URLSearchParams();
  params.set("chain", chain.toLowerCase());
  params.set("silo", address);
  const trimmedFilter = filter?.trim();
  if (trimmedFilter) {
    params.set("filter", trimmedFilter);
  }
  return `${explorerHomePath()}?${params.toString()}`;
}

export function parseFilterFromUrl(): string {
  return new URLSearchParams(window.location.search).get("filter")?.trim() || "";
}

export function buildSiloPathWithFilter(chain: string, address: string, filter?: string): string {
  const path = buildSiloPath(chain, address);
  const trimmedFilter = filter?.trim();
  if (!trimmedFilter) {
    return path;
  }
  const params = new URLSearchParams();
  params.set("filter", trimmedFilter);
  return `${path}?${params.toString()}`;
}
