import { buildCategoryData, type CategoryData, type RawRoot } from "./snapshot";
import treveeData from "../scripts/lender-snapshot/data/trevee.json";
import pendleData from "../scripts/lender-snapshot/data/pendle.json";
import streamData from "../scripts/lender-snapshot/data/stream.json";

/**
 * A snapshot category is a self-contained snapshot rendered under its own path
 * (e.g. `/lenders-snapshot/stream`). Categories are intentionally HARDCODED here to
 * keep the app simple: adding one is a rare, deliberate edit (add the silo list in the
 * Python scanner, run it to produce `data/<slug>.json`, then add an entry below).
 *
 * `data` is `null` for categories that are announced but not yet generated
 * ("coming soon" on the landing page) or that link out via `externalUrl`.
 */
export type SnapshotCategory = {
  slug: string;
  label: string;
  title: string;
  description: string[];
  // When set, the landing card links out to this URL instead of an in-app snapshot.
  externalUrl?: string;
  data: CategoryData | null;
};

export const SNAPSHOT_CATEGORIES: SnapshotCategory[] = [
  {
    slug: "stream",
    label: "Stream Claims",
    title: "Lender Snapshot for Stream Finance Claims",
    description: [
      "This snapshot reconstructs lender balances across all affected Stream Finance lending markets and managed vaults as of the selected snapshot block.",
      "SiloDAO will use the balances shown below to submit recovery claims to Stream Finance on behalf of affected lenders. Review your position by selecting a Silo or Vault and searching for your wallet address.",
    ],
    data: buildCategoryData(streamData as unknown as RawRoot),
  },
  {
    slug: "trevee",
    label: "Trevee Claims",
    title: "Lender Snapshot for Trevee Claims",
    description: [
      "This snapshot reconstructs lender balances across all affected Stream Finance lending markets and managed vaults as of the selected snapshot block.",
      "These balances are provided to help affected lenders verify their positions. To participate in any recovery process, lenders should follow Trevee instructions for submitting claims related to the Stream Finance default. Review your position by selecting a Silo or Vault and searching for your wallet address.",
    ],
    data: buildCategoryData(treveeData as unknown as RawRoot),
  },
  {
    slug: "pendle",
    label: "Pendle Claims",
    title: "Lender Snapshot for Pendle Claims",
    description: [
      "This snapshot reconstructs lender balances across all affected Stream Finance lending markets and managed vaults as of the selected snapshot block.",
      "These balances are provided to help affected lenders verify their positions. To participate in any recovery process, lenders should follow Pendle\u2019s instructions for submitting claims related to the Stream Finance default. Review your position by selecting a Silo or Vault and searching for your wallet address.",
    ],
    data: buildCategoryData(pendleData as unknown as RawRoot),
  },
];

export function findCategory(slug: string | undefined | null): SnapshotCategory | undefined {
  if (!slug) {
    return undefined;
  }
  const normalized = slug.toLowerCase();
  return SNAPSHOT_CATEGORIES.find((category) => category.slug === normalized);
}
