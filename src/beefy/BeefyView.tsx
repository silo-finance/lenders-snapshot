import { useId, useMemo, useState } from "react";
import { landingHomePath } from "../routing";
import {
  explorerAddressUrl,
  formatUnitsFixed,
  formatUnitsRounded,
  shortAddress,
} from "../snapshot";
import { getNetworkIconPath, getNetworkName } from "../networks";
import { BEEFY_VAULTS, type BeefyHolder, type BeefyVaultSnapshot } from "./vaults";

const METHODOLOGY_URL =
  "https://github.com/silo-finance/lenders-snapshot/blob/master/README.md#beefy-claims";

type SortKey = "address" | "amount" | "lp" | "percent" | "contract";
type SortDirection = "asc" | "desc";
type SortState = { key: SortKey; direction: SortDirection };

const DEFAULT_SORT: SortState = { key: "amount", direction: "desc" };

function beefyVaultSectionId(vaultId: string): string {
  return `beefy-vault-${vaultId}`;
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

function compareHolders(a: BeefyHolder, b: BeefyHolder, sort: SortState): number {
  const dir = sort.direction === "asc" ? 1 : -1;
  switch (sort.key) {
    case "address":
      return a.address.localeCompare(b.address) * dir;
    case "amount":
      return (a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1) * dir;
    case "lp":
      return (a.lp === b.lp ? 0 : a.lp < b.lp ? -1 : 1) * dir;
    case "percent": {
      // Compare percentNumer / 10^scale without floating point.
      const left = a.percentNumer * 10n ** BigInt(b.percentScale);
      const right = b.percentNumer * 10n ** BigInt(a.percentScale);
      return (left === right ? 0 : left < right ? -1 : 1) * dir;
    }
    case "contract":
      return a.contract.localeCompare(b.contract) * dir;
    default:
      return 0;
  }
}

function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "address" || key === "contract" ? "asc" : "desc" };
}

function SortHeader({
  align = "left",
  label,
  sortKey,
  sortState,
  onClick,
}: {
  align?: "left" | "right";
  label: string;
  sortKey: SortKey;
  sortState: SortState;
  onClick: (key: SortKey) => void;
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

function AddressCell({ chain, address }: { chain: string; address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <a
        className="font-mono text-emerald-200 transition hover:text-emerald-100"
        href={explorerAddressUrl(chain, address)}
        rel="noreferrer"
        target="_blank"
        title={address}
      >
        {shortAddress(address)}
      </a>
      <button
        className={`inline-flex items-center justify-center text-xs transition ${
          copied ? "text-emerald-100" : "text-slate-400 hover:text-emerald-200"
        }`}
        title={copied ? "Address copied" : "Copy address"}
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
        <span className="sr-only">{copied ? "Address copied" : "Copy address"}</span>
      </button>
    </span>
  );
}

function formatShare(raw: string, value: bigint): string {
  if (!raw.trim()) {
    return "0";
  }
  if (/e/i.test(raw)) {
    return value.toString();
  }
  return raw.trim();
}

function formatPercent(raw: string): string {
  const t = raw.trim();
  if (!t) {
    return "0%";
  }
  const asNumber = Number(t);
  if (!Number.isFinite(asNumber)) {
    return `${t}%`;
  }
  return `${(asNumber * 100).toLocaleString(undefined, { maximumFractionDigits: 6 })}%`;
}

/** Format a percent rational (numer / 10^scale) as a human percentage string. */
function formatPercentRational(numer: bigint, scale: number): string {
  if (scale <= 0) {
    return `${numer.toString()}%`;
  }
  const negative = numer < 0n;
  const abs = negative ? -numer : numer;
  // percent points = numer / 10^scale * 100 = numer * 100 / 10^scale
  const scaled = abs * 100n;
  const denom = 10n ** BigInt(scale);
  const whole = scaled / denom;
  const frac = scaled % denom;
  const fracStr = frac.toString().padStart(scale, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return `${negative ? "-" : ""}${body}%`;
}

type VaultTotals = {
  amount: bigint;
  lp: bigint;
  percentNumer: bigint;
  percentScale: number;
};

function sumVaultHolders(holders: BeefyHolder[]): VaultTotals {
  let amount = 0n;
  let lp = 0n;
  let maxScale = 0;
  for (const row of holders) {
    amount += row.amount;
    lp += row.lp;
    if (row.percentScale > maxScale) {
      maxScale = row.percentScale;
    }
  }
  let percentNumer = 0n;
  for (const row of holders) {
    percentNumer += row.percentNumer * 10n ** BigInt(maxScale - row.percentScale);
  }
  return { amount, lp, percentNumer, percentScale: maxScale };
}

function VaultTableTotalsFoot({ vault }: { vault: BeefyVaultSnapshot }) {
  const totals = useMemo(() => sumVaultHolders(vault.holders), [vault.holders]);
  return (
    <tfoot className="border-t border-white/15 bg-white/[0.04]">
      <tr>
        <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
          Totals (all holders)
        </th>
        <td className="px-3 py-3 text-right font-mono font-medium text-slate-200">{totals.lp.toString()}</td>
        <td className="px-3 py-3 text-right font-mono font-medium text-slate-200">
          {formatPercentRational(totals.percentNumer, totals.percentScale)}
        </td>
        <td className="px-3 py-3 text-slate-600">—</td>
        <td className="px-3 py-3 text-right font-mono font-semibold text-emerald-100">
          {formatUnitsFixed(totals.amount, vault.inputToken.decimals)} {vault.inputToken.symbol}
        </td>
      </tr>
    </tfoot>
  );
}

function VaultSanityChecks({ vault }: { vault: BeefyVaultSnapshot }) {
  const totals = useMemo(() => sumVaultHolders(vault.holders), [vault.holders]);
  const percentOk = totals.percentNumer <= 10n ** BigInt(totals.percentScale);
  const proxyGtAmount = vault.totalPendingAssets > totals.amount;
  const allOk = percentOk && proxyGtAmount;

  return (
    <div
      className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
        allOk
          ? "border-emerald-300/25 bg-emerald-400/[0.06] text-emerald-100"
          : "border-amber-300/40 bg-amber-300/10 text-amber-100"
      }`}
    >
      <div className="font-medium">{allOk ? "Sanity checks passed" : "Sanity check warnings"}</div>
      <ul className="mt-2 space-y-1 text-xs leading-5">
        <li className={proxyGtAmount ? "text-emerald-200/90" : "text-amber-200"}>
          {proxyGtAmount ? "✓" : "✗"} Proxy net (
          {formatUnitsFixed(vault.totalPendingAssets, vault.inputToken.decimals)} {vault.inputToken.symbol}){" "}
          {proxyGtAmount ? ">" : "≤"} sum(Amount) (
          {formatUnitsFixed(totals.amount, vault.inputToken.decimals)} {vault.inputToken.symbol})
        </li>
        <li className={percentOk ? "text-emerald-200/90" : "text-amber-200"}>
          {percentOk ? "✓" : "✗"} Sum(Percent) = {formatPercentRational(totals.percentNumer, totals.percentScale)}
          {percentOk ? " (≤ 100%)" : " — exceeds 100%"}
        </li>
      </ul>
    </div>
  );
}

function VaultSection({
  vault,
  addressFilter,
  prevId,
  nextId,
}: {
  vault: BeefyVaultSnapshot;
  addressFilter: string;
  prevId?: string;
  nextId?: string;
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const icon = getNetworkIconPath(vault.chainId);
  const networkName = getNetworkName(vault.chainId);

  const filtered = useMemo(() => {
    const needle = addressFilter.trim().toLowerCase();
    const rows = needle
      ? vault.holders.filter((row) => row.address.includes(needle))
      : vault.holders.slice();
    rows.sort((a, b) => compareHolders(a, b, sort));
    return rows;
  }, [addressFilter, sort, vault.holders]);

  return (
    <section
      className="scroll-mt-6 rounded-[2rem] border border-white/10 bg-white/[0.03] p-5 shadow-xl shadow-slate-950/20 sm:p-6"
      id={beefyVaultSectionId(vault.id)}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {icon ? <img alt="" className="h-6 w-6 rounded-full" src={icon} /> : null}
            <h2 className="text-xl font-semibold text-white">{vault.label}</h2>
            <SectionNavButtons nextId={nextId} prevId={prevId} />
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs text-slate-400">
              {networkName}
            </span>
          </div>
          <p className="text-sm text-slate-400">
            Managed vault <span className="text-slate-300">{vault.vaultName}</span>
            {" · "}
            {vault.inputToken.symbol}
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/[0.06] px-4 py-3 text-right">
          <div className="text-xs uppercase tracking-wide text-emerald-200/80">Total (proxy net)</div>
          <div className="mt-1 font-mono text-lg font-semibold text-emerald-100">
            {formatUnitsRounded(vault.totalPendingAssets, vault.inputToken.decimals, 2)}{" "}
            {vault.inputToken.symbol}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-2xl border border-white/8 bg-black/20 px-3.5 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Beefy proxy</dt>
          <dd className="mt-1.5">
            <AddressCell address={vault.proxyAddress} chain={vault.chain} />
          </dd>
        </div>
        <div className="rounded-2xl border border-white/8 bg-black/20 px-3.5 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Silo managed vault</dt>
          <dd className="mt-1.5">
            <AddressCell address={vault.vaultAddress} chain={vault.chain} />
          </dd>
        </div>
      </dl>

      <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-full divide-y divide-white/10 text-sm">
          <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-3 text-left font-medium">
                <SortHeader label="Address" sortKey="address" sortState={sort} onClick={(k) => setSort(nextSort(sort, k))} />
              </th>
              <th className="px-3 py-3 text-right font-medium">
                <SortHeader
                  align="right"
                  label="LP"
                  sortKey="lp"
                  sortState={sort}
                  onClick={(k) => setSort(nextSort(sort, k))}
                />
              </th>
              <th className="px-3 py-3 text-right font-medium">
                <SortHeader
                  align="right"
                  label="Percent"
                  sortKey="percent"
                  sortState={sort}
                  onClick={(k) => setSort(nextSort(sort, k))}
                />
              </th>
              <th className="px-3 py-3 text-left font-medium">
                <SortHeader
                  label="Contract"
                  sortKey="contract"
                  sortState={sort}
                  onClick={(k) => setSort(nextSort(sort, k))}
                />
              </th>
              <th className="px-3 py-3 text-right font-medium">
                <SortHeader
                  align="right"
                  label="Amount"
                  sortKey="amount"
                  sortState={sort}
                  onClick={(k) => setSort(nextSort(sort, k))}
                />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-slate-500" colSpan={5}>
                  No holders match this address filter.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.address} className="hover:bg-white/[0.02]">
                  <td className="px-3 py-2.5">
                    <AddressCell address={row.address} chain={vault.chain} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                    {formatShare(row.lpRaw, row.lp)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                    {formatPercent(row.percentRaw)}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">{row.contract || "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-medium text-emerald-100">
                    {formatUnitsFixed(row.amount, vault.inputToken.decimals)} {vault.inputToken.symbol}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <VaultTableTotalsFoot vault={vault} />
        </table>
      </div>
      <VaultSanityChecks vault={vault} />
      <p className="mt-3 text-xs text-slate-500">
        Showing {filtered.length} of {vault.holders.length} holders. Amount values come from the Beefy CSV and are
        shown in the Silo market asset units. Totals and sanity checks always use all holders (ignore the address
        filter).
      </p>
    </section>
  );
}

export function BeefyView() {
  const filterId = useId();
  const [addressFilter, setAddressFilter] = useState("");

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div>
          <a
            className="text-sm text-slate-400 transition hover:text-emerald-200"
            href={landingHomePath()}
          >
            ← Lender Snapshots
          </a>
        </div>

        <div className="mt-6">
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Beefy Claims</h1>
          <a
            className="mt-2 inline-block text-sm text-sky-200 transition hover:text-sky-100"
            href={METHODOLOGY_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            Methodology
          </a>
        </div>

        <div className="mt-8 rounded-[2rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6">
          <label className="text-sm font-medium text-slate-300" htmlFor={filterId}>
            Filter by address
          </label>
          <div className="relative mt-3">
            <input
              id={filterId}
              className={`w-full rounded-2xl border border-white/22 bg-white/[0.10] py-3 pl-4 font-mono text-sm text-slate-200 outline-none ${
                addressFilter ? "pr-12" : "pr-4"
              }`}
              placeholder="Search by address substring"
              value={addressFilter}
              onChange={(event) => setAddressFilter(event.target.value)}
            />
            {addressFilter ? (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2 py-1 text-sm text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
                title="Clear address filter"
                type="button"
                onClick={() => setAddressFilter("")}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {BEEFY_VAULTS.map((vault, index) => (
            <VaultSection
              key={vault.id}
              addressFilter={addressFilter}
              nextId={
                index < BEEFY_VAULTS.length - 1
                  ? beefyVaultSectionId(BEEFY_VAULTS[index + 1].id)
                  : undefined
              }
              prevId={index > 0 ? beefyVaultSectionId(BEEFY_VAULTS[index - 1].id) : undefined}
              vault={vault}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
