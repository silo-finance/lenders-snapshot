const SILO_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function getAppBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function parseSiloAddressFromPath(): string | null {
  const base = getAppBasePath();
  let pathname = window.location.pathname;

  if (base && pathname.startsWith(base)) {
    pathname = pathname.slice(base.length);
  }

  const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (segment && SILO_ADDRESS_PATTERN.test(segment)) {
    return segment;
  }

  return null;
}

export function explorerHomePath(): string {
  const base = getAppBasePath();
  return base ? `${base}/` : "/";
}
