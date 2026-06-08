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
