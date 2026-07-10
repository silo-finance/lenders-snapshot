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
 * ("coming soon" on the landing page) or that live in a separate deployment
 * (`externalUrl`, rendered as an outbound link).
 */
export type SnapshotCategory = {
  slug: string;
  label: string;
  title: string;
  description: string[];
  // When set, the landing card links out to this URL instead of an in-app snapshot
  // (used for snapshots that were moved to their own deployment).
  externalUrl?: string;
  data: CategoryData | null;
};

export const SNAPSHOT_CATEGORIES: SnapshotCategory[] = [
  {
    slug: "trevee-airdrop",
    label: "Trevee Airdrop",
    title: "Lender Snapshot for Trevee Airdrop",
    description: [
      "The Trevee Airdrop snapshot now lives in its own deployment.",
    ],
    externalUrl: "https://silo-finance.github.io/trevee-lenders-snapshot",
    data: null,
  },
  {
    slug: "trevee",
    label: "Trevee",
    title: "Lender Snapshot for Trevee",
    description: [
      "This snapshot lists the lenders of the Trevee markets on Silo, captured at a fixed block.",
      "Use it to review each lender\u2019s position across the tracked Trevee silos and vaults.",
    ],
    data: buildCategoryData(treveeData as unknown as RawRoot),
  },
  {
    slug: "pendle",
    label: "Pendle",
    title: "Lender Snapshot for Pendle",
    description: [
      "This snapshot lists the lenders of the Pendle markets on Silo, captured at a fixed block.",
      "Use it to review each lender\u2019s position across the tracked Pendle silos and vaults.",
    ],
    data: buildCategoryData(pendleData as unknown as RawRoot),
  },
  {
    slug: "stream",
    label: "Stream",
    title: "Lender Snapshot for Stream",
    description: [
      "This snapshot lists the lenders of the Stream markets on Silo, captured at a fixed block.",
      "Use it to review each lender\u2019s position across the tracked Stream silos and vaults.",
    ],
    data: buildCategoryData(streamData as unknown as RawRoot),
  },
];

export function findCategory(slug: string | undefined | null): SnapshotCategory | undefined {
  if (!slug) {
    return undefined;
  }
  const normalized = slug.toLowerCase();
  return SNAPSHOT_CATEGORIES.find((category) => category.slug === normalized);
}
