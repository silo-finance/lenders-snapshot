const SILO_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/i;
const CHAIN_NAME_PATTERN = /^[a-z0-9_-]+$/i;
const CATEGORY_PATTERN = /^[a-z0-9_-]+$/i;

export type SiloPathMatch = {
  category: string;
  address: string;
  chain?: string;
};

export function getAppBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

// Path segments after the app base path, e.g. `/lenders-snapshot/stream/sonic/0x..`
// under base `/lenders-snapshot` yields ["stream", "sonic", "0x.."].
function pathSegments(): string[] {
  const base = getAppBasePath();
  let pathname = window.location.pathname;
  if (base && pathname.startsWith(base)) {
    pathname = pathname.slice(base.length);
  }
  return pathname.replace(/^\/+/, "").split("/").filter(Boolean);
}

// The first path segment is the snapshot category slug (e.g. "stream"), or null at
// the root (landing page). Validity against the known categories is checked by the caller.
export function parseCategoryFromUrl(): string | null {
  const segments = pathSegments();
  if (segments.length === 0) {
    return null;
  }
  return CATEGORY_PATTERN.test(segments[0]) ? segments[0].toLowerCase() : null;
}

// A silo-only subpage: `/<category>/<chain>/<address>` (or `/<category>/<address>`).
export function parseSiloPathFromUrl(): SiloPathMatch | null {
  const segments = pathSegments();
  if (segments.length < 2) {
    return null;
  }
  const category = segments[0].toLowerCase();
  const rest = segments.slice(1);

  if (rest.length >= 2 && CHAIN_NAME_PATTERN.test(rest[0]) && SILO_ADDRESS_PATTERN.test(rest[1])) {
    return {
      category,
      chain: rest[0].toLowerCase(),
      address: rest[1],
    };
  }

  if (rest.length === 1 && SILO_ADDRESS_PATTERN.test(rest[0])) {
    return { category, address: rest[0] };
  }

  return null;
}

function withBase(path: string): string {
  const base = getAppBasePath();
  return base ? `${base}${path}` : path;
}

// Root of the app: the landing page listing every category.
export function landingHomePath(): string {
  return withBase("/");
}

// Home (explorer) of a single category.
export function categoryHomePath(category: string): string {
  return withBase(`/${category.toLowerCase()}`);
}

export function buildSiloPath(category: string, chain: string, address: string): string {
  return withBase(`/${category.toLowerCase()}/${chain.toLowerCase()}/${address}`);
}

// All filters that describe how a silo's tables are viewed. Every field is shareable
// through the URL query string so the exact filtered view can be copied and reopened.
export type SnapshotViewParams = {
  // Address substring filter (query: `filter`).
  addressFilter?: string;
  // Address type filter (query: `type`); omitted when unset or "all".
  addressType?: string;
  // Row filters (query: `details` / `borrower` / `negative`, each present as `=1`).
  details?: boolean;
  borrower?: boolean;
  negative?: boolean;
};

export function parseSnapshotViewParamsFromUrl(): SnapshotViewParams {
  const params = new URLSearchParams(window.location.search);
  const addressFilter = params.get("filter")?.trim() || undefined;
  const addressType = params.get("type")?.trim() || undefined;
  return {
    addressFilter,
    addressType: addressType && addressType !== "all" ? addressType : undefined,
    details: params.get("details") === "1",
    borrower: params.get("borrower") === "1",
    negative: params.get("negative") === "1",
  };
}

// Writes the shareable view params onto an existing URLSearchParams, skipping any that
// are empty/disabled so clean views keep a clean URL.
function appendSnapshotViewParams(params: URLSearchParams, view: SnapshotViewParams): void {
  const trimmedFilter = view.addressFilter?.trim();
  if (trimmedFilter) {
    params.set("filter", trimmedFilter);
  }
  const trimmedType = view.addressType?.trim();
  if (trimmedType && trimmedType !== "all") {
    params.set("type", trimmedType);
  }
  if (view.details) {
    params.set("details", "1");
  }
  if (view.borrower) {
    params.set("borrower", "1");
  }
  if (view.negative) {
    params.set("negative", "1");
  }
}

export type ExplorerSelection = {
  chain?: string;
  address?: string;
  view: SnapshotViewParams;
};

export function parseExplorerSelectionFromUrl(): ExplorerSelection {
  const params = new URLSearchParams(window.location.search);
  const chain = params.get("chain") ?? undefined;
  const address = params.get("silo") ?? undefined;
  return {
    chain: chain && CHAIN_NAME_PATTERN.test(chain) ? chain.toLowerCase() : undefined,
    address: address && SILO_ADDRESS_PATTERN.test(address) ? address : undefined,
    view: parseSnapshotViewParamsFromUrl(),
  };
}

export function buildExplorerSelectionUrl(
  category: string,
  chain: string,
  address: string,
  view: SnapshotViewParams = {},
): string {
  const params = new URLSearchParams();
  params.set("chain", chain.toLowerCase());
  params.set("silo", address);
  appendSnapshotViewParams(params, view);
  return `${categoryHomePath(category)}?${params.toString()}`;
}

export function buildSiloPathWithView(
  category: string,
  chain: string,
  address: string,
  view: SnapshotViewParams = {},
): string {
  const path = buildSiloPath(category, chain, address);
  const params = new URLSearchParams();
  appendSnapshotViewParams(params, view);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
