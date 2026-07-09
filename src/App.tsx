import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from "react";
import packageJson from "../package.json";
import {
  buildExplorerSelectionUrl,
  buildSiloPath,
  buildSiloPathWithFilter,
  categoryHomePath,
  landingHomePath,
  parseCategoryFromUrl,
  parseExplorerSelectionFromUrl,
  parseFilterFromUrl,
  parseSiloPathFromUrl,
} from "./routing";
import {
  type ChainSnapshot,
  type DirectLender,
  type SiloCategory,
  type SiloSnapshot,
  type TransferEntry,
  type VaultDepositor,
  type VaultSnapshot,
  type WithdrawalEntry,
  SILO_CATEGORY_LABELS,
  SILO_CATEGORY_ORDER,
  compareBigIntAsc,
  compareBigIntDesc,
  explorerAddressUrl,
  explorerTxUrl,
  findSiloByAddress,
  formatUnits,
  formatUnitsFixed,
  formatUnitsPlain,
  formatUnitsRounded,
  parseUnits,
  shortAddress,
  siloCategory,
} from "./snapshot";
import { SNAPSHOT_CATEGORIES, findCategory, type SnapshotCategory } from "./categories";
import { getNetworkIconPath, getNetworkName } from "./networks";
import { useWallet } from "./useWallet";

// Active snapshot category (resolved from the URL) shared with the whole view tree so
// deeply nested components can build category-scoped URLs and read the snapshot metadata
// without prop-drilling.
type ActiveCategory = {
  slug: string;
  label: string;
  title: string;
  description: string[];
  airdropEnabled: boolean;
  airdropDefaults: Partial<Record<SiloCategory, string>>;
  chains: ChainSnapshot[];
  snapshotBlock: number;
  eventsToBlock: number;
};

const CategoryContext = createContext<ActiveCategory | null>(null);

function useActiveCategory(): ActiveCategory {
  const value = useContext(CategoryContext);
  if (!value) {
    throw new Error("useActiveCategory must be used within a CategoryContext provider");
  }
  return value;
}

// User-selectable decimal separator for CSV number cells. Comma-decimal locales
// (e.g. pl-PL) need "," so spreadsheets don't mistake the "." for a thousands
// separator; anglophone tooling usually expects ".".
type CsvDecimal = "." | ",";

const CsvFormatContext = createContext<{ decimal: CsvDecimal; setDecimal: (value: CsvDecimal) => void } | null>(null);

function useCsvFormat(): { decimal: CsvDecimal; setDecimal: (value: CsvDecimal) => void } {
  const value = useContext(CsvFormatContext);
  if (!value) {
    throw new Error("useCsvFormat must be used within a CsvFormatContext provider");
  }
  return value;
}

function toActiveCategory(category: SnapshotCategory): ActiveCategory {
  if (!category.data) {
    throw new Error(`snapshot category '${category.slug}' has no data`);
  }
  return {
    slug: category.slug,
    label: category.label,
    title: category.title,
    description: category.description,
    airdropEnabled: category.airdropEnabled,
    airdropDefaults: category.airdropDefaults,
    chains: category.data.chains,
    snapshotBlock: category.data.snapshotBlock,
    eventsToBlock: category.data.eventsToBlock,
  };
}

type SortDirection = "asc" | "desc";
type TableSortKey = "address" | "type" | "assets" | "withdrawals" | "pending";
type TableSortState = {
  key: TableSortKey;
  direction: SortDirection;
};

type AggregateTotals = {
  shares: bigint;
  assets: bigint;
  withdrawals: bigint;
  pending: bigint;
};

const DEFAULT_EXPANDED_LIMIT = 2;
const APP_VERSION = packageJson.version;

type AirdropPlan = {
  airdropRaw: bigint;
  byLeafKey: Map<string, bigint>;
  csvAirdrops: Map<string, bigint | null>;
  excludedLeafKeys: Set<string>;
  totalPendingAssets: bigint;
  distributed: bigint;
  undistributed: bigint;
  nonAttributableAssets: bigint;
  // Number of distinct addresses that received a strictly positive raw allocation
  // (counted on the true smallest-unit value, so even a 1-wei recipient counts).
  recipientCount: number;
};

const ZERO = 0n;
const OTHER_CONTRACT_TYPE = "contract_other";

function directLeafKey(siloAddress: string, address: string): string {
  return `direct:${siloAddress}:${address}`;
}

function vaultLeafKey(siloAddress: string, vaultAddress: string, depositorAddress: string): string {
  return `vault:${siloAddress}:${vaultAddress}:${depositorAddress}`;
}

function siloDistributedTotal(silo: SiloSnapshot, airdropPlan: AirdropPlan): bigint {
  let total = ZERO;
  for (const lender of silo.directLenders) {
    if (lender.isVault) {
      continue;
    }
    total += airdropPlan.byLeafKey.get(directLeafKey(silo.address, lender.address)) ?? ZERO;
  }
  for (const vault of silo.vaults) {
    for (const depositor of vault.depositors) {
      total += airdropPlan.byLeafKey.get(vaultLeafKey(silo.address, vault.address, depositor.address)) ?? ZERO;
    }
  }
  return total;
}

function csvEscape(value: string): string {
  if (/[";\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((row) => row.map(csvEscape).join(";")).join("\n");
  const blob = new Blob([`${csv}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const PENDING_CSV_HEADER = ["Network", "Silo", "Vault", "Address", "Type", "Pending assets"];

// Excel/Sheets in comma-decimal locales (e.g. pl-PL) treat "." as a thousands
// separator and silently drop it, turning 505857.957484 into 505857957484. The
// CSV field delimiter is ";", so a decimal comma is unambiguous there; the
// separator is user-selectable via the export panel radio.
function formatPendingForCsv(value: bigint, decimals: number, decimal: CsvDecimal): string {
  const plain = formatUnitsPlain(value, decimals);
  return decimal === "," ? plain.replace(".", ",") : plain;
}

// One row-emitter reused by every pending-assets export. `pairs` are the (chain, silo) scopes
// to dump; each silo contributes its non-vault direct lenders plus every vault depositor.
// Pending is stored in the silo's underlying-asset units, so it is always formatted with
// `silo.inputToken.decimals` (never the vault share-token decimals).
function buildPendingCsv(
  pairs: { chain: ChainSnapshot; silo: SiloSnapshot }[],
  decimal: CsvDecimal,
): string[][] {
  const rows: string[][] = [PENDING_CSV_HEADER];
  for (const { chain, silo } of pairs) {
    const dec = silo.inputToken.decimals;
    for (const lender of silo.directLenders) {
      // Vault placeholder rows are expanded through their depositors below.
      if (lender.isVault) {
        continue;
      }
      rows.push([
        chain.label,
        silo.address,
        "",
        lender.address,
        lender.addressType,
        formatPendingForCsv(lender.pendingAssets, dec, decimal),
      ]);
    }
    for (const vault of silo.vaults) {
      for (const depositor of vault.depositors) {
        rows.push([
          chain.label,
          silo.address,
          vault.address,
          depositor.address,
          depositor.addressType,
          formatPendingForCsv(depositor.pendingAssets, dec, decimal),
        ]);
      }
    }
  }
  return rows;
}

// Lets the user pick the decimal separator used for "Pending assets" cells so
// the CSV opens cleanly in both period- and comma-decimal spreadsheet locales.
function DecimalSeparatorRadio({
  decimal,
  onChange,
}: {
  decimal: CsvDecimal;
  onChange: (value: CsvDecimal) => void;
}) {
  const options: { value: CsvDecimal; label: string }[] = [
    { value: ".", label: "Period (1234.56)" },
    { value: ",", label: "Comma (1234,56)" },
  ];
  return (
    <fieldset>
      <legend className="text-[0.7rem] uppercase tracking-[0.18em] text-slate-500">Decimal separator</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {options.map((option) => (
          <label key={option.value} className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="radio"
              name="csv-decimal-separator"
              className="h-3.5 w-3.5 accent-emerald-300"
              checked={decimal === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function sumDirectLenderTotals(lenders: DirectLender[]): AggregateTotals {
  return lenders.reduce(
    (acc, lender) => ({
      shares: acc.shares + lender.totalShares,
      assets: acc.assets + lender.totalAssets,
      withdrawals: acc.withdrawals + (lender.isVault ? ZERO : lender.totalWithdrawals),
      pending: acc.pending + (lender.isVault ? ZERO : lender.pendingAssets),
    }),
    { shares: ZERO, assets: ZERO, withdrawals: ZERO, pending: ZERO },
  );
}

function sumDepositorTotals(depositors: VaultDepositor[]): AggregateTotals {
  return depositors.reduce(
    (acc, depositor) => ({
      shares: acc.shares + depositor.vaultShares,
      assets: acc.assets + depositor.attributedSiloAssets,
      withdrawals: acc.withdrawals + depositor.totalWithdrawals,
      pending: acc.pending + depositor.pendingAssets,
    }),
    { shares: ZERO, assets: ZERO, withdrawals: ZERO, pending: ZERO },
  );
}

// Total distinct lender entries across a set of silos: every direct lender plus
// every vault depositor, counted once per silo they lend into. A `silo_vault`
// direct lender is just a placeholder for an underlying vault that gets expanded
// into its depositors, so it is not counted itself — unless we have no depositor
// data for it (a warning vault), in which case the placeholder stands in as the
// single lender we know about.
function countLenders(silos: SiloSnapshot[]): number {
  let total = 0;
  for (const silo of silos) {
    for (const lender of silo.directLenders) {
      if (!lender.isVault) {
        total += 1;
        continue;
      }
      const vault = silo.vaults.find(
        (entry) => entry.address.toLowerCase() === lender.address.toLowerCase(),
      );
      if (vault && !isVaultWarning(vault)) {
        // Expanded into its depositors below; skip the placeholder.
        continue;
      }
      total += 1;
    }
    for (const vault of silo.vaults) {
      if (isVaultWarning(vault)) {
        continue;
      }
      total += vault.depositors.length;
    }
  }
  return total;
}

function sumDirectShares(silo: SiloSnapshot): bigint {
  return silo.directLenders.reduce((sum, lender) => sum + lender.collateralShares, ZERO);
}

// Total pending assets across the whole silo: direct (non-vault) lenders plus every
// vault depositor. Vault placeholders in directLenders are skipped (their pending lives
// on the underlying depositors), matching how the per-table totals are computed.
function sumSiloPending(silo: SiloSnapshot): bigint {
  let pending = sumDirectLenderTotals(silo.directLenders).pending;
  for (const vault of silo.vaults) {
    pending += sumDepositorTotals(vault.depositors).pending;
  }
  return pending;
}

function ValidationBadge({
  message,
  valid,
  inline = false,
  label,
}: {
  message: string;
  valid: boolean;
  inline?: boolean;
  label?: string;
}) {
  if (!valid) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-emerald-300 ${inline ? "text-xs" : "mt-2 gap-1.5 text-sm"}`}
    >
      <span aria-hidden="true">✓</span>
      <span>
        {label ? <span className="font-semibold">{label}: </span> : null}
        {message}
      </span>
    </span>
  );
}

function MetricCard({
  label,
  value,
  hint,
  footer,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-emerald-950/20 ${className}`}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold text-white">{value}</p>
      {footer}
      {hint ? <p className="mt-1.5 text-sm text-slate-400">{hint}</p> : null}
    </div>
  );
}

function SiloMetrics({ silo }: { silo: SiloSnapshot }) {
  const { eventsToBlock } = useActiveCategory();
  const directSharesSum = sumDirectShares(silo);
  const sharesValid = directSharesSum === silo.collateralTotalSupply;
  const totalPending = sumSiloPending(silo);

  return (
    <>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-emerald-950/20 md:col-span-2">
        <div className="flex items-start justify-between gap-x-10">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Total assets
              {silo.snapshotBlock > 0 ? (
                <span className="ml-2 font-normal italic normal-case tracking-normal text-slate-500">
                  at block {silo.snapshotBlock}
                </span>
              ) : null}
            </p>
            <p className="mt-2 font-mono text-xl font-semibold text-white">
              {`${formatUnitsRounded(silo.totalAssets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
            </p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Total pending assets
              {eventsToBlock > 0 ? (
                <span className="ml-2 font-normal italic normal-case tracking-normal text-slate-500">
                  at block {eventsToBlock}
                </span>
              ) : null}
            </p>
            <p
              className={`mt-2 font-mono text-xl font-semibold ${
                totalPending < ZERO ? "text-rose-300" : "text-white"
              }`}
            >
              {`${formatUnitsRounded(totalPending, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
            </p>
          </div>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-slate-200">
          <span>
            {silo.totalShares.toString()} <span className="text-slate-400">shares</span>
          </span>
          <ValidationBadge
            inline
            message="Total shares equals sum of direct lender shares"
            valid={sharesValid}
          />
        </p>
      </div>
      <MetricCard
        label="Vaults assets"
        value={`${formatUnitsRounded(
          silo.vaults.reduce((sum, vault) => sum + vault.vaultSiloAssets, 0n),
          silo.inputToken.decimals,
          2,
        )} ${silo.inputToken.symbol}`}
        hint="Sum across all vaults"
      />
      </div>
      {silo.borrowRepaySilo ? (
        <p className="mt-3 inline-flex max-w-3xl items-start gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3.5 py-1.5 text-xs font-medium leading-5 text-amber-200">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold text-amber-100">Note on negative pending assets.</span>{" "}
            After the {silo.borrowRepayToken?.symbol || "borrowed asset"} depeg, sharply higher
            interest rates inflated collateral values, letting positions borrow far more{" "}
            {silo.borrowRepayToken?.symbol || "the borrowed asset"} than their snapshot-time
            collateral was worth. This surfaces as a large negative pending — a valuation-timing
            effect, not missing data or an under-collateralized loan.
          </span>
        </p>
      ) : null}
    </>
  );
}

function scrollToSection(sectionId: string) {
  document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" x2="21" y1="14" y2="3" />
    </svg>
  );
}

function SectionNavButtons({ prevId, nextId }: { prevId?: string; nextId?: string }) {
  if (!prevId && !nextId) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      {prevId ? (
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-slate-300 transition hover:bg-white/10 hover:text-emerald-200"
          title="Previous table"
          type="button"
          onClick={() => scrollToSection(prevId)}
        >
          <ChevronIcon className="rotate-180" />
        </button>
      ) : null}
      {nextId ? (
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-slate-300 transition hover:bg-white/10 hover:text-emerald-200"
          title="Next table"
          type="button"
          onClick={() => scrollToSection(nextId)}
        >
          <ChevronIcon />
        </button>
      ) : null}
    </span>
  );
}

// Reusable metadata bar (title + nav + actions) rendered at the top of a table
// card and repeated at the bottom so long tables stay self-describing.
function SectionMetaBar({
  title,
  actions,
  className = "",
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 px-5 py-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">{title}</div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function ColumnHeaderSum({ value }: { value: string }) {
  return (
    <div className="mb-1 text-[10px] font-normal normal-case tracking-normal text-slate-400">
      Sum: <span className="font-mono text-slate-300">{value}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-6 text-center text-sm text-slate-400">
      {message}
    </div>
  );
}

function copyAddress(address: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(address);
  }

  const textarea = document.createElement("textarea");
  textarea.value = address;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

function CopyAddressButton({ address, bare = false }: { address: string; bare?: boolean }) {
  const [copied, setCopied] = useState(false);

  const className = bare
    ? `inline-flex items-center justify-center text-xs transition ${
        copied ? "text-emerald-100" : "text-slate-400 hover:text-emerald-200"
      }`
    : `inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${
        copied
          ? "border-emerald-300/60 bg-emerald-300/20 text-emerald-100"
          : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-emerald-300/40 hover:text-emerald-200"
      }`;

  return (
    <button
      className={className}
      title={copied ? "Address copied" : "Copy address"}
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyAddress(address).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
      <span className="sr-only">{copied ? "Address copied" : "Copy address"}</span>
    </button>
  );
}

function SiloPageLinkButton({ chain, address }: { chain: string; address: string }) {
  const { slug } = useActiveCategory();
  return (
    <a
      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-xs text-slate-400 transition hover:border-emerald-300/40 hover:text-emerald-200"
      href={buildSiloPath(slug, chain, address)}
      title="Open silo-only page"
      onClick={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true">↗</span>
      <span className="sr-only">Open silo-only page</span>
    </a>
  );
}

// Network name + icon (icons ported from the actions project). Shown per silo so a
// category can span multiple chains while the data view stays uniform.
function NetworkBadge({ chainId, className = "" }: { chainId: number; className?: string }) {
  const icon = getNetworkIconPath(chainId);
  const name = getNetworkName(chainId);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs font-medium text-slate-300 ${className}`}
    >
      {icon ? <img alt="" aria-hidden="true" className="h-3.5 w-3.5 rounded-full" src={icon} /> : null}
      <span>{name}</span>
    </span>
  );
}

function AddressLink({
  chain,
  address,
  showSiloPageLink = false,
  bareCopy = false,
  tone = "emerald",
}: {
  chain: string;
  address: string;
  showSiloPageLink?: boolean;
  bareCopy?: boolean;
  tone?: "emerald" | "amber";
}) {
  const linkClass =
    tone === "amber"
      ? "font-mono text-amber-300 transition hover:text-amber-200"
      : "font-mono text-emerald-200 transition hover:text-emerald-100";
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <a
        className={linkClass}
        href={explorerAddressUrl(chain, address)}
        rel="noreferrer"
        target="_blank"
        title={address}
        onClick={(event) => event.stopPropagation()}
      >
        {shortAddress(address)}
      </a>
      <CopyAddressButton address={address} bare={bareCopy} />
      {showSiloPageLink ? <SiloPageLinkButton address={address} chain={chain} /> : null}
    </span>
  );
}

function AddressFilterInput({
  id,
  value,
  onChange,
  shareUrl,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  // Absolute URL for the currently filtered address. When present (and the filter is
  // non-empty), share/open shortcuts are surfaced to the right of the input.
  shareUrl?: string;
}) {
  const [copied, setCopied] = useState(false);
  const showActions = value.trim().length > 0 && Boolean(shareUrl);
  const hasTrailingControls = showActions || Boolean(value);

  return (
    <div className="relative mt-3">
      <input
        id={id}
        className={`w-full rounded-2xl border border-white/10 bg-slate-950/80 py-3 pl-4 font-mono text-sm text-slate-300 outline-none placeholder:text-slate-600 ${
          hasTrailingControls ? "pr-28" : "pr-4"
        }`}
        placeholder="Search by address substring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {showActions && shareUrl ? (
          <>
            <button
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition ${
                copied
                  ? "border-emerald-300/60 bg-emerald-300/20 text-emerald-100"
                  : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-emerald-300/40 hover:text-emerald-200"
              }`}
              title={copied ? "Link copied" : "Copy shareable link for this address"}
              type="button"
              onClick={() => {
                void copyAddress(shareUrl).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? (
                <span aria-hidden="true" className="text-xs">
                  ✓
                </span>
              ) : (
                <ShareIcon />
              )}
              <span className="sr-only">{copied ? "Link copied" : "Copy shareable link for this address"}</span>
            </button>
            <a
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-slate-400 transition hover:border-emerald-300/40 hover:text-emerald-200"
              href={shareUrl}
              rel="noreferrer"
              target="_blank"
              title="Open this address page in a new tab"
            >
              <ExternalLinkIcon />
              <span className="sr-only">Open this address page in a new tab</span>
            </a>
          </>
        ) : null}
        {value ? (
          <button
            className="rounded-full px-2 py-1 text-sm text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
            title="Clear address filter"
            type="button"
            onClick={() => onChange("")}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SortHeader({
  align = "left",
  sortKey,
  sortState,
  label,
  onClick,
}: {
  align?: "left" | "right";
  sortKey: TableSortKey;
  sortState: TableSortState;
  label: string;
  onClick: (key: TableSortKey) => void;
}) {
  const active = sortState.key === sortKey;
  return (
    <button
      className={`inline-flex items-center gap-1 transition hover:text-emerald-200 ${
        align === "right" ? "justify-end text-right" : "justify-start text-left"
      }`}
      type="button"
      onClick={() => onClick(sortKey)}
    >
      <span>{label}</span>
      <span className={active ? "text-emerald-200" : "text-slate-600"}>
        {active ? (sortState.direction === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </button>
  );
}

function nextSortState(current: TableSortState, key: TableSortKey): TableSortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "type" || key === "address" ? "asc" : "desc" };
}

function compareStrings(left: string, right: string, direction: SortDirection): number {
  const result = left.localeCompare(right);
  return direction === "asc" ? result : -result;
}

function compareValues(left: bigint, right: bigint, direction: SortDirection): number {
  return direction === "asc" ? compareBigIntAsc(left, right) : compareBigIntDesc(left, right);
}

function sortDirectLenders(rows: DirectLender[], sortState: TableSortState): DirectLender[] {
  return [...rows].sort((left, right) => {
    if (sortState.key === "address") {
      return compareStrings(left.address, right.address, sortState.direction);
    }
    if (sortState.key === "type") {
      return compareStrings(left.addressType, right.addressType, sortState.direction);
    }
    if (sortState.key === "withdrawals") {
      return compareValues(left.totalWithdrawals, right.totalWithdrawals, sortState.direction);
    }
    if (sortState.key === "pending") {
      return compareValues(left.pendingAssets, right.pendingAssets, sortState.direction);
    }
    // Sort the Assets column by share balance: shares carry full precision, whereas
    // displayed assets can collide once rounded.
    return compareValues(left.collateralShares, right.collateralShares, sortState.direction);
  });
}

function shortHash(hash: string): string {
  if (!hash) {
    return "n/a";
  }
  if (hash.length <= 16) {
    return hash;
  }
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function hasFlowActivity(row: {
  totalWithdrawals: bigint;
  totalDeposits: bigint;
  totalTransfersIn: bigint;
  totalTransfersOut: bigint;
  totalBorrows?: bigint;
  totalRepays?: bigint;
  debtAtSnapshot?: bigint;
}): boolean {
  return (
    row.totalWithdrawals > ZERO ||
    row.totalDeposits > ZERO ||
    row.totalTransfersIn > ZERO ||
    row.totalTransfersOut > ZERO ||
    (row.totalBorrows ?? ZERO) > ZERO ||
    (row.totalRepays ?? ZERO) > ZERO ||
    (row.debtAtSnapshot ?? ZERO) > ZERO
  );
}

// Renders an amount with its asset symbol in a fixed-width, left-aligned column so the numeric
// portions stay right-aligned across rows regardless of symbol length.
function AmountWithSymbol({
  sign,
  value,
  symbol,
  className,
}: {
  sign?: string;
  value: string;
  symbol: string;
  className?: string;
}) {
  return (
    <span className={`shrink-0 tabular-nums ${className ?? ""}`}>
      <span className="inline-block text-right">
        {sign}
        {value}
      </span>
      <span className="ml-1 inline-block w-14 text-left font-normal text-slate-500">{symbol}</span>
    </span>
  );
}

function PendingAssetsBreakdown({
  chain,
  baseAssets,
  totalWithdrawals,
  totalDeposits,
  totalTransfersIn,
  totalTransfersOut,
  totalBorrows = ZERO,
  totalRepays = ZERO,
  debtAtSnapshot = ZERO,
  snapshotBlock = 0,
  pendingAssets,
  withdrawals,
  deposits,
  transfers,
  borrows = [],
  repays = [],
  decimals,
  symbol,
  borrowRepaySymbol,
}: {
  chain: string;
  baseAssets: bigint;
  totalWithdrawals: bigint;
  totalDeposits: bigint;
  totalTransfersIn: bigint;
  totalTransfersOut: bigint;
  totalBorrows?: bigint;
  totalRepays?: bigint;
  debtAtSnapshot?: bigint;
  snapshotBlock?: number;
  pendingAssets: bigint;
  withdrawals: WithdrawalEntry[];
  deposits: WithdrawalEntry[];
  transfers: TransferEntry[];
  borrows?: WithdrawalEntry[];
  repays?: WithdrawalEntry[];
  decimals: number;
  symbol: string;
  borrowRepaySymbol?: string;
}) {
  // Two-sided markets add Borrow (debit, like a withdrawal), Repay (credit, like a deposit)
  // and an initial DEBT baseline (debit at the snapshot block); all kinds share one
  // chronological timeline. Borrow/repay/debt are denominated in the paired (debt) asset.
  type FlowKind = "deposit" | "withdrawal" | "transfer-in" | "transfer-out" | "borrow" | "repay" | "debt";
  const isCredit = (kind: FlowKind) => kind === "deposit" || kind === "transfer-in" || kind === "repay";
  const pairedSymbol = borrowRepaySymbol && borrowRepaySymbol.length > 0 ? borrowRepaySymbol : symbol;
  const symbolFor = (kind: FlowKind) =>
    kind === "borrow" || kind === "repay" || kind === "debt" ? pairedSymbol : symbol;
  const flows: Array<{ event: WithdrawalEntry; kind: FlowKind; counterparty?: string }> = [
    // Pre-snapshot debt sorts first (snapshotBlock <= all event blocks, logIndex -1).
    ...(debtAtSnapshot > ZERO
      ? [
          {
            event: {
              blockNumber: snapshotBlock,
              logIndex: -1,
              txHash: "",
              assets: debtAtSnapshot,
              shares: ZERO,
              eventAssets: debtAtSnapshot,
            } as WithdrawalEntry,
            kind: "debt" as FlowKind,
          },
        ]
      : []),
    ...deposits.map((event) => ({ event, kind: "deposit" as FlowKind })),
    ...withdrawals.map((event) => ({ event, kind: "withdrawal" as FlowKind })),
    ...transfers.map((event) => ({
      event,
      kind: (event.direction === "in" ? "transfer-in" : "transfer-out") as FlowKind,
      counterparty: event.counterparty,
    })),
    ...borrows.map((event) => ({ event, kind: "borrow" as FlowKind })),
    ...repays.map((event) => ({ event, kind: "repay" as FlowKind })),
  ].sort(
    (a, b) =>
      a.event.blockNumber - b.event.blockNumber ||
      a.event.logIndex - b.event.logIndex ||
      a.event.txHash.localeCompare(b.event.txHash),
  );

  // Running balance is signed (no clamp) so the final value equals
  // base + deposits + transfers_in - withdrawals - transfers_out.
  const flowRows = flows.reduce<Array<{ event: WithdrawalEntry; kind: FlowKind; counterparty?: string; next: bigint }>>(
    (acc, row) => {
      const previous = acc.length > 0 ? acc[acc.length - 1].next : baseAssets;
      const next = isCredit(row.kind) ? previous + row.event.assets : previous - row.event.assets;
      acc.push({ ...row, next });
      return acc;
    },
    [],
  );

  // One distinct hue per operation so they never blend visually. The amount uses the full
  // -300 shade and the label a dimmer -300/80 (the amount reads slightly brighter than its
  // label). Static class strings on purpose so Tailwind can detect and keep them.
  const labelClass = (kind: FlowKind): string => {
    switch (kind) {
      case "deposit":
        return "text-emerald-300/80";
      case "repay":
        return "text-teal-300/80";
      case "transfer-in":
        return "text-sky-300/80";
      case "withdrawal":
        return "text-rose-300/80";
      case "transfer-out":
        return "text-violet-300/80";
      case "borrow":
      case "debt":
        return "text-amber-300/80";
    }
  };
  const amountClass = (kind: FlowKind): string => {
    switch (kind) {
      case "deposit":
        return "text-emerald-300";
      case "repay":
        return "text-teal-300";
      case "transfer-in":
        return "text-sky-300";
      case "withdrawal":
        return "text-rose-300";
      case "transfer-out":
        return "text-violet-300";
      case "borrow":
      case "debt":
        return "text-amber-300";
    }
  };
  const pendingNegative = pendingAssets < ZERO;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/80 p-4 font-mono text-xs text-slate-300">
      <div className="flex justify-between gap-3">
        <span className="text-slate-400">snapshot assets</span>
        <AmountWithSymbol symbol={symbol} value={formatUnitsFixed(baseAssets, decimals)} />
      </div>
      {flows.length === 0 ? (
        <div className="mt-2 text-slate-500">
          {totalWithdrawals > ZERO ||
          totalDeposits > ZERO ||
          totalTransfersIn > ZERO ||
          totalTransfersOut > ZERO ||
          totalBorrows > ZERO ||
          totalRepays > ZERO ||
          debtAtSnapshot > ZERO
            ? "Itemized flow events are unavailable in this snapshot payload."
            : "No deposits, withdrawals or transfers after snapshot block."}
        </div>
      ) : (
        <div className="mt-2 divide-y divide-white/[0.06]">
          {flowRows.map(({ event, kind, counterparty, next }, index) => {
            const txUrl = explorerTxUrl(chain, event.txHash);
            const credit = isCredit(kind);
            const sign = credit ? "+" : "-";
            const rowSymbol = symbolFor(kind);
            return (
              <div
                key={`${kind}-${event.txHash}-${event.logIndex}-${index}`}
                className="group -mx-2 space-y-1 rounded-md px-2 py-2.5 transition-colors hover:bg-white/[0.04]"
              >
                <div className="flex justify-between gap-3">
                  <span className={labelClass(kind)}>
                    {kind === "debt" ? (
                      <>
                        {sign} DEBT on block {event.blockNumber}
                      </>
                    ) : (
                      <>
                        {sign} {kind} (block {event.blockNumber}, tx{" "}
                        {txUrl === "#" ? (
                          shortHash(event.txHash)
                        ) : (
                          <a
                            className="text-emerald-200 transition hover:text-emerald-100"
                            href={txUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {shortHash(event.txHash)}
                          </a>
                        )}
                        {counterparty ? (
                          <>
                            , {kind === "transfer-in" ? "from" : "to"}{" "}
                            <AddressLink bareCopy address={counterparty} chain={chain} />
                          </>
                        ) : null}
                        )
                      </>
                    )}
                  </span>
                  <AmountWithSymbol
                    className={amountClass(kind)}
                    sign={sign}
                    symbol={rowSymbol}
                    value={formatUnitsFixed(event.assets, decimals)}
                  />
                </div>
                {event.eventAssets !== event.assets ? (
                  <div className="flex justify-between gap-3 text-[11px] text-slate-500">
                    <span>on-chain {credit ? "received" : "moved"}</span>
                    <AmountWithSymbol sign={sign} symbol={rowSymbol} value={formatUnitsFixed(event.eventAssets, decimals)} />
                  </div>
                ) : null}
                <div className="flex justify-between gap-3 text-[11px] text-slate-500">
                  <span>running</span>
                  <AmountWithSymbol symbol={symbol} value={formatUnitsFixed(next, decimals)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 border-t border-dashed border-white/10 pt-3">
        {debtAtSnapshot > ZERO ? (
          <div className="mb-1 flex justify-between gap-3">
            <span className="text-slate-400">total initial debt</span>
            <AmountWithSymbol className="text-amber-300" sign="-" symbol={pairedSymbol} value={formatUnitsFixed(debtAtSnapshot, decimals)} />
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">total deposits</span>
          <AmountWithSymbol className="text-emerald-300" sign="+" symbol={symbol} value={formatUnitsFixed(totalDeposits, decimals)} />
        </div>
        {totalTransfersIn > ZERO ? (
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-slate-400">total share transfers in</span>
            <AmountWithSymbol className="text-sky-300" sign="+" symbol={symbol} value={formatUnitsFixed(totalTransfersIn, decimals)} />
          </div>
        ) : null}
        {totalTransfersOut > ZERO ? (
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-slate-400">total share transfers out</span>
            <AmountWithSymbol className="text-violet-300" sign="-" symbol={symbol} value={formatUnitsFixed(totalTransfersOut, decimals)} />
          </div>
        ) : null}
        {totalRepays > ZERO ? (
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-slate-400">total repays</span>
            <AmountWithSymbol className="text-teal-300" sign="+" symbol={pairedSymbol} value={formatUnitsFixed(totalRepays, decimals)} />
          </div>
        ) : null}
        <div className="mt-1 flex justify-between gap-3">
          <span className="text-slate-400">total withdrawals</span>
          <AmountWithSymbol className="text-rose-300" sign="-" symbol={symbol} value={formatUnitsFixed(totalWithdrawals, decimals)} />
        </div>
        {totalBorrows > ZERO ? (
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-slate-400">total borrows</span>
            <AmountWithSymbol className="text-amber-300" sign="-" symbol={pairedSymbol} value={formatUnitsFixed(totalBorrows, decimals)} />
          </div>
        ) : null}
        <div className={`mt-1 flex justify-between gap-3 ${pendingNegative ? "text-rose-300" : "text-emerald-200"}`}>
          <span>= pending assets</span>
          <AmountWithSymbol symbol={symbol} value={formatUnitsFixed(pendingAssets, decimals)} />
        </div>
      </div>
    </div>
  );
}

function HolderTable({
  chain,
  rows,
  silo,
  expanded,
  airdropPlan,
  showAirdropColumn,
  airdropSymbol,
  sortState,
  tableTotals,
  onSort,
  onToggle,
  onJumpToVault,
  onExport,
  forceExpanded = false,
  navNextId,
}: {
  chain: string;
  rows: DirectLender[];
  silo: SiloSnapshot;
  expanded: boolean;
  airdropPlan: AirdropPlan | null;
  showAirdropColumn: boolean;
  airdropSymbol: string;
  sortState: TableSortState;
  tableTotals: AggregateTotals;
  onSort: (key: TableSortKey) => void;
  onToggle: () => void;
  onJumpToVault: (vaultAddress: string) => void;
  onExport: () => void;
  forceExpanded?: boolean;
  navNextId?: string;
}) {
  const isExpanded = forceExpanded || expanded;
  const [expandedBreakdowns, setExpandedBreakdowns] = useState<Record<string, boolean>>({});
  const [showOnlyPlusMinus, setShowOnlyPlusMinus] = useState(false);
  const tableRows = showOnlyPlusMinus
    ? rows.filter((row) => !row.isVault && hasFlowActivity(row))
    : rows;

  function toggleBreakdown(address: string) {
    setExpandedBreakdowns((current) => ({ ...current, [address]: !current[address] }));
  }

  const metaTitle = (
    <>
      <h3 className="font-semibold text-white">
        {silo.isTwoSided ? "Direct lenders/borrowers" : "Direct lenders"} ({rows.length})
      </h3>
      <SectionNavButtons nextId={navNextId} />
    </>
  );
  const metaActions = (
    <>
      <button
        className="rounded-full border border-emerald-300/30 px-3 py-1 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-300/10 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-slate-500 disabled:hover:bg-transparent"
        disabled={rows.length === 0}
        type="button"
        onClick={onExport}
      >
        Export CSV
      </button>
      {forceExpanded ? null : (
        <button
          className="rounded-full border border-white/10 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
          type="button"
          onClick={onToggle}
        >
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      )}
    </>
  );

  return (
    <div id="direct-lenders" className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <SectionMetaBar actions={metaActions} className="border-b border-white/10" title={metaTitle} />
      {!isExpanded ? (
        <div className="px-5 py-4 text-sm text-slate-400">
          Direct lenders table is collapsed. Use Expand or Expand all to show it.
        </div>
      ) : (
        <div className="max-h-[38rem] overflow-auto">
          <table className="min-w-full divide-y divide-white/10 text-sm">
            <thead className="sticky top-0 bg-slate-950 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">
                  <SortHeader label="Address" sortKey="address" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 font-medium">
                  <SortHeader label="Type" sortKey="type" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <ColumnHeaderSum
                    value={`${formatUnitsRounded(tableTotals.assets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                  />
                  <SortHeader align="right" label="Assets" sortKey="assets" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <ColumnHeaderSum
                    value={`${formatUnitsRounded(tableTotals.withdrawals, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                  />
                  <SortHeader
                    align="right"
                    label="Withdrawals"
                    sortKey="withdrawals"
                    sortState={sortState}
                    onClick={onSort}
                  />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <ColumnHeaderSum
                    value={`${formatUnitsRounded(tableTotals.pending, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                  />
                  <SortHeader align="right" label="Pending assets" sortKey="pending" sortState={sortState} onClick={onSort} />
                </th>
                <th className="w-24 px-2 py-3 text-center font-medium">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-2xl leading-none normal-case tracking-normal">±</span>
                    <input
                      aria-label="Show only rows with plus minus details"
                      checked={showOnlyPlusMinus}
                      className="h-4 w-4 rounded border-white/20 bg-slate-950 accent-emerald-300"
                      type="checkbox"
                      onChange={(event) => setShowOnlyPlusMinus(event.target.checked)}
                    />
                  </div>
                </th>
                {showAirdropColumn ? <th className="px-5 py-3 text-right font-medium">Airdrop</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 text-slate-200">
              {tableRows.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-center text-sm text-slate-400" colSpan={showAirdropColumn ? 7 : 6}>
                    {showOnlyPlusMinus
                      ? "No direct lenders with plus/minus match the current filters."
                      : "No direct lenders match the current address filter."}
                  </td>
                </tr>
              ) : (
                tableRows.map((row) => {
                  const breakdownOpen = Boolean(expandedBreakdowns[row.address]);
                  const hasFlows = !row.isVault && hasFlowActivity(row);
                  const isBorrower = !row.isVault && (row.totalBorrows > ZERO || row.debtAtSnapshot > ZERO);
                  return (
                    <Fragment key={row.address}>
                      <tr className="hover:bg-white/[0.03]">
                        <td className="px-5 py-4">
                          <AddressLink address={row.address} chain={chain} tone={isBorrower ? "amber" : "emerald"} />
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">
                              {row.addressType}
                            </span>
                            {row.isVault ? (
                              <button
                                className="rounded-full border border-emerald-300/30 px-2 py-1 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-300/10"
                                title="Show this vault depositors table"
                                type="button"
                                onClick={() => onJumpToVault(row.address)}
                              >
                                ↴
                              </button>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          <div>
                            {formatUnitsRounded(row.totalAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">{row.collateralShares.toString()} shares</div>
                        </td>
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          {row.isVault ? (
                            <span className="text-slate-500">N/A</span>
                          ) : (
                            <>
                              {formatUnitsRounded(row.totalWithdrawals, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                            </>
                          )}
                        </td>
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          {row.isVault ? (
                            <span className="text-slate-500">N/A</span>
                          ) : (
                            <span className={row.pendingAssets < ZERO ? "text-rose-300" : undefined}>
                              {formatUnitsRounded(row.pendingAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-4 text-center font-mono tabular-nums">
                          {hasFlows ? (
                            <button
                              className={`font-sans text-lg font-semibold leading-none transition ${
                                isBorrower
                                  ? "text-amber-300 hover:text-amber-200"
                                  : "text-emerald-200 hover:text-emerald-100"
                              }`}
                              title={breakdownOpen ? "Hide flow details" : "Show flow details"}
                              type="button"
                              onClick={() => toggleBreakdown(row.address)}
                            >
                              <span aria-hidden="true">±</span>
                              <span className="sr-only">Toggle pending assets calculation details</span>
                            </button>
                          ) : null}
                        </td>
                        {showAirdropColumn ? (
                          <td
                            className={
                              row.isVault
                                ? "px-5 py-4 text-right font-mono tabular-nums text-slate-500"
                                : "px-5 py-4 text-right font-mono tabular-nums"
                            }
                          >
                            {row.isVault
                              ? "N/A"
                              : formatAirdropCell(
                                  airdropPlan,
                                  directLeafKey(silo.address, row.address),
                                  silo.inputToken.decimals,
                                  airdropSymbol,
                                )}
                          </td>
                        ) : null}
                      </tr>
                      {breakdownOpen && hasFlows && !row.isVault ? (
                        <tr className="bg-slate-950/40">
                          <td className="px-5 pb-4" colSpan={showAirdropColumn ? 7 : 6}>
                            <PendingAssetsBreakdown
                              chain={chain}
                              baseAssets={row.totalAssets}
                              borrowRepaySymbol={silo.borrowRepayToken?.symbol}
                              borrows={row.borrows}
                              debtAtSnapshot={row.debtAtSnapshot}
                              decimals={silo.inputToken.decimals}
                              deposits={row.deposits}
                              pendingAssets={row.pendingAssets}
                              repays={row.repays}
                              snapshotBlock={silo.snapshotBlock}
                              symbol={silo.inputToken.symbol}
                              totalBorrows={row.totalBorrows}
                              totalDeposits={row.totalDeposits}
                              totalRepays={row.totalRepays}
                              totalTransfersIn={row.totalTransfersIn}
                              totalTransfersOut={row.totalTransfersOut}
                              totalWithdrawals={row.totalWithdrawals}
                              transfers={row.transfers}
                              withdrawals={row.withdrawals}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
      {isExpanded ? <SectionMetaBar actions={metaActions} className="border-t border-white/10" title={metaTitle} /> : null}
    </div>
  );
}

function sortDepositors(rows: VaultDepositor[], sortState: TableSortState): VaultDepositor[] {
  return [...rows].sort((a, b) => {
    if (sortState.key === "address") {
      return compareStrings(a.address, b.address, sortState.direction);
    }
    if (sortState.key === "type") {
      return compareStrings(a.addressType, b.addressType, sortState.direction);
    }
    if (sortState.key === "withdrawals") {
      return compareValues(a.totalWithdrawals, b.totalWithdrawals, sortState.direction);
    }
    if (sortState.key === "pending") {
      return compareValues(a.pendingAssets, b.pendingAssets, sortState.direction);
    }
    // Sort the (Vault) assets column by vault shares: shares carry full precision,
    // whereas displayed assets can collide once rounded.
    return compareValues(a.vaultShares, b.vaultShares, sortState.direction);
  });
}

function DepositorTable({
  chain,
  rows,
  silo,
  vaultAddress,
  sortState,
  addressFilter,
  addressTypeFilter,
  airdropPlan,
  showAirdropColumn,
  airdropSymbol,
  tableTotals,
  onSort,
  hideTypeFilter = false,
}: {
  chain: string;
  rows: VaultDepositor[];
  silo: SiloSnapshot;
  vaultAddress: string;
  sortState: TableSortState;
  addressFilter: string;
  addressTypeFilter: string;
  airdropPlan: AirdropPlan | null;
  showAirdropColumn: boolean;
  airdropSymbol: string;
  tableTotals: AggregateTotals;
  onSort: (key: TableSortKey) => void;
  hideTypeFilter?: boolean;
}) {
  const [expandedBreakdowns, setExpandedBreakdowns] = useState<Record<string, boolean>>({});
  const [showOnlyPlusMinus, setShowOnlyPlusMinus] = useState(false);
  const needle = addressFilter.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    const addressMatches = needle ? row.address.toLowerCase().includes(needle) : true;
    const typeMatches = hideTypeFilter || addressTypeFilter === "all" || row.addressType === addressTypeFilter;
    return addressMatches && typeMatches;
  });
  const filteredRows = sortDepositors(
    showOnlyPlusMinus ? visibleRows.filter((row) => hasFlowActivity(row)) : visibleRows,
    sortState,
  );

  function toggleBreakdown(address: string) {
    setExpandedBreakdowns((current) => ({ ...current, [address]: !current[address] }));
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-white/10 text-sm">
          <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-5 py-3 font-medium">
                <SortHeader label="Address" sortKey="address" sortState={sortState} onClick={onSort} />
              </th>
              <th className="px-5 py-3 font-medium">
                <SortHeader label="Type" sortKey="type" sortState={sortState} onClick={onSort} />
              </th>
              <th className="px-5 py-3 text-right font-medium">
                <ColumnHeaderSum
                  value={`${formatUnitsRounded(tableTotals.assets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                />
                <SortHeader align="right" label="Vault assets" sortKey="assets" sortState={sortState} onClick={onSort} />
              </th>
              <th className="px-5 py-3 text-right font-medium">
                <ColumnHeaderSum
                  value={`${formatUnitsRounded(tableTotals.withdrawals, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                />
                <SortHeader
                  align="right"
                  label="Withdrawals"
                  sortKey="withdrawals"
                  sortState={sortState}
                  onClick={onSort}
                />
              </th>
              <th className="px-5 py-3 text-right font-medium">
                <ColumnHeaderSum
                  value={`${formatUnitsRounded(tableTotals.pending, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                />
                <SortHeader align="right" label="Pending assets" sortKey="pending" sortState={sortState} onClick={onSort} />
              </th>
              <th className="w-24 px-2 py-3 text-center font-medium">
                <div className="flex flex-col items-center gap-1">
                  <span className="text-2xl leading-none normal-case tracking-normal">±</span>
                  <input
                    aria-label="Show only rows with plus minus details"
                    checked={showOnlyPlusMinus}
                    className="h-4 w-4 rounded border-white/20 bg-slate-950 accent-emerald-300"
                    type="checkbox"
                    onChange={(event) => setShowOnlyPlusMinus(event.target.checked)}
                  />
                </div>
              </th>
              {showAirdropColumn ? <th className="px-5 py-3 text-right font-medium">Airdrop</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-200">
            {filteredRows.length === 0 ? (
              <tr>
                <td className="px-5 py-6 text-center text-sm text-slate-400" colSpan={showAirdropColumn ? 7 : 6}>
                  {showOnlyPlusMinus
                    ? "No vault depositors with plus/minus match the current filters."
                    : "No vault depositors match the current address filter."}
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const breakdownOpen = Boolean(expandedBreakdowns[row.address]);
                const hasFlows = hasFlowActivity(row);
                return (
                  <Fragment key={row.address}>
                    <tr className="hover:bg-white/[0.03]">
                      <td className="px-5 py-4">
                        <AddressLink address={row.address} chain={chain} />
                      </td>
                      <td className="px-5 py-4">
                        <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{row.addressType}</span>
                      </td>
                      <td className="px-5 py-4 text-right font-mono tabular-nums">
                        <div>
                          {formatUnitsRounded(row.attributedSiloAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{row.vaultShares.toString()} shares</div>
                      </td>
                      <td className="px-5 py-4 text-right font-mono tabular-nums">
                        {formatUnitsRounded(row.totalWithdrawals, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                      </td>
                      <td className="px-5 py-4 text-right font-mono tabular-nums">
                        <span className={row.pendingAssets < ZERO ? "text-rose-300" : undefined}>
                          {formatUnitsRounded(row.pendingAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                        </span>
                      </td>
                      <td className="px-2 py-4 text-center font-mono tabular-nums">
                        {hasFlows ? (
                          <button
                            className="font-sans text-lg font-semibold leading-none text-emerald-200 transition hover:text-emerald-100"
                            title={breakdownOpen ? "Hide flow details" : "Show flow details"}
                            type="button"
                            onClick={() => toggleBreakdown(row.address)}
                          >
                            <span aria-hidden="true">±</span>
                            <span className="sr-only">Toggle pending assets calculation details</span>
                          </button>
                        ) : null}
                      </td>
                      {showAirdropColumn ? (
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          {airdropPlan
                            ? formatAirdropCell(
                                airdropPlan,
                                vaultLeafKey(silo.address, vaultAddress, row.address),
                                silo.inputToken.decimals,
                                airdropSymbol,
                              )
                            : "--"}
                        </td>
                      ) : null}
                    </tr>
                    {breakdownOpen && hasFlows ? (
                      <tr className="bg-slate-950/40">
                        <td className="px-5 pb-4" colSpan={showAirdropColumn ? 7 : 6}>
                          <PendingAssetsBreakdown
                            chain={chain}
                            baseAssets={row.attributedSiloAssets}
                            decimals={silo.inputToken.decimals}
                            deposits={row.deposits}
                            pendingAssets={row.pendingAssets}
                            symbol={silo.inputToken.symbol}
                            totalDeposits={row.totalDeposits}
                            totalTransfersIn={row.totalTransfersIn}
                            totalTransfersOut={row.totalTransfersOut}
                            totalWithdrawals={row.totalWithdrawals}
                            transfers={row.transfers}
                            withdrawals={row.withdrawals}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function isVaultWarning(vault: VaultSnapshot): boolean {
  return vault.status !== "ok" || !vault.indexedInSubgraph || !vault.inWithdrawQueue;
}

function siloMatchesAddress(silo: SiloSnapshot, needle: string): boolean {
  if (!needle) {
    return true;
  }
  if (silo.directLenders.some((lender) => lender.address.toLowerCase().includes(needle))) {
    return true;
  }
  return silo.vaults.some(
    (vault) =>
      !isVaultWarning(vault) &&
      vault.depositors.some((depositor) => depositor.address.toLowerCase().includes(needle)),
  );
}

function warningLabel(vault: VaultSnapshot): string {
  if (!vault.inWithdrawQueue) {
    return "Vault is not in the withdraw queue";
  }
  if (!vault.indexedInSubgraph || vault.status === "vault_not_indexed") {
    return "Vault not indexed";
  }
  return `Vault status: ${vault.status}`;
}

function vaultElementId(address: string): string {
  return `vault-${address.toLowerCase()}`;
}

// Renders the kind suffix of a silo title: "Silo #id" for silos, or
// "Vault (detached)" for manually-tracked SiloVault targets, where "(detached)" is
// shown in a smaller, dimmer font.
function SiloKindLabel({ silo }: { silo: SiloSnapshot }) {
  if (silo.siloType === "silo_vault") {
    return (
      <>
        Vault <span className="text-[0.7em] font-normal text-slate-500">(detached)</span>
      </>
    );
  }
  return <>Silo {silo.siloId ? `#${silo.siloId}` : "#--"}</>;
}

// Marks a two-way (borrow/repay) silo: two horizontal arrows, top pointing left and bottom
// pointing right, in amber to match the borrower row highlight.
function TwoWayIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`inline-block h-3.5 w-3.5 shrink-0 text-amber-300 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <title>Two-way silo (lenders and borrowers)</title>
      <path d="M20 8H4m0 0 4-4M4 8l4 4" />
      <path d="M4 16h16m0 0-4-4m4 4-4 4" />
    </svg>
  );
}

function addCsvAirdrop(csvAirdrops: Map<string, bigint | null>, address: string, amount: bigint | null) {
  const current = csvAirdrops.get(address);
  if (amount === null) {
    if (current === undefined) {
      csvAirdrops.set(address, null);
    }
    return;
  }
  csvAirdrops.set(address, (current ?? ZERO) + amount);
}

function isAirdropEligible(addressType: string, includeOtherContracts: boolean): boolean {
  return includeOtherContracts || addressType !== OTHER_CONTRACT_TYPE;
}

// Distinct addresses whose aggregated allocation is strictly greater than zero in
// raw smallest units (not rounded for display), so a 1-wei recipient still counts.
function countPositiveRecipients(csvAirdrops: Map<string, bigint | null>): number {
  let count = 0;
  for (const amount of csvAirdrops.values()) {
    if (amount !== null && amount > ZERO) {
      count += 1;
    }
  }
  return count;
}

function formatAirdropCell(airdropPlan: AirdropPlan | null, leafKey: string, decimals: number, symbol: string): string {
  if (!airdropPlan) {
    return "--";
  }
  if (airdropPlan.excludedLeafKeys.has(leafKey)) {
    return "Not available";
  }
  return `${formatUnits(airdropPlan.byLeafKey.get(leafKey) ?? ZERO, decimals, 6)} ${symbol}`;
}

type AirdropLeaf = { key: string; address: string; pending: bigint };

function buildAirdropPlan(
  allSilos: SiloSnapshot[],
  airdropRaw: bigint,
  includeOtherContracts: boolean,
): AirdropPlan {
  const byLeafKey = new Map<string, bigint>();
  const csvAirdrops = new Map<string, bigint | null>();
  const excludedLeafKeys = new Set<string>();

  // Collect every recipient we will pay (eligible leaves) plus the assets we cannot
  // attribute to anyone (warning-vault assets). Excluded `contract_other` pending is
  // intentionally left out of every denominator so its share is redistributed to
  // eligible recipients.
  const eligibleLeaves: AirdropLeaf[] = [];
  let eligiblePending = ZERO;
  let nonAttributableAssets = ZERO;

  for (const silo of allSilos) {
    for (const lender of silo.directLenders) {
      if (lender.isVault) {
        continue;
      }
      const leafKey = directLeafKey(silo.address, lender.address);
      if (!isAirdropEligible(lender.addressType, includeOtherContracts)) {
        excludedLeafKeys.add(leafKey);
        addCsvAirdrop(csvAirdrops, lender.address, null);
        continue;
      }
      // Clamp negative pending (unreconciled interest/transfers) to zero so it neither
      // shrinks the denominator nor produces a negative allocation.
      const pending = lender.pendingAssets > ZERO ? lender.pendingAssets : ZERO;
      eligibleLeaves.push({ key: leafKey, address: lender.address, pending });
      eligiblePending += pending;
    }

    for (const vault of silo.vaults) {
      if (isVaultWarning(vault)) {
        nonAttributableAssets += vault.vaultSiloAssets;
        continue;
      }
      for (const depositor of vault.depositors) {
        const leafKey = vaultLeafKey(silo.address, vault.address, depositor.address);
        if (!isAirdropEligible(depositor.addressType, includeOtherContracts)) {
          excludedLeafKeys.add(leafKey);
          addCsvAirdrop(csvAirdrops, depositor.address, null);
          continue;
        }
        const pending = depositor.pendingAssets > ZERO ? depositor.pendingAssets : ZERO;
        eligibleLeaves.push({ key: leafKey, address: depositor.address, pending });
        eligiblePending += pending;
      }
    }
  }

  // The airdrop rate is taken over eligible pending plus non-attributable assets, so the
  // slice that "belongs" to warning vaults is held back rather than over-paid to others.
  const rateBase = eligiblePending + nonAttributableAssets;

  if (airdropRaw === ZERO || rateBase === ZERO || eligiblePending === ZERO) {
    for (const leaf of eligibleLeaves) {
      byLeafKey.set(leaf.key, ZERO);
      addCsvAirdrop(csvAirdrops, leaf.address, ZERO);
    }
    return {
      airdropRaw,
      byLeafKey,
      csvAirdrops,
      excludedLeafKeys,
      totalPendingAssets: rateBase,
      distributed: ZERO,
      undistributed: airdropRaw,
      nonAttributableAssets,
      recipientCount: 0,
    };
  }

  // Amount actually payable to eligible recipients (full smallest-unit precision).
  const distributable = (airdropRaw * eligiblePending) / rateBase;

  // Largest-remainder apportionment: floor each share, then hand the leftover smallest
  // units to the recipients with the biggest fractional remainders. This distributes
  // `distributable` exactly, with no precision loss beyond what is mathematically owed.
  const allocations = eligibleLeaves.map((leaf) => {
    const numerator = distributable * leaf.pending;
    return {
      leaf,
      airdrop: numerator / eligiblePending,
      remainder: numerator % eligiblePending,
    };
  });

  const allocated = allocations.reduce((sum, item) => sum + item.airdrop, ZERO);
  let leftover = distributable - allocated;

  if (leftover > ZERO) {
    const ranked = [...allocations].sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return a.remainder > b.remainder ? -1 : 1;
      }
      if (a.leaf.pending !== b.leaf.pending) {
        return a.leaf.pending > b.leaf.pending ? -1 : 1;
      }
      return a.leaf.key < b.leaf.key ? -1 : 1;
    });
    for (let index = 0; index < ranked.length && leftover > ZERO; index += 1) {
      ranked[index].airdrop += 1n;
      leftover -= 1n;
    }
  }

  let distributed = ZERO;
  for (const { leaf, airdrop } of allocations) {
    byLeafKey.set(leaf.key, airdrop);
    addCsvAirdrop(csvAirdrops, leaf.address, airdrop);
    distributed += airdrop;
  }

  return {
    airdropRaw,
    byLeafKey,
    csvAirdrops,
    excludedLeafKeys,
    totalPendingAssets: rateBase,
    distributed,
    undistributed: airdropRaw > distributed ? airdropRaw - distributed : ZERO,
    nonAttributableAssets,
    recipientCount: countPositiveRecipients(csvAirdrops),
  };
}

function VaultCard({
  chain,
  networkLabel,
  vault,
  silo,
  expanded,
  onToggle,
  addressFilter,
  addressTypeFilter,
  airdropPlan,
  showAirdropColumn,
  airdropSymbol,
  forceExpanded = false,
  hideTypeFilter = false,
  navPrevId,
  navNextId,
}: {
  chain: string;
  networkLabel: string;
  vault: VaultSnapshot;
  silo: SiloSnapshot;
  expanded: boolean;
  onToggle: () => void;
  addressFilter: string;
  addressTypeFilter: string;
  airdropPlan: AirdropPlan | null;
  showAirdropColumn: boolean;
  airdropSymbol: string;
  forceExpanded?: boolean;
  hideTypeFilter?: boolean;
  navPrevId?: string;
  navNextId?: string;
}) {
  const { decimal: csvDecimal } = useCsvFormat();
  const [depositorSort, setDepositorSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const hasWarning = isVaultWarning(vault);
  const isExpanded = forceExpanded || expanded;
  const depositorTotals = sumDepositorTotals(vault.depositors);
  const vaultSharesValid =
    vault.vaultTotalSupply !== null && depositorTotals.shares === vault.vaultTotalSupply && vault.status === "ok";
  const unavailableAirdrop =
    hasWarning && airdropPlan && airdropPlan.totalPendingAssets > ZERO
      ? (airdropPlan.airdropRaw * vault.vaultSiloAssets) / airdropPlan.totalPendingAssets
      : ZERO;

  // Vault metadata (name + address + nav + assets/shares summary). Rendered at the
  // top of the card and repeated at the bottom so long depositor tables stay labelled.
  const metaSection = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className={hasWarning ? "font-semibold text-amber-100" : "font-semibold text-emerald-100"}>
            {vault.name || "Unnamed SiloVault"}
          </h3>
          <AddressLink address={vault.address} chain={chain} />
          <SectionNavButtons nextId={navNextId} prevId={navPrevId} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!hasWarning && vault.depositors.length > 0 ? (
            <button
              className="rounded-full border border-emerald-300/30 px-3 py-1 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-300/10"
              type="button"
              onClick={() => {
                const dec = silo.inputToken.decimals;
                const rows = [
                  PENDING_CSV_HEADER,
                  ...vault.depositors.map((depositor) => [
                    networkLabel,
                    silo.address,
                    vault.address,
                    depositor.address,
                    depositor.addressType,
                    formatPendingForCsv(depositor.pendingAssets, dec, csvDecimal),
                  ]),
                ];
                downloadCsv(`${chain}-${vault.address}-depositors.csv`, rows);
              }}
            >
              Export CSV
            </button>
          ) : null}
          {hasWarning ? (
            <span className="rounded-full bg-amber-300/20 px-3 py-1 text-sm text-amber-100">{warningLabel(vault)}</span>
          ) : forceExpanded ? null : (
            <button
              className="rounded-full bg-emerald-300/20 px-3 py-1 text-sm text-emerald-100 transition hover:bg-emerald-300/30"
              type="button"
              onClick={onToggle}
            >
              {isExpanded ? "Collapse" : "Expand"} depositors
            </button>
          )}
        </div>
      </div>
      <p
        className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${
          hasWarning ? "text-amber-100/70" : "text-emerald-100/70"
        }`}
      >
        <span>
          Vault assets: {formatUnitsRounded(vault.vaultSiloAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
        </span>
        {vault.vaultTotalSupply !== null ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 font-mono">
            <span>
              {vault.vaultTotalSupply.toString()} <span className="font-sans">shares</span>
            </span>
            <ValidationBadge
              inline
              label="Sanity check"
              message={`Vault shares equal sum of ${vault.depositors.length} depositor shares`}
              valid={vaultSharesValid}
            />
          </span>
        ) : null}
      </p>
    </>
  );

  return (
    <div
      id={vaultElementId(vault.address)}
      className={`rounded-3xl border p-5 ${
        hasWarning ? "border-amber-300/30 bg-amber-300/[0.08]" : "border-emerald-300/20 bg-emerald-300/[0.06]"
      }`}
    >
      {metaSection}
      {!hasWarning ? (
        <p className="mt-3 inline-flex max-w-3xl items-start gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3.5 py-1.5 text-xs font-medium leading-5 text-amber-200">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This vault can lend into multiple silos. We do not determine which market funds a withdrawal or pending
            balance for its depositors — any outstanding amount is treated as remaining through{" "}
            <span className="font-semibold text-amber-100">
              Silo {silo.siloId ? `#${silo.siloId}` : "#--"}
            </span>{" "}
            (<AddressLink bareCopy address={silo.address} chain={chain} />) only.
          </span>
        </p>
      ) : null}
      {hasWarning ? (
        <div className="mt-4 max-w-2xl space-y-2 text-sm leading-6 text-amber-100/75">
          <p>
            Depositors cannot be enumerated for this vault. Its assets are shown here so airdrop calculations can surface
            the non-attributable amount.
          </p>
          {unavailableAirdrop > ZERO ? (
            <p className="font-semibold text-amber-100">
              Undistributed from this vault: {formatUnits(unavailableAirdrop, silo.inputToken.decimals)}{" "}
              {airdropSymbol}
            </p>
          ) : null}
        </div>
      ) : isExpanded ? (
        <div className="mt-4">
          <DepositorTable
            addressFilter={addressFilter}
            addressTypeFilter={addressTypeFilter}
            chain={chain}
            hideTypeFilter={hideTypeFilter}
            airdropPlan={airdropPlan}
            airdropSymbol={airdropSymbol}
            rows={vault.depositors}
            showAirdropColumn={showAirdropColumn}
            silo={silo}
            sortState={depositorSort}
            tableTotals={depositorTotals}
            vaultAddress={vault.address}
            onSort={(key) => setDepositorSort((current) => nextSortState(current, key))}
          />
          <div
            className={`mt-4 border-t pt-4 ${
              hasWarning ? "border-amber-300/20" : "border-emerald-300/20"
            }`}
          >
            {metaSection}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AppHeader({ subtitle }: { subtitle?: string }) {
  const { slug, title, description, snapshotBlock } = useActiveCategory();
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  return (
    <header className="border-b border-white/10 pb-8">
      <div>
        <a
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 transition hover:text-emerald-200"
          href={landingHomePath()}
        >
          <ChevronIcon className="rotate-90" />
          All snapshots
        </a>
        <div className="mt-3 flex flex-wrap items-baseline gap-3">
          <a
            className="text-3xl font-semibold tracking-tight text-white transition hover:text-emerald-200 sm:text-4xl"
            href={categoryHomePath(slug)}
          >
            {title}
          </a>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-slate-400">
            v{APP_VERSION}
          </span>
        </div>
        {subtitle ? (
          <p className="mt-0.5 mb-2 max-w-2xl text-sm leading-6 text-slate-400">{subtitle}</p>
        ) : (
          <p className="mt-0.5 mb-2 max-w-2xl text-sm leading-6 text-slate-400">
            Static, no-RPC snapshot explorer for direct holders and vault depositors across chains.
          </p>
        )}
        {subtitle ? null : (
          <div className="mt-4 max-w-3xl">
            <button
              aria-expanded={descriptionOpen}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-300 transition hover:text-emerald-200"
              onClick={() => setDescriptionOpen((open) => !open)}
              type="button"
            >
              {descriptionOpen ? "Hide info about this snapshot" : "Show info about this snapshot"}
              <ChevronIcon className={descriptionOpen ? "rotate-180 transition-transform" : "transition-transform"} />
            </button>
            {descriptionOpen ? (
              <div className="mt-3 space-y-3 border-l-2 border-emerald-400/30 pl-4 text-[0.95rem] italic leading-7 text-slate-300">
                {description.map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <p className="mt-3 inline-flex max-w-3xl items-start gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3.5 py-1.5 text-xs font-medium leading-5 text-amber-200">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Recovery calculations are based on balances at block{" "}
            <span className="font-mono font-semibold text-amber-100">{snapshotBlock.toString()}</span>. Interest accrued
            after this block is not included. Any negative pending balances are attributable to unaccounted
            post-snapshot interest and may also reflect interest over-accrual related to the Stream Finance incident.
          </span>
        </p>
      </div>
    </header>
  );
}

function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 240);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <button
      className="fixed bottom-6 right-6 z-50 rounded-full bg-emerald-300 px-4 py-2 text-xs font-semibold text-slate-950 shadow-lg transition hover:bg-emerald-200"
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      To top
    </button>
  );
}

function firstPopulatedChain(chains: ChainSnapshot[]): ChainSnapshot | undefined {
  return chains.find((chain) => chain.silos.length > 0) ?? chains[0];
}

function getInitialExplorerSelection(chains: ChainSnapshot[]): { chainName: string; siloAddress: string } {
  const fallbackChain = firstPopulatedChain(chains);
  const fallback = {
    chainName: fallbackChain?.chain ?? "",
    siloAddress: fallbackChain?.silos[0]?.address ?? "",
  };
  const selection = parseExplorerSelectionFromUrl();
  if (!selection.address) {
    return fallback;
  }
  const match = findSiloByAddress(chains, selection.address, selection.chain);
  if (!match) {
    return fallback;
  }
  return { chainName: match.chain.chain, siloAddress: match.silo.address };
}

function getInitialCategory(chains: ChainSnapshot[]): SiloCategory {
  const selection = getInitialExplorerSelection(chains);
  const match = findSiloByAddress(chains, selection.siloAddress, selection.chainName);
  return match ? siloCategory(match.silo) : "usdc";
}

// Every (chain, silo) pair across the category, so silos from different chains render in a
// single uniform list (each tagged with its network).
function flattenSilos(chains: ChainSnapshot[]): { chain: ChainSnapshot; silo: SiloSnapshot }[] {
  return chains.flatMap((chain) => chain.silos.map((silo) => ({ chain, silo })));
}

function availableCategories(silos: SiloSnapshot[]): SiloCategory[] {
  const present = new Set(silos.map(siloCategory));
  return SILO_CATEGORY_ORDER.filter((category) => present.has(category));
}

function resetAirdropsState(
  setDistributeAirdropsEnabled: (value: boolean) => void,
  setAirdropInput: (value: string) => void,
  setIncludeOtherContracts: (value: boolean) => void,
) {
  setDistributeAirdropsEnabled(false);
  setAirdropInput("");
  setIncludeOtherContracts(false);
}

function SiloDetailPanel({
  chain,
  silo,
  addressFilter,
  setAddressFilter,
  buildFilterShareUrl,
  addressTypeFilter,
  setAddressTypeFilter,
  addressTypes,
  directSort,
  setDirectSort,
  directExpanded,
  setDirectExpanded,
  expandedVaults,
  setExpandedVaults,
  distributeAirdropsEnabled,
  setDistributeAirdropsEnabled,
  airdropInput,
  setAirdropInput,
  includeOtherContracts,
  setIncludeOtherContracts,
  airdropPlan,
  airdropInputInvalid,
  showAirdropColumn,
  categoryLabel,
  airdropSiloCount = 0,
  defaultAirdropAmount = "",
  showAirdrops = true,
  showTypeFilter = true,
  showExpandControls = true,
  forceExpanded = false,
  showConnectWallet = false,
}: {
  chain: ChainSnapshot;
  silo: SiloSnapshot;
  addressFilter: string;
  setAddressFilter: (value: string) => void;
  // Builds the relative shareable URL for a given address filter, used for the
  // share/open shortcuts beside the address input.
  buildFilterShareUrl?: (filter: string) => string;
  addressTypeFilter: string;
  setAddressTypeFilter: (value: string) => void;
  addressTypes: string[];
  directSort: TableSortState;
  setDirectSort: (value: TableSortState | ((current: TableSortState) => TableSortState)) => void;
  directExpanded: boolean;
  setDirectExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  expandedVaults: Record<string, boolean>;
  setExpandedVaults: (value: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)) => void;
  distributeAirdropsEnabled: boolean;
  setDistributeAirdropsEnabled: (value: boolean) => void;
  airdropInput: string;
  setAirdropInput: (value: string) => void;
  includeOtherContracts: boolean;
  setIncludeOtherContracts: (value: boolean) => void;
  airdropPlan: AirdropPlan | null;
  airdropInputInvalid: boolean;
  showAirdropColumn: boolean;
  categoryLabel?: string;
  airdropSiloCount?: number;
  defaultAirdropAmount?: string;
  showAirdrops?: boolean;
  showTypeFilter?: boolean;
  showExpandControls?: boolean;
  forceExpanded?: boolean;
  showConnectWallet?: boolean;
}) {
  const { snapshotBlock, eventsToBlock, chains, slug, label: categoryName } = useActiveCategory();
  const { decimal: csvDecimal, setDecimal: setCsvDecimal } = useCsvFormat();
  const { account, connect, connecting, hasProvider } = useWallet(
    showConnectWallet ? setAddressFilter : undefined,
  );

  // Airdrops are paid in the category token, so airdrop amounts are labeled with the
  // category (USDC / ETH) rather than the individual silo's token symbol.
  const airdropSymbol = categoryLabel ?? silo.inputToken.symbol;
  const lenderNeedle = addressFilter.trim().toLowerCase();
  const typeMatches = (addressType: string) =>
    !showTypeFilter || addressTypeFilter === "all" || addressType === addressTypeFilter;
  const filterActive = lenderNeedle.length > 0 || (showTypeFilter && addressTypeFilter !== "all");
  const filteredLenders = silo.directLenders.filter((lender) => {
    const addressMatches = lenderNeedle ? lender.address.toLowerCase().includes(lenderNeedle) : true;
    return addressMatches && typeMatches(lender.addressType);
  });
  const visibleLenders = sortDirectLenders(filteredLenders, directSort);
  const visibleVaults = silo.vaults.filter((vault) => {
    if (!filterActive) {
      return true;
    }
    if (isVaultWarning(vault)) {
      return false;
    }
    return vault.depositors.some((depositor) => {
      const addressMatches = lenderNeedle ? depositor.address.toLowerCase().includes(lenderNeedle) : true;
      return addressMatches && typeMatches(depositor.addressType);
    });
  });
  const vaultWarnings = silo.vaults.filter(isVaultWarning).length;
  const hasVisibleFilterResults = !filterActive || visibleLenders.length > 0 || visibleVaults.length > 0;
  const directTableTotals = sumDirectLenderTotals(silo.directLenders);
  const tableSectionIds = ["direct-lenders", ...visibleVaults.map((vault) => vaultElementId(vault.address))];

  function expandAll() {
    setDirectExpanded(true);
    setExpandedVaults(Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])));
  }

  function collapseAll() {
    setDirectExpanded(false);
    setExpandedVaults(Object.fromEntries(silo.vaults.map((vault) => [vault.address, false])));
  }

  function jumpToVault(vaultAddress: string) {
    setExpandedVaults((current) => ({ ...current, [vaultAddress]: true }));
    window.requestAnimationFrame(() => {
      document.getElementById(vaultElementId(vaultAddress))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <section className="min-w-0 space-y-6">
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-slate-950/40">
        <div className="grid gap-6 xl:grid-cols-3 xl:items-start">
          <div className="xl:col-span-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium text-emerald-200">
              <span className="inline-flex items-center gap-1.5">
                {silo.inputToken.symbol} / <SiloKindLabel silo={silo} />
                {silo.isTwoSided ? <TwoWayIcon /> : null}
              </span>
              <NetworkBadge chainId={chain.chainId} />
              <AddressLink address={silo.address} chain={chain.chain} />
            </div>
            <h2 className="mt-2 text-3xl font-semibold text-white">
              {silo.isTwoSided ? "Silo lenders/borrowers details" : "Silo lenders details"}
            </h2>
            <p className="mt-2 text-sm">
              {eventsToBlock > snapshotBlock ? (
                <>
                  <span className="text-slate-500">Blocks from</span>{" "}
                  <span className="font-mono text-slate-200">{snapshotBlock.toString()}</span>{" "}
                  <span className="text-slate-500">to</span>{" "}
                  <span className="font-mono text-slate-200">{eventsToBlock.toString()}</span>
                </>
              ) : (
                <>
                  <span className="text-slate-500">On block</span>{" "}
                  <span className="font-mono text-slate-200">{snapshotBlock.toString()}</span>
                </>
              )}
            </p>
          </div>
          {showAirdrops ? (
            <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 xl:col-span-2">
              <label className="flex items-start gap-3 text-sm text-slate-300">
                <input
                  className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950 accent-emerald-300"
                  type="checkbox"
                  checked={distributeAirdropsEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setDistributeAirdropsEnabled(enabled);
                    if (enabled) {
                      // Pre-fill the per-category default so the airdrop is computed
                      // immediately on enable.
                      if (defaultAirdropAmount && !airdropInput.trim()) {
                        setAirdropInput(defaultAirdropAmount);
                        setDirectExpanded(true);
                        setExpandedVaults(Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])));
                      }
                    } else {
                      setAirdropInput("");
                      setIncludeOtherContracts(false);
                    }
                  }}
                />
                <span>
                  Distribute airdrops{categoryLabel ? ` (${categoryLabel})` : ""}
                  {airdropSiloCount > 0 ? (
                    <span className="text-slate-500">
                      {" "}
                      to {airdropSiloCount} {airdropSiloCount === 1 ? "silo" : "silos"}
                    </span>
                  ) : null}
                </span>
              </label>
              {distributeAirdropsEnabled ? (
                <>
                  <p className="mt-4 text-xs uppercase tracking-[0.22em] text-slate-500">
                    {categoryLabel ? `${categoryLabel} airdrop amount` : "Airdrop amount"}
                  </p>
                  <div className="mt-3 flex gap-3">
                    <input
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-300 outline-none placeholder:text-slate-600"
                      placeholder={`0.00 ${airdropSymbol}`}
                      value={airdropInput}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setAirdropInput(nextValue);
                        if (nextValue.trim()) {
                          setDirectExpanded(true);
                          setExpandedVaults(Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])));
                        }
                      }}
                    />
                    <button
                      className="rounded-xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
                      disabled={!airdropPlan || airdropPlan.airdropRaw === ZERO || airdropInputInvalid}
                      type="button"
                      onClick={() => {
                        if (!airdropPlan) {
                          return;
                        }
                        const rows = [["address", "raw_amount", "assets"]];
                        for (const [address, airdrop] of [...airdropPlan.csvAirdrops.entries()].sort(([a], [b]) =>
                          a.localeCompare(b),
                        )) {
                          rows.push([
                            address,
                            airdrop === null ? "" : airdrop.toString(),
                            airdrop === null ? "" : formatUnitsFixed(airdrop, silo.inputToken.decimals),
                          ]);
                        }
                        const csvLabel = (categoryLabel ?? silo.inputToken.symbol).toLowerCase();
                        downloadCsv(`${csvLabel}-snapshot-airdrops.csv`, rows);
                      }}
                    >
                      Download CSV
                    </button>
                  </div>
                  <label className="mt-3 flex items-start gap-3 text-xs leading-5 text-slate-300">
                    <input
                      className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950 accent-emerald-300"
                      type="checkbox"
                      checked={includeOtherContracts}
                      onChange={(event) => setIncludeOtherContracts(event.target.checked)}
                    />
                    <span>
                      Distribute to unrecognized contracts (`contract_other`). When disabled, these addresses stay in the
                      CSV with empty airdrop fields and their pending assets are redistributed to eligible recipients.
                    </span>
                  </label>
                  {airdropInputInvalid ? (
                    <p className="mt-3 text-xs text-amber-200">
                      Enter a non-negative amount with at most {silo.inputToken.decimals} decimals.
                    </p>
                  ) : airdropPlan && airdropPlan.airdropRaw > ZERO ? (
                    <div className="mt-3 space-y-1 text-xs text-slate-400">
                      <p>
                        {categoryLabel ? `${categoryLabel} distributed` : "Distributed"}:{" "}
                        {formatUnits(airdropPlan.distributed, silo.inputToken.decimals)} {airdropSymbol} to{" "}
                        {new Intl.NumberFormat("en-US").format(airdropPlan.recipientCount)}{" "}
                        {airdropPlan.recipientCount === 1 ? "user" : "users"}
                      </p>
                      {airdropPlan.undistributed > ZERO ? (
                        <p className="text-amber-200">
                          Undistributed: {formatUnits(airdropPlan.undistributed, silo.inputToken.decimals)}{" "}
                          {airdropSymbol}
                          {airdropPlan.nonAttributableAssets > ZERO
                            ? " because some vault assets have no enumerable depositors."
                            : " due to integer rounding."}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-slate-500">
                      Enter an amount to compute pro-rata airdrops across pending assets.
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 xl:col-span-2">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Export</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
                <DecimalSeparatorRadio decimal={csvDecimal} onChange={setCsvDecimal} />
                <button
                  className="rounded-xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
                  type="button"
                  onClick={() => {
                    const pairs = chains.flatMap((snapshotChain) =>
                      snapshotChain.silos.map((snapshotSilo) => ({ chain: snapshotChain, silo: snapshotSilo })),
                    );
                    downloadCsv(`${slug}-all-pending.csv`, buildPendingCsv(pairs, csvDecimal));
                  }}
                >
                  Export all (CSV)
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                All direct lenders and vault depositors across every silo and vault in the{" "}
                <span className="font-semibold text-slate-300">{categoryName}</span> category (all chains included).
              </p>
            </div>
          )}
        </div>
        <SiloMetrics silo={silo} />
      </div>

      <div
        className={`grid gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-5 ${
          showTypeFilter && showExpandControls
            ? "lg:grid-cols-[minmax(0,1.5fr)_minmax(12rem,0.7fr)_auto] lg:items-end"
            : showConnectWallet
              ? "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
              : ""
        }`}
      >
        <div className="min-w-0">
          <label className="text-xs uppercase tracking-[0.22em] text-slate-500" htmlFor="filter">
            Address filter
          </label>
          <AddressFilterInput
            id="filter"
            shareUrl={
              buildFilterShareUrl && addressFilter.trim()
                ? `${window.location.origin}${buildFilterShareUrl(addressFilter.trim())}`
                : undefined
            }
            value={addressFilter}
            onChange={setAddressFilter}
          />
        </div>
        {showTypeFilter ? (
          <div className="min-w-0">
            <label className="text-xs uppercase tracking-[0.22em] text-slate-500" htmlFor="type-filter">
              Type filter
            </label>
            <select
              id="type-filter"
              className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm text-slate-300 outline-none"
              value={addressTypeFilter}
              onChange={(event) => setAddressTypeFilter(event.target.value)}
            >
              <option value="all">All types</option>
              {addressTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {showExpandControls ? (
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <button
              className="rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
              type="button"
              onClick={expandAll}
            >
              Expand all
            </button>
            <button
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-slate-300 transition hover:bg-white/10"
              type="button"
              onClick={collapseAll}
            >
              Collapse all
            </button>
          </div>
        ) : null}
        {showConnectWallet ? (
          <div className="flex flex-wrap items-end gap-2 lg:justify-end">
            <button
              className="rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
              disabled={!hasProvider || connecting}
              type="button"
              onClick={() => void connect()}
            >
              {connecting ? "Connecting..." : account ? `Connected ${shortAddress(account)}` : "Connect Wallet"}
            </button>
          </div>
        ) : null}
      </div>

      {(!filterActive || visibleLenders.length > 0) ? (
        <HolderTable
          chain={chain.chain}
          expanded={directExpanded}
          forceExpanded={forceExpanded}
          navNextId={tableSectionIds.length > 1 ? tableSectionIds[1] : undefined}
          rows={visibleLenders}
          showAirdropColumn={showAirdropColumn}
          airdropSymbol={airdropSymbol}
          silo={silo}
          airdropPlan={airdropPlan}
          sortState={directSort}
          tableTotals={directTableTotals}
          onJumpToVault={jumpToVault}
          onExport={() => {
            const dec = silo.inputToken.decimals;
            const rows = [
              PENDING_CSV_HEADER,
              ...silo.directLenders
                .filter((row) => !row.isVault)
                .map((row) => [
                  chain.label,
                  silo.address,
                  "",
                  row.address,
                  row.addressType,
                  formatPendingForCsv(row.pendingAssets, dec, csvDecimal),
                ]),
            ];
            downloadCsv(`${chain.chain}-${silo.address}-direct-lenders.csv`, rows);
          }}
          onSort={(key) => setDirectSort((current) => nextSortState(current, key))}
          onToggle={() => setDirectExpanded((current) => !current)}
        />
      ) : null}

      {(!filterActive || visibleVaults.length > 0) ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Vaults</h2>
            <span className="text-sm text-slate-400">
              {filterActive
                ? `${visibleVaults.length} matching vault table${visibleVaults.length === 1 ? "" : "s"}`
                : `${silo.vaults.length - vaultWarnings} indexed, ${vaultWarnings} warning${
                    vaultWarnings === 1 ? "" : "s"
                  }`}
            </span>
          </div>
          {visibleVaults.length === 0 ? (
            <EmptyState message="No vault lender contracts are present in this snapshot." />
          ) : (
            visibleVaults.map((vault, index) => (
              <VaultCard
                key={vault.address}
                addressFilter={addressFilter}
                addressTypeFilter={addressTypeFilter}
                chain={chain.chain}
                networkLabel={chain.label}
                expanded={forceExpanded || (expandedVaults[vault.address] ?? index < DEFAULT_EXPANDED_LIMIT)}
                forceExpanded={forceExpanded}
                hideTypeFilter={!showTypeFilter}
                navNextId={index + 2 < tableSectionIds.length ? tableSectionIds[index + 2] : undefined}
                navPrevId={tableSectionIds[index]}
                airdropPlan={airdropPlan}
                airdropSymbol={airdropSymbol}
                showAirdropColumn={showAirdropColumn}
                silo={silo}
                vault={vault}
                onToggle={() =>
                  setExpandedVaults((current) => ({
                    ...current,
                    [vault.address]: !(current[vault.address] ?? index < DEFAULT_EXPANDED_LIMIT),
                  }))
                }
              />
            ))
          )}
        </div>
      ) : null}
      {!hasVisibleFilterResults ? (
        <EmptyState message="No tables contain addresses matching the current filter." />
      ) : null}
      <ScrollToTopButton />
    </section>
  );
}

function ExplorerView() {
  const { chains, slug, airdropDefaults, airdropEnabled } = useActiveCategory();

  // Silos from every chain in this category, rendered in one uniform list. Each pair keeps
  // its chain so the network badge and category-scoped links resolve correctly.
  const allPairs = flattenSilos(chains);
  const allSilos = allPairs.map((pair) => pair.silo);

  const [selectedChainName, setSelectedChainName] = useState(() => getInitialExplorerSelection(chains).chainName);
  const [selectedSiloAddress, setSelectedSiloAddress] = useState(() => getInitialExplorerSelection(chains).siloAddress);
  const [selectedCategory, setSelectedCategory] = useState<SiloCategory>(() => getInitialCategory(chains));
  const [addressFilter, setAddressFilter] = useState(() => parseFilterFromUrl());
  const [addressTypeFilter, setAddressTypeFilter] = useState("all");
  const [directSort, setDirectSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const [directExpanded, setDirectExpanded] = useState(true);
  const [expandedVaults, setExpandedVaults] = useState<Record<string, boolean>>({});
  const [distributeAirdropsEnabled, setDistributeAirdropsEnabled] = useState(false);
  const [airdropInput, setAirdropInput] = useState("");
  const [includeOtherContracts, setIncludeOtherContracts] = useState(false);

  const assetCategories = availableCategories(allSilos);
  const activeCategory = assetCategories.includes(selectedCategory) ? selectedCategory : (assetCategories[0] ?? "usdc");
  // Bucketing by token category (USDC/ETH) only exists to scope an airdrop. Without an
  // airdrop we drop the split entirely: show every silo (all categories) at once and hide
  // the switcher.
  const categoryPairs = airdropEnabled
    ? allPairs.filter(({ silo }) => siloCategory(silo) === activeCategory)
    : allPairs;
  const categoryLenderCount = countLenders(categoryPairs.map((pair) => pair.silo));
  const addressNeedle = addressFilter.trim().toLowerCase();
  const matchedPairs = addressNeedle
    ? categoryPairs.filter(({ silo }) => siloMatchesAddress(silo, addressNeedle))
    : categoryPairs;
  const selectedPair =
    matchedPairs.find((pair) => pair.silo.address === selectedSiloAddress && pair.chain.chain === selectedChainName) ??
    matchedPairs[0] ??
    categoryPairs[0];
  const selectedSilo = selectedPair?.silo;
  const selectedChain = selectedPair?.chain;
  // Airdrops are distributed across every silo in the active asset category (across all chains).
  const airdropSilos = allPairs.filter(({ silo }) => siloCategory(silo) === activeCategory).map((pair) => pair.silo);
  const addressTypes = selectedSilo
    ? Array.from(
        new Set([
          ...selectedSilo.directLenders.map((lender) => lender.addressType),
          ...selectedSilo.vaults.flatMap((vault) => vault.depositors.map((depositor) => depositor.addressType)),
        ]),
      ).sort((a, b) => a.localeCompare(b))
    : [];
  const airdropRaw = selectedSilo ? parseUnits(airdropInput, selectedSilo.inputToken.decimals) : null;
  const airdropInputInvalid = airdropInput.trim() !== "" && airdropRaw === null;
  const airdropPlan =
    selectedSilo && airdropRaw !== null
      ? buildAirdropPlan(airdropSilos, airdropRaw, includeOtherContracts)
      : null;
  const showAirdropColumn =
    airdropEnabled && distributeAirdropsEnabled && airdropRaw !== null && airdropRaw > ZERO;

  function syncSelectionUrl(chainName: string, siloAddress: string, replace = false) {
    if (!siloAddress) {
      return;
    }
    const url = buildExplorerSelectionUrl(slug, chainName, siloAddress, addressFilter);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === url) {
      return;
    }
    if (replace) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
  }

  // Reflect the current selection in the address bar on first load so the URL is
  // always shareable, without adding a spurious history entry.
  useEffect(() => {
    syncSelectionUrl(selectedChainName, selectedSiloAddress, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the address filter reflected in the URL (replace, so typing doesn't
  // flood the history stack) so the exact filtered view is shareable.
  useEffect(() => {
    syncSelectionUrl(selectedChainName, selectedSiloAddress, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressFilter]);

  // Keep selection in sync with browser back/forward navigation.
  useEffect(() => {
    function handlePopState() {
      const selection = getInitialExplorerSelection(chains);
      setSelectedChainName(selection.chainName);
      setSelectedSiloAddress(selection.siloAddress);
      setAddressFilter(parseFilterFromUrl());
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [chains]);

  function selectCategory(category: SiloCategory) {
    if (category === activeCategory) {
      return;
    }
    const nextPair = allPairs.find(({ silo }) => siloCategory(silo) === category);
    const nextChainName = nextPair?.chain.chain ?? "";
    const nextSiloAddress = nextPair?.silo.address ?? "";
    setSelectedCategory(category);
    setSelectedChainName(nextChainName);
    setSelectedSiloAddress(nextSiloAddress);
    setAddressTypeFilter("all");
    setDirectExpanded(true);
    setExpandedVaults({});
    resetAirdropsState(setDistributeAirdropsEnabled, setAirdropInput, setIncludeOtherContracts);
    syncSelectionUrl(nextChainName, nextSiloAddress);
  }

  function selectSilo(chainName: string, siloAddress: string) {
    // Switching silos within the same token keeps the active distribution so the
    // airdrops panel and airdrop column stay visible.
    setSelectedChainName(chainName);
    setSelectedSiloAddress(siloAddress);
    setAddressTypeFilter("all");
    setDirectExpanded(true);
    setExpandedVaults({});
    syncSelectionUrl(chainName, siloAddress);
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <AppHeader />

        <div className="min-w-0 space-y-6 py-8">
          <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-slate-950/30 sm:p-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Silos</p>
                  {airdropEnabled && assetCategories.length > 0 ? (
                    <div className="inline-flex rounded-full border border-white/10 bg-white/[0.03] p-0.5">
                      {assetCategories.map((category) => (
                        <button
                          key={category}
                          aria-pressed={activeCategory === category}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                            activeCategory === category
                              ? "bg-emerald-300 text-slate-950 shadow-sm shadow-emerald-500/20"
                              : "text-slate-300 hover:text-emerald-200"
                          }`}
                          type="button"
                          onClick={() => selectCategory(category)}
                        >
                          {SILO_CATEGORY_LABELS[category]}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <span className="text-xs uppercase tracking-[0.22em] text-slate-500">
                    Total lenders{" "}
                    <span className="font-mono text-sm normal-case tracking-normal text-slate-200">
                      {new Intl.NumberFormat("en-US").format(categoryLenderCount)}
                    </span>
                  </span>
                </div>
                <span className="rounded-full bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
                  {matchedPairs.length} silo{matchedPairs.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-3 flex min-w-0 flex-wrap gap-3">
                {categoryPairs.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-slate-500">
                    No silos are currently bundled for this snapshot.
                  </div>
                ) : matchedPairs.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-slate-500">
                    No silos contain an address matching the current filter.
                  </div>
                ) : (
                  matchedPairs.map(({ chain, silo }) => {
                    const isSelected =
                      selectedChain?.chain === chain.chain && selectedSilo?.address === silo.address;
                    return (
                      <div
                        key={`${chain.chain}-${silo.address}`}
                        className={`min-w-0 rounded-2xl border px-4 py-3 text-left transition ${
                          isSelected
                            ? "border-emerald-300/40 bg-emerald-300/10"
                            : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                        }`}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectSilo(chain.chain, silo.address)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectSilo(chain.chain, silo.address);
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-semibold">
                            {silo.inputToken.symbol} <SiloKindLabel silo={silo} />
                          </span>
                          {silo.isTwoSided ? <TwoWayIcon /> : null}
                          {isSelected ? (
                            <span className="shrink-0 rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                          <NetworkBadge chainId={chain.chainId} />
                          <AddressLink address={silo.address} chain={chain.chain} showSiloPageLink />
                        </div>
                        {showAirdropColumn && airdropPlan ? (
                          <div className="mt-1 text-xs text-slate-400">
                            Airdrop:{" "}
                            <span className="font-mono text-slate-200">
                              {formatUnits(
                                siloDistributedTotal(silo, airdropPlan),
                                selectedSilo?.inputToken.decimals ?? silo.inputToken.decimals,
                              )}{" "}
                              {SILO_CATEGORY_LABELS[activeCategory]}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>

          {selectedSilo && selectedChain ? (
            <SiloDetailPanel
              addressFilter={addressFilter}
              buildFilterShareUrl={(filter) =>
                buildExplorerSelectionUrl(slug, selectedChain.chain, selectedSilo.address, filter)
              }
              addressTypeFilter={addressTypeFilter}
              addressTypes={addressTypes}
              airdropSiloCount={airdropSilos.length}
              categoryLabel={airdropEnabled ? SILO_CATEGORY_LABELS[activeCategory] : undefined}
              chain={selectedChain}
              defaultAirdropAmount={airdropDefaults[activeCategory] ?? ""}
              directExpanded={directExpanded}
              directSort={directSort}
              distributeAirdropsEnabled={distributeAirdropsEnabled}
              expandedVaults={expandedVaults}
              includeOtherContracts={includeOtherContracts}
              airdropInput={airdropInput}
              airdropInputInvalid={airdropInputInvalid}
              airdropPlan={airdropPlan}
              setAddressFilter={setAddressFilter}
              setAddressTypeFilter={setAddressTypeFilter}
              setDirectExpanded={setDirectExpanded}
              setDirectSort={setDirectSort}
              setDistributeAirdropsEnabled={setDistributeAirdropsEnabled}
              setExpandedVaults={setExpandedVaults}
              setIncludeOtherContracts={setIncludeOtherContracts}
              setAirdropInput={setAirdropInput}
              showAirdrops={airdropEnabled}
              showAirdropColumn={showAirdropColumn}
              silo={selectedSilo}
            />
          ) : (
            <section className="min-w-0">
              <EmptyState message="Select a silo to view snapshot details." />
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

function SiloOnlyView({ chain, silo }: { chain: ChainSnapshot; silo: SiloSnapshot }) {
  const { slug } = useActiveCategory();
  const [addressFilter, setAddressFilter] = useState(() => parseFilterFromUrl());
  const [directSort, setDirectSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const [directExpanded, setDirectExpanded] = useState(true);
  const [expandedVaults, setExpandedVaults] = useState<Record<string, boolean>>(
    Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])),
  );

  // Reflect the address filter in the URL so the filtered silo view is shareable.
  useEffect(() => {
    const url = buildSiloPathWithFilter(slug, chain.chain, silo.address, addressFilter);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== url) {
      window.history.replaceState(null, "", url);
    }
  }, [slug, addressFilter, chain.chain, silo.address]);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <AppHeader
          subtitle={`Silo-only snapshot view for ${silo.inputToken.symbol} ${
            silo.siloType === "silo_vault" ? "Vault (detached)" : `#${silo.siloId ?? "--"}`
          }.`}
        />

        <div className="min-w-0 space-y-6 py-8">
          <SiloDetailPanel
            addressFilter={addressFilter}
            buildFilterShareUrl={(filter) => buildSiloPathWithFilter(slug, chain.chain, silo.address, filter)}
            addressTypeFilter="all"
            addressTypes={[]}
            chain={chain}
            directExpanded={directExpanded}
            directSort={directSort}
            distributeAirdropsEnabled={false}
            expandedVaults={expandedVaults}
            forceExpanded
            includeOtherContracts={false}
            airdropInput=""
            airdropInputInvalid={false}
            airdropPlan={null}
            setAddressFilter={setAddressFilter}
            setAddressTypeFilter={() => undefined}
            setDirectExpanded={setDirectExpanded}
            setDirectSort={setDirectSort}
            setDistributeAirdropsEnabled={() => undefined}
            setExpandedVaults={setExpandedVaults}
            setIncludeOtherContracts={() => undefined}
            setAirdropInput={() => undefined}
            showConnectWallet
            showExpandControls={false}
            showAirdropColumn={false}
            showAirdrops={false}
            showTypeFilter={false}
            silo={silo}
          />
        </div>
      </section>
    </main>
  );
}

function SiloNotFoundView({ address, chain }: { address: string; chain?: string }) {
  const label = chain ? `${chain} / ${address}` : address;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <AppHeader />
        <div className="py-8">
          <EmptyState message={`No snapshot data found for silo ${label}.`} />
        </div>
      </section>
    </main>
  );
}

function categorySiloCount(category: SnapshotCategory): number {
  if (!category.data) {
    return 0;
  }
  return category.data.chains.reduce((total, chain) => total + chain.silos.length, 0);
}

function LandingView({ notFoundSlug }: { notFoundSlug?: string }) {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Lender Snapshots</h1>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-slate-400">
            v{APP_VERSION}
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          Static, no-RPC snapshot explorer for direct holders and vault depositors across chains. Pick a snapshot to
          browse its lenders and prepare pro-rata airdrop distributions.
        </p>

        {notFoundSlug ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3.5 py-1.5 text-xs font-medium text-amber-200">
            <WarningIcon className="h-4 w-4 shrink-0" />
            <span>
              Unknown snapshot <span className="font-mono">{notFoundSlug}</span>. Choose one below.
            </span>
          </p>
        ) : null}

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {SNAPSHOT_CATEGORIES.map((category) => {
            const siloCount = categorySiloCount(category);
            const comingSoon = !category.data;
            const cardBody = (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lg font-semibold text-white">{category.label}</span>
                  {comingSoon ? (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-400">Coming soon</span>
                  ) : (
                    <span aria-hidden="true" className="text-slate-500 transition group-hover:text-emerald-200">
                      →
                    </span>
                  )}
                </div>
                {comingSoon ? null : (
                  <p className="mt-3 text-xs text-slate-400">
                    {siloCount} silo{siloCount === 1 ? "" : "s"}
                  </p>
                )}
              </>
            );

            if (comingSoon) {
              return (
                <div
                  key={category.slug}
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-3xl border border-white/10 bg-white/[0.02] p-5 opacity-60"
                >
                  {cardBody}
                </div>
              );
            }

            return (
              <a
                key={category.slug}
                className="group rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-slate-950/30 transition hover:border-emerald-300/40 hover:bg-white/[0.06]"
                href={categoryHomePath(category.slug)}
              >
                {cardBody}
              </a>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const categorySlug = parseCategoryFromUrl();
  // Comma-decimal is the default because the CSV field delimiter is ";", so
  // "," reads back as a real number in pl-PL-style spreadsheet locales.
  const [csvDecimal, setCsvDecimal] = useState<CsvDecimal>(",");

  // Root: landing page listing every snapshot category.
  if (!categorySlug) {
    return <LandingView />;
  }

  const category = findCategory(categorySlug);
  if (!category || !category.data) {
    return <LandingView notFoundSlug={categorySlug} />;
  }

  const active = toActiveCategory(category);
  const pathMatch = parseSiloPathFromUrl();
  const siloMatch = pathMatch ? findSiloByAddress(active.chains, pathMatch.address, pathMatch.chain) : null;

  let view: ReactNode;
  if (pathMatch && !siloMatch) {
    view = <SiloNotFoundView address={pathMatch.address} chain={pathMatch.chain} />;
  } else if (siloMatch) {
    view = <SiloOnlyView chain={siloMatch.chain} silo={siloMatch.silo} />;
  } else {
    view = <ExplorerView />;
  }

  return (
    <CategoryContext.Provider value={active}>
      <CsvFormatContext.Provider value={{ decimal: csvDecimal, setDecimal: setCsvDecimal }}>
        {view}
      </CsvFormatContext.Provider>
    </CategoryContext.Provider>
  );
}
