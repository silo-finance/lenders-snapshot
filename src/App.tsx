import { useState, type ReactNode } from "react";
import packageJson from "../package.json";
import { explorerHomePath, parseSiloPathFromUrl } from "./routing";
import {
  type ChainSnapshot,
  type DirectLender,
  type SiloSnapshot,
  type VaultDepositor,
  type VaultSnapshot,
  chains,
  compareBigIntAsc,
  compareBigIntDesc,
  explorerAddressUrl,
  findSiloByAddress,
  formatUnits,
  formatUnitsFixed,
  formatUnitsPlain,
  formatUnitsRounded,
  parseUnits,
  shortAddress,
} from "./snapshot";
import { useWallet } from "./useWallet";

type SortDirection = "asc" | "desc";
type TableSortKey = "address" | "type" | "shares" | "assets";
type TableSortState = {
  key: TableSortKey;
  direction: SortDirection;
};

type ShareAssetTotals = {
  shares: bigint;
  assets: bigint;
};

const DEFAULT_EXPANDED_LIMIT = 2;
const APP_VERSION = packageJson.version;

type RewardPlan = {
  rewardRaw: bigint;
  byLeafKey: Map<string, bigint>;
  csvRewards: Map<string, bigint | null>;
  excludedLeafKeys: Set<string>;
  totalAssets: bigint;
  distributed: bigint;
  undistributed: bigint;
  nonAttributableAssets: bigint;
};

const ZERO = 0n;
const OTHER_CONTRACT_TYPE = "contract_other";

function floorToWholeUnits(value: bigint, decimals: number): bigint {
  const scale = 10n ** BigInt(decimals);
  return (value / scale) * scale;
}

function directLeafKey(siloAddress: string, address: string): string {
  return `direct:${siloAddress}:${address}`;
}

function vaultLeafKey(siloAddress: string, vaultAddress: string, depositorAddress: string): string {
  return `vault:${siloAddress}:${vaultAddress}:${depositorAddress}`;
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

function sumDirectLenderTotals(lenders: DirectLender[]): ShareAssetTotals {
  return lenders.reduce(
    (acc, lender) => ({
      shares: acc.shares + lender.totalShares,
      assets: acc.assets + lender.totalAssets,
    }),
    { shares: ZERO, assets: ZERO },
  );
}

function sumDepositorTotals(depositors: VaultDepositor[]): ShareAssetTotals {
  return depositors.reduce(
    (acc, depositor) => ({
      shares: acc.shares + depositor.vaultShares,
      assets: acc.assets + depositor.attributedSiloAssets,
    }),
    { shares: ZERO, assets: ZERO },
  );
}

function sumDirectShares(silo: SiloSnapshot): bigint {
  return silo.directLenders.reduce((sum, lender) => sum + lender.collateralShares, ZERO);
}

function ValidationBadge({ message, valid, inline = false }: { message: string; valid: boolean; inline?: boolean }) {
  if (!valid) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-emerald-300 ${inline ? "text-xs" : "mt-2 gap-1.5 text-sm"}`}
    >
      <span aria-hidden="true">✓</span>
      <span>{message}</span>
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
  const directSharesSum = sumDirectShares(silo);
  const sharesValid = directSharesSum === silo.collateralTotalSupply;

  return (
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <MetricCard
        className="md:col-span-2"
        label="Total assets"
        value={`${formatUnitsRounded(silo.totalAssets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
        footer={
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
        }
      />
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
  );
}

function scrollToSection(sectionId: string) {
  document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SectionNavButtons({ prevId, nextId }: { prevId?: string; nextId?: string }) {
  if (!prevId && !nextId) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      {prevId ? (
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-xs text-slate-300 transition hover:bg-white/10 hover:text-emerald-200"
          title="Previous table"
          type="button"
          onClick={() => scrollToSection(prevId)}
        >
          ⌃
        </button>
      ) : null}
      {nextId ? (
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 text-xs text-slate-300 transition hover:bg-white/10 hover:text-emerald-200"
          title="Next table"
          type="button"
          onClick={() => scrollToSection(nextId)}
        >
          ⌄
        </button>
      ) : null}
    </span>
  );
}

function ColumnHeaderSum({ value }: { value: string }) {
  return <div className="mb-1 font-mono text-[10px] font-normal normal-case tracking-normal text-slate-400">{value}</div>;
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

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${
        copied
          ? "border-emerald-300/60 bg-emerald-300/20 text-emerald-100"
          : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-emerald-300/40 hover:text-emerald-200"
      }`}
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

function AddressLink({ chain, address }: { chain: string; address: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <a
        className="font-mono text-emerald-200 transition hover:text-emerald-100"
        href={explorerAddressUrl(chain, address)}
        rel="noreferrer"
        target="_blank"
        title={address}
        onClick={(event) => event.stopPropagation()}
      >
        {shortAddress(address)}
      </a>
      <CopyAddressButton address={address} />
    </span>
  );
}

function AddressFilterInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative mt-3">
      <input
        id={id}
        className="w-full rounded-2xl border border-white/10 bg-slate-950/80 py-3 pl-4 pr-11 font-mono text-sm text-slate-300 outline-none placeholder:text-slate-600"
        placeholder="Search by address substring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full px-2 py-1 text-sm text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
          title="Clear address filter"
          type="button"
          onClick={() => onChange("")}
        >
          ×
        </button>
      ) : null}
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
    if (sortState.key === "shares") {
      return compareValues(left.totalShares, right.totalShares, sortState.direction);
    }
    return compareValues(left.totalAssets, right.totalAssets, sortState.direction);
  });
}

function HolderTable({
  chain,
  rows,
  silo,
  expanded,
  rewardPlan,
  showRewardColumn,
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
  rewardPlan: RewardPlan | null;
  showRewardColumn: boolean;
  sortState: TableSortState;
  tableTotals: ShareAssetTotals;
  onSort: (key: TableSortKey) => void;
  onToggle: () => void;
  onJumpToVault: (vaultAddress: string) => void;
  onExport: () => void;
  forceExpanded?: boolean;
  navNextId?: string;
}) {
  const isExpanded = forceExpanded || expanded;

  return (
    <div id="direct-lenders" className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="font-semibold text-white">Direct lenders</h3>
          <SectionNavButtons nextId={navNextId} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
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
        </div>
      </div>
      {!isExpanded ? (
        <div className="px-5 py-4 text-sm text-slate-400">
          Direct lenders table is collapsed. Use Expand or Expand all to show it.
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message="No direct lenders match the current address filter." />
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
                  <ColumnHeaderSum value={tableTotals.shares.toString()} />
                  <SortHeader align="right" label="Shares" sortKey="shares" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <ColumnHeaderSum
                    value={`${formatUnitsRounded(tableTotals.assets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                  />
                  <SortHeader align="right" label="Assets" sortKey="assets" sortState={sortState} onClick={onSort} />
                </th>
                {showRewardColumn ? <th className="px-5 py-3 text-right font-medium">Reward</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10 text-slate-200">
              {rows.map((row) => (
                <tr key={row.address} className="hover:bg-white/[0.03]">
                  <td className="px-5 py-4">
                    <AddressLink address={row.address} chain={chain} />
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
                  <td className="px-5 py-4 text-right font-mono tabular-nums">{row.totalShares.toString()}</td>
                  <td className="px-5 py-4 text-right font-mono tabular-nums">
                    {formatUnitsRounded(row.totalAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                  </td>
                  {showRewardColumn ? (
                    <td
                      className={
                        row.isVault
                          ? "px-5 py-4 text-right font-mono tabular-nums text-slate-500"
                          : "px-5 py-4 text-right font-mono tabular-nums"
                      }
                    >
                      {row.isVault
                        ? "N/A"
                        : formatRewardCell(
                            rewardPlan,
                            directLeafKey(silo.address, row.address),
                            silo.inputToken.decimals,
                            silo.inputToken.symbol,
                          )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    if (sortState.key === "shares") {
      return compareValues(a.vaultShares, b.vaultShares, sortState.direction);
    }
    return compareValues(a.attributedSiloAssets, b.attributedSiloAssets, sortState.direction);
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
  rewardPlan,
  showRewardColumn,
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
  rewardPlan: RewardPlan | null;
  showRewardColumn: boolean;
  tableTotals: ShareAssetTotals;
  onSort: (key: TableSortKey) => void;
  hideTypeFilter?: boolean;
}) {
  const needle = addressFilter.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    const addressMatches = needle ? row.address.toLowerCase().includes(needle) : true;
    const typeMatches = hideTypeFilter || addressTypeFilter === "all" || row.addressType === addressTypeFilter;
    return addressMatches && typeMatches;
  });
  const filteredRows = sortDepositors(visibleRows, sortState);

  if (filteredRows.length === 0) {
    return <EmptyState message="No vault depositors match the current address filter." />;
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
                <ColumnHeaderSum value={tableTotals.shares.toString()} />
                <SortHeader align="right" label="Vault shares" sortKey="shares" sortState={sortState} onClick={onSort} />
              </th>
              <th className="px-5 py-3 text-right font-medium">
                <ColumnHeaderSum
                  value={`${formatUnitsRounded(tableTotals.assets, silo.inputToken.decimals, 2)} ${silo.inputToken.symbol}`}
                />
                <SortHeader align="right" label="Vault assets" sortKey="assets" sortState={sortState} onClick={onSort} />
              </th>
              {showRewardColumn ? <th className="px-5 py-3 text-right font-medium">Reward</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-200">
            {filteredRows.map((row) => (
              <tr key={row.address} className="hover:bg-white/[0.03]">
                <td className="px-5 py-4">
                  <AddressLink address={row.address} chain={chain} />
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{row.addressType}</span>
                </td>
                <td className="px-5 py-4 text-right font-mono tabular-nums">{row.vaultShares.toString()}</td>
                <td className="px-5 py-4 text-right font-mono tabular-nums">
                  {formatUnitsRounded(row.attributedSiloAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                </td>
                {showRewardColumn ? (
                  <td className="px-5 py-4 text-right font-mono tabular-nums">
                    {rewardPlan
                      ? formatRewardCell(
                          rewardPlan,
                          vaultLeafKey(silo.address, vaultAddress, row.address),
                          silo.inputToken.decimals,
                          silo.inputToken.symbol,
                        )
                      : "--"}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function isVaultWarning(vault: VaultSnapshot): boolean {
  return vault.status !== "ok" || !vault.indexedInSubgraph || !vault.inWithdrawQueue;
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

function addCsvReward(csvRewards: Map<string, bigint | null>, address: string, amount: bigint | null) {
  const current = csvRewards.get(address);
  if (amount === null) {
    if (current === undefined) {
      csvRewards.set(address, null);
    }
    return;
  }
  csvRewards.set(address, (current ?? ZERO) + amount);
}

function isRewardEligible(addressType: string, includeOtherContracts: boolean): boolean {
  return includeOtherContracts || addressType !== OTHER_CONTRACT_TYPE;
}

function formatRewardCell(rewardPlan: RewardPlan | null, leafKey: string, decimals: number, symbol: string): string {
  if (!rewardPlan) {
    return "--";
  }
  if (rewardPlan.excludedLeafKeys.has(leafKey)) {
    return "Not available";
  }
  return `${formatUnits(rewardPlan.byLeafKey.get(leafKey) ?? ZERO, decimals, 0)} ${symbol}`;
}

function buildRewardPlan(
  allSilos: SiloSnapshot[],
  rewardRaw: bigint,
  rewardDecimals: number,
  includeOtherContracts: boolean,
): RewardPlan {
  const byLeafKey = new Map<string, bigint>();
  const csvRewards = new Map<string, bigint | null>();
  const excludedLeafKeys = new Set<string>();
  let distributed = ZERO;
  let leafAssets = ZERO;
  let excludedAssets = ZERO;
  const totalAssets = allSilos.reduce((sum, silo) => sum + silo.totalAssets, ZERO);

  for (const silo of allSilos) {
    for (const lender of silo.directLenders) {
      if (lender.isVault) {
        continue;
      }
      if (!isRewardEligible(lender.addressType, includeOtherContracts)) {
        excludedAssets += lender.totalAssets;
      }
    }

    for (const vault of silo.vaults) {
      if (isVaultWarning(vault)) {
        continue;
      }
      for (const depositor of vault.depositors) {
        if (!isRewardEligible(depositor.addressType, includeOtherContracts)) {
          excludedAssets += depositor.attributedSiloAssets;
        }
      }
    }
  }

  const rewardDenominator = totalAssets > excludedAssets ? totalAssets - excludedAssets : ZERO;

  if (rewardRaw === ZERO || rewardDenominator === ZERO) {
    return {
      rewardRaw,
      byLeafKey,
      csvRewards,
      excludedLeafKeys,
      totalAssets: rewardDenominator,
      distributed,
      undistributed: rewardRaw,
      nonAttributableAssets: rewardDenominator,
    };
  }

  for (const silo of allSilos) {
    for (const lender of silo.directLenders) {
      if (lender.isVault) {
        continue;
      }
      const leafKey = directLeafKey(silo.address, lender.address);
      if (!isRewardEligible(lender.addressType, includeOtherContracts)) {
        excludedLeafKeys.add(leafKey);
        addCsvReward(csvRewards, lender.address, null);
        continue;
      }
      const reward = floorToWholeUnits((rewardRaw * lender.totalAssets) / rewardDenominator, rewardDecimals);
      byLeafKey.set(leafKey, reward);
      addCsvReward(csvRewards, lender.address, reward);
      distributed += reward;
      leafAssets += lender.totalAssets;
    }

    for (const vault of silo.vaults) {
      if (isVaultWarning(vault)) {
        continue;
      }
      for (const depositor of vault.depositors) {
        const leafKey = vaultLeafKey(silo.address, vault.address, depositor.address);
        if (!isRewardEligible(depositor.addressType, includeOtherContracts)) {
          excludedLeafKeys.add(leafKey);
          addCsvReward(csvRewards, depositor.address, null);
          continue;
        }
        const reward = floorToWholeUnits(
          (rewardRaw * depositor.attributedSiloAssets) / rewardDenominator,
          rewardDecimals,
        );
        byLeafKey.set(leafKey, reward);
        addCsvReward(csvRewards, depositor.address, reward);
        distributed += reward;
        leafAssets += depositor.attributedSiloAssets;
      }
    }
  }

  return {
    rewardRaw,
    byLeafKey,
    csvRewards,
    excludedLeafKeys,
    totalAssets: rewardDenominator,
    distributed,
    undistributed: rewardRaw > distributed ? rewardRaw - distributed : ZERO,
    nonAttributableAssets: rewardDenominator > leafAssets ? rewardDenominator - leafAssets : ZERO,
  };
}

function VaultCard({
  chain,
  vault,
  silo,
  expanded,
  onToggle,
  addressFilter,
  addressTypeFilter,
  rewardPlan,
  showRewardColumn,
  forceExpanded = false,
  hideTypeFilter = false,
  navPrevId,
  navNextId,
}: {
  chain: string;
  vault: VaultSnapshot;
  silo: SiloSnapshot;
  expanded: boolean;
  onToggle: () => void;
  addressFilter: string;
  addressTypeFilter: string;
  rewardPlan: RewardPlan | null;
  showRewardColumn: boolean;
  forceExpanded?: boolean;
  hideTypeFilter?: boolean;
  navPrevId?: string;
  navNextId?: string;
}) {
  const [depositorSort, setDepositorSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const hasWarning = isVaultWarning(vault);
  const isExpanded = forceExpanded || expanded;
  const depositorTotals = sumDepositorTotals(vault.depositors);
  const vaultSharesValid =
    vault.vaultTotalSupply !== null && depositorTotals.shares === vault.vaultTotalSupply && vault.status === "ok";
  const unavailableReward =
    hasWarning && rewardPlan && rewardPlan.totalAssets > ZERO
      ? (rewardPlan.rewardRaw * vault.vaultSiloAssets) / rewardPlan.totalAssets
      : ZERO;

  return (
    <div
      id={vaultElementId(vault.address)}
      className={`rounded-3xl border p-5 ${
        hasWarning ? "border-amber-300/30 bg-amber-300/[0.08]" : "border-emerald-300/20 bg-emerald-300/[0.06]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className={hasWarning ? "font-semibold text-amber-100" : "font-semibold text-emerald-100"}>
            {vault.name || "Unnamed SiloVault"}
          </h3>
          <AddressLink address={vault.address} chain={chain} />
          <SectionNavButtons nextId={navNextId} prevId={navPrevId} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            <ValidationBadge inline message="Vault shares equal sum of depositor shares" valid={vaultSharesValid} />
          </span>
        ) : null}
      </p>
      {hasWarning ? (
        <div className="mt-4 max-w-2xl space-y-2 text-sm leading-6 text-amber-100/75">
          <p>
            Depositors cannot be enumerated for this vault. Its assets are shown here so reward calculations can surface
            the non-attributable amount.
          </p>
          {unavailableReward > ZERO ? (
            <p className="font-semibold text-amber-100">
              Undistributed from this vault: {formatUnits(unavailableReward, silo.inputToken.decimals)}{" "}
              {silo.inputToken.symbol}
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
            rewardPlan={rewardPlan}
            rows={vault.depositors}
            showRewardColumn={showRewardColumn}
            silo={silo}
            sortState={depositorSort}
            tableTotals={depositorTotals}
            vaultAddress={vault.address}
            onSort={(key) => setDepositorSort((current) => nextSortState(current, key))}
          />
        </div>
      ) : null}
    </div>
  );
}

function AppHeader() {
  return (
    <header className="border-b border-white/10 pb-8">
      <div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Review Silo Lenders</h1>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-slate-400">
            v{APP_VERSION}
          </span>
        </div>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
          Static, no-RPC snapshot explorer for direct holders and vault depositors across chains.
        </p>
      </div>
    </header>
  );
}

function getInitialChain(): ChainSnapshot {
  return chains.find((chain) => chain.silos.length > 0) ?? chains[0];
}

function resetRewardsState(
  setDistributeRewardsEnabled: (value: boolean) => void,
  setRewardInput: (value: string) => void,
  setIncludeOtherContracts: (value: boolean) => void,
) {
  setDistributeRewardsEnabled(false);
  setRewardInput("");
  setIncludeOtherContracts(false);
}

function SiloDetailPanel({
  chain,
  silo,
  addressFilter,
  setAddressFilter,
  addressTypeFilter,
  setAddressTypeFilter,
  addressTypes,
  directSort,
  setDirectSort,
  directExpanded,
  setDirectExpanded,
  expandedVaults,
  setExpandedVaults,
  distributeRewardsEnabled,
  setDistributeRewardsEnabled,
  rewardInput,
  setRewardInput,
  includeOtherContracts,
  setIncludeOtherContracts,
  rewardPlan,
  rewardInputInvalid,
  showRewardColumn,
  showRewards = true,
  showTypeFilter = true,
  showExpandControls = true,
  forceExpanded = false,
  showConnectWallet = false,
}: {
  chain: ChainSnapshot;
  silo: SiloSnapshot;
  addressFilter: string;
  setAddressFilter: (value: string) => void;
  addressTypeFilter: string;
  setAddressTypeFilter: (value: string) => void;
  addressTypes: string[];
  directSort: TableSortState;
  setDirectSort: (value: TableSortState | ((current: TableSortState) => TableSortState)) => void;
  directExpanded: boolean;
  setDirectExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  expandedVaults: Record<string, boolean>;
  setExpandedVaults: (value: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)) => void;
  distributeRewardsEnabled: boolean;
  setDistributeRewardsEnabled: (value: boolean) => void;
  rewardInput: string;
  setRewardInput: (value: string) => void;
  includeOtherContracts: boolean;
  setIncludeOtherContracts: (value: boolean) => void;
  rewardPlan: RewardPlan | null;
  rewardInputInvalid: boolean;
  showRewardColumn: boolean;
  showRewards?: boolean;
  showTypeFilter?: boolean;
  showExpandControls?: boolean;
  forceExpanded?: boolean;
  showConnectWallet?: boolean;
}) {
  const { account, connect, connecting, hasProvider } = useWallet(
    showConnectWallet ? setAddressFilter : undefined,
  );

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
        <div className={`grid gap-6 xl:items-start ${showRewards ? "xl:grid-cols-3" : ""}`}>
          <div className={showRewards ? "xl:col-span-2" : ""}>
            <p className="text-sm font-medium text-emerald-200">
              {silo.inputToken.symbol} / Silo {silo.siloId ? `#${silo.siloId}` : "#--"}
            </p>
            <h2 className="mt-2 text-3xl font-semibold">Silo lenders details</h2>
            <div className="mt-3">
              <AddressLink address={silo.address} chain={chain.chain} />
            </div>
            <p className="mt-2 text-sm text-slate-400">
              On block{" "}
              <span className="font-mono text-slate-300">{silo.snapshotBlock.toString()}</span>
              <span className="mx-2 text-slate-600">·</span>
              Snapshot block{" "}
              <span className="font-mono text-slate-300">{silo.snapshotBlock.toString()}</span>
            </p>
          </div>
          {showRewards ? (
            <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 xl:col-span-1">
              <label className="flex items-start gap-3 text-sm text-slate-300">
                <input
                  className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950 accent-emerald-300"
                  type="checkbox"
                  checked={distributeRewardsEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setDistributeRewardsEnabled(enabled);
                    if (!enabled) {
                      setRewardInput("");
                      setIncludeOtherContracts(false);
                    }
                  }}
                />
                <span>Distribute rewards</span>
              </label>
              {distributeRewardsEnabled ? (
                <>
                  <p className="mt-4 text-xs uppercase tracking-[0.22em] text-slate-500">Global reward amount</p>
                  <div className="mt-3 flex gap-3">
                    <input
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-300 outline-none placeholder:text-slate-600"
                      placeholder={`0.00 ${silo.inputToken.symbol}`}
                      value={rewardInput}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setRewardInput(nextValue);
                        if (nextValue.trim()) {
                          setDirectExpanded(true);
                          setExpandedVaults(Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])));
                        }
                      }}
                    />
                    <button
                      className="rounded-xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
                      disabled={!rewardPlan || rewardPlan.rewardRaw === ZERO || rewardInputInvalid}
                      type="button"
                      onClick={() => {
                        if (!rewardPlan) {
                          return;
                        }
                        const rows = [["address", "raw_amount", "assets"]];
                        for (const [address, reward] of [...rewardPlan.csvRewards.entries()].sort(([a], [b]) =>
                          a.localeCompare(b),
                        )) {
                          rows.push([
                            address,
                            reward === null ? "" : reward.toString(),
                            reward === null ? "" : formatUnitsFixed(reward, silo.inputToken.decimals),
                          ]);
                        }
                        downloadCsv(`global-snapshot-rewards.csv`, rows);
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
                      CSV with empty reward fields and their assets are redistributed to eligible recipients.
                    </span>
                  </label>
                  {rewardInputInvalid ? (
                    <p className="mt-3 text-xs text-amber-200">
                      Enter a non-negative amount with at most {silo.inputToken.decimals} decimals.
                    </p>
                  ) : rewardPlan && rewardPlan.rewardRaw > ZERO ? (
                    <div className="mt-3 space-y-1 text-xs text-slate-400">
                      <p>
                        Global distributed: {formatUnits(rewardPlan.distributed, silo.inputToken.decimals)}{" "}
                        {silo.inputToken.symbol}
                      </p>
                      {rewardPlan.undistributed > ZERO ? (
                        <p className="text-amber-200">
                          Undistributed: {formatUnits(rewardPlan.undistributed, silo.inputToken.decimals)}{" "}
                          {silo.inputToken.symbol}
                          {rewardPlan.nonAttributableAssets > ZERO
                            ? " because some vault assets have no enumerable depositors."
                            : " due to integer rounding."}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-slate-500">
                      Enter an amount to compute pro-rata rewards across all snapshot assets.
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : null}
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
          <AddressFilterInput id="filter" value={addressFilter} onChange={setAddressFilter} />
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
          showRewardColumn={showRewardColumn}
          silo={silo}
          rewardPlan={rewardPlan}
          sortState={directSort}
          tableTotals={directTableTotals}
          onJumpToVault={jumpToVault}
          onExport={() => {
            downloadCsv(`${chain.chain}-${silo.address}-direct-lenders.csv`, [
              ["Address", "Type", "Assets"],
              ...visibleLenders.map((row) => [
                row.address,
                row.addressType,
                formatUnitsPlain(row.totalAssets, silo.inputToken.decimals),
              ]),
            ]);
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
                expanded={forceExpanded || (expandedVaults[vault.address] ?? index < DEFAULT_EXPANDED_LIMIT)}
                forceExpanded={forceExpanded}
                hideTypeFilter={!showTypeFilter}
                navNextId={index + 2 < tableSectionIds.length ? tableSectionIds[index + 2] : undefined}
                navPrevId={tableSectionIds[index]}
                rewardPlan={rewardPlan}
                showRewardColumn={showRewardColumn}
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
    </section>
  );
}

function ExplorerView() {
  const initialChain = getInitialChain();
  const [selectedChainName, setSelectedChainName] = useState(initialChain.chain);
  const [selectedSiloAddress, setSelectedSiloAddress] = useState(initialChain.silos[0]?.address ?? "");
  const [addressFilter, setAddressFilter] = useState("");
  const [addressTypeFilter, setAddressTypeFilter] = useState("all");
  const [directSort, setDirectSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const [directExpanded, setDirectExpanded] = useState(true);
  const [expandedVaults, setExpandedVaults] = useState<Record<string, boolean>>({});
  const [distributeRewardsEnabled, setDistributeRewardsEnabled] = useState(false);
  const [rewardInput, setRewardInput] = useState("");
  const [includeOtherContracts, setIncludeOtherContracts] = useState(false);

  const selectedChain = chains.find((chain) => chain.chain === selectedChainName) ?? initialChain;
  const selectedSilo = selectedChain.silos.find((silo) => silo.address === selectedSiloAddress) ?? selectedChain.silos[0];
  const allSilos = chains.flatMap((chain) => chain.silos);
  const addressTypes = selectedSilo
    ? Array.from(
        new Set([
          ...selectedSilo.directLenders.map((lender) => lender.addressType),
          ...selectedSilo.vaults.flatMap((vault) => vault.depositors.map((depositor) => depositor.addressType)),
        ]),
      ).sort((a, b) => a.localeCompare(b))
    : [];
  const rewardRaw = selectedSilo ? parseUnits(rewardInput, selectedSilo.inputToken.decimals) : null;
  const rewardInputInvalid = rewardInput.trim() !== "" && rewardRaw === null;
  const rewardPlan =
    selectedSilo && rewardRaw !== null
      ? buildRewardPlan(allSilos, rewardRaw, selectedSilo.inputToken.decimals, includeOtherContracts)
      : null;
  const showRewardColumn = distributeRewardsEnabled && rewardRaw !== null && rewardRaw > ZERO;

  function selectChain(chain: ChainSnapshot) {
    setSelectedChainName(chain.chain);
    setSelectedSiloAddress(chain.silos[0]?.address ?? "");
    setAddressTypeFilter("all");
    setDirectExpanded(true);
    setExpandedVaults({});
    resetRewardsState(setDistributeRewardsEnabled, setRewardInput, setIncludeOtherContracts);
  }

  function selectSilo(siloAddress: string) {
    setSelectedSiloAddress(siloAddress);
    setAddressTypeFilter("all");
    setDirectExpanded(true);
    setExpandedVaults({});
    resetRewardsState(setDistributeRewardsEnabled, setRewardInput, setIncludeOtherContracts);
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <AppHeader />

        <div className="min-w-0 space-y-6 py-8">
          <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-slate-950/30 sm:p-5">
            <div
              className={`grid min-w-0 gap-5 ${
                chains.length > 1 ? "xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start" : ""
              }`}
            >
              {chains.length > 1 ? (
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Chain</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {chains.map((chain) => (
                      <button
                        key={chain.chain}
                        className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                          selectedChain.chain === chain.chain
                            ? "bg-emerald-300 text-slate-950 shadow-lg shadow-emerald-500/20"
                            : "border border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/10"
                        }`}
                        type="button"
                        onClick={() => selectChain(chain)}
                      >
                        {chain.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Silos</p>
                  <span className="rounded-full bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">
                    {selectedChain.silos.length} silo{selectedChain.silos.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="mt-3 flex min-w-0 flex-wrap gap-3">
                  {selectedChain.silos.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-slate-500">
                      No silos are currently bundled for this chain.
                    </div>
                  ) : (
                    selectedChain.silos.map((silo) => (
                      <div
                        key={silo.address}
                        className={`min-w-0 rounded-2xl border px-4 py-3 text-left transition ${
                          selectedSilo?.address === silo.address
                            ? "border-emerald-300/40 bg-emerald-300/10"
                            : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                        }`}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectSilo(silo.address)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectSilo(silo.address);
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-semibold">
                            {silo.inputToken.symbol} Silo {silo.siloId ? `#${silo.siloId}` : "#--"}
                          </span>
                          {selectedSilo?.address === silo.address ? (
                            <span className="shrink-0 rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                          <AddressLink address={silo.address} chain={selectedChain.chain} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          {selectedSilo ? (
            <SiloDetailPanel
              addressFilter={addressFilter}
              addressTypeFilter={addressTypeFilter}
              addressTypes={addressTypes}
              chain={selectedChain}
              directExpanded={directExpanded}
              directSort={directSort}
              distributeRewardsEnabled={distributeRewardsEnabled}
              expandedVaults={expandedVaults}
              includeOtherContracts={includeOtherContracts}
              rewardInput={rewardInput}
              rewardInputInvalid={rewardInputInvalid}
              rewardPlan={rewardPlan}
              setAddressFilter={setAddressFilter}
              setAddressTypeFilter={setAddressTypeFilter}
              setDirectExpanded={setDirectExpanded}
              setDirectSort={setDirectSort}
              setDistributeRewardsEnabled={setDistributeRewardsEnabled}
              setExpandedVaults={setExpandedVaults}
              setIncludeOtherContracts={setIncludeOtherContracts}
              setRewardInput={setRewardInput}
              showRewardColumn={showRewardColumn}
              silo={selectedSilo}
            />
          ) : (
            <section className="min-w-0">
              <EmptyState message="Select a chain with bundled silo data to view snapshot details." />
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

function SiloOnlyView({ chain, silo }: { chain: ChainSnapshot; silo: SiloSnapshot }) {
  const [addressFilter, setAddressFilter] = useState("");
  const [directSort, setDirectSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const [directExpanded, setDirectExpanded] = useState(true);
  const [expandedVaults, setExpandedVaults] = useState<Record<string, boolean>>(
    Object.fromEntries(silo.vaults.map((vault) => [vault.address, true])),
  );

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <header className="border-b border-white/10 pb-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Review Silo Lenders</h1>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-slate-400">
                  v{APP_VERSION}
                </span>
              </div>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
                Silo-only snapshot view for {silo.inputToken.symbol} #{silo.siloId ?? "--"}.
              </p>
            </div>
            <a
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-slate-300 transition hover:bg-white/10"
              href={explorerHomePath()}
            >
              Back to explorer
            </a>
          </div>
        </header>

        <div className="min-w-0 space-y-6 py-8">
          <SiloDetailPanel
            addressFilter={addressFilter}
            addressTypeFilter="all"
            addressTypes={[]}
            chain={chain}
            directExpanded={directExpanded}
            directSort={directSort}
            distributeRewardsEnabled={false}
            expandedVaults={expandedVaults}
            forceExpanded
            includeOtherContracts={false}
            rewardInput=""
            rewardInputInvalid={false}
            rewardPlan={null}
            setAddressFilter={setAddressFilter}
            setAddressTypeFilter={() => undefined}
            setDirectExpanded={setDirectExpanded}
            setDirectSort={setDirectSort}
            setDistributeRewardsEnabled={() => undefined}
            setExpandedVaults={setExpandedVaults}
            setIncludeOtherContracts={() => undefined}
            setRewardInput={() => undefined}
            showConnectWallet
            showExpandControls={false}
            showRewardColumn={false}
            showRewards={false}
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
          <div className="mt-4">
            <a
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-slate-300 transition hover:bg-white/10"
              href={explorerHomePath()}
            >
              Back to explorer
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const pathMatch = parseSiloPathFromUrl();
  const siloMatch = pathMatch ? findSiloByAddress(pathMatch.address, pathMatch.chain) : null;

  if (pathMatch && !siloMatch) {
    return <SiloNotFoundView address={pathMatch.address} chain={pathMatch.chain} />;
  }

  if (siloMatch) {
    return <SiloOnlyView chain={siloMatch.chain} silo={siloMatch.silo} />;
  }

  return <ExplorerView />;
}
