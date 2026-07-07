import { buildCategoryData, type CategoryData, type RawRoot, type SiloCategory } from "./snapshot";
import treveeAirdropData from "../scripts/lender-snapshot/data/trevee-airdrop.json";
import treveeData from "../scripts/lender-snapshot/data/trevee.json";

/**
 * A snapshot category is a self-contained snapshot rendered under its own path
 * (e.g. `/lenders-snapshot/trevee-airdrop`). Categories are intentionally HARDCODED here to
 * keep the app simple: adding one is a rare, deliberate edit (add the silo list in the
 * Python scanner, run it to produce `data/<slug>.json`, then add an entry below).
 *
 * `data` is `null` for categories that are announced but not yet generated
 * ("coming soon" on the landing page).
 */
export type SnapshotCategory = {
  slug: string;
  label: string;
  title: string;
  description: string[];
  // When true, this category exposes the pro-rata distribution controls and the extra
  // "Airdrop" column. Categories without a recovery distribution set this to false.
  airdropEnabled: boolean;
  // Default airdrop amounts pre-filled per asset bucket (usdc/eth) when distribution
  // is enabled for this category.
  airdropDefaults: Partial<Record<SiloCategory, string>>;
  data: CategoryData | null;
};

export const SNAPSHOT_CATEGORIES: SnapshotCategory[] = [
  {
    slug: "trevee-airdrop",
    label: "Trevee Airdrop",
    title: "Lender Snapshot for Trevee Airdrop",
    description: [
      "Trevee is the issuer of the wstkscUSD and wstkscETH assets. Approximately 95% of the assets backing these tokens were lent to Stream Finance, while the remaining 5% stayed unallocated.",
      "Following the Stream Finance incident, Trevee transferred 46,019 USDC and 42.53239 ETH to Silo for distribution to affected lenders. This page shows the snapshot used to calculate each lender\u2019s share of the recovery distribution across all impacted markets and vaults.",
    ],
    airdropEnabled: true,
    airdropDefaults: { usdc: "46019", eth: "42.53239" },
    data: buildCategoryData(treveeAirdropData as unknown as RawRoot),
  },
  {
    slug: "trevee",
    label: "Trevee",
    title: "Lender Snapshot for Trevee",
    description: [
      "This snapshot lists the lenders of the Trevee markets on Silo, captured at a fixed block.",
      "Use it to review each lender\u2019s position across the tracked Trevee silos and vaults.",
    ],
    airdropEnabled: false,
    airdropDefaults: {},
    data: buildCategoryData(treveeData as unknown as RawRoot),
  },
];

export function findCategory(slug: string | undefined | null): SnapshotCategory | undefined {
  if (!slug) {
    return undefined;
  }
  const normalized = slug.toLowerCase();
  return SNAPSHOT_CATEGORIES.find((category) => category.slug === normalized);
}
