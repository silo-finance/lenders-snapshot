const SILO_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const CHAIN_SILO_PATH_PATTERN = /^([a-z0-9_-]+)-(0x[a-fA-F0-9]{40})$/i;

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

  const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (!segment) {
    return null;
  }

  const chainMatch = segment.match(CHAIN_SILO_PATH_PATTERN);
  if (chainMatch) {
    return {
      chain: chainMatch[1].toLowerCase(),
      address: chainMatch[2],
    };
  }

  if (SILO_ADDRESS_PATTERN.test(segment)) {
    return { address: segment };
  }

  return null;
}

export function buildSiloPath(chain: string, address: string): string {
  const base = getAppBasePath();
  const segment = `${chain.toLowerCase()}-${address}`;
  return base ? `${base}/${segment}` : `/${segment}`;
}

export function explorerHomePath(): string {
  const base = getAppBasePath();
  return base ? `${base}/` : "/";
}
