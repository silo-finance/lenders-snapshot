import { useState } from "react";
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
  formatUnits,
  formatUnitsFixed,
  formatUnitsPlain,
  formatUnitsRounded,
  parseUnits,
  shortAddress,
} from "./snapshot";

type SortDirection = "asc" | "desc";
type TableSortKey = "address" | "type" | "shares" | "assets";
type TableSortState = {
  key: TableSortKey;
  direction: SortDirection;
};

const DEFAULT_EXPANDED_LIMIT = 2;

type RewardPlan = {
  rewardRaw: bigint;
  byLeafKey: Map<string, bigint>;
  csvRewards: Map<string, bigint>;
  totalAssets: bigint;
  distributed: bigint;
  undistributed: bigint;
  nonAttributableAssets: bigint;
};

const ZERO = 0n;

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

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-emerald-950/20">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-2 text-sm text-slate-400">{hint}</p>
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
  sortState,
  onSort,
  onToggle,
  onJumpToVault,
  onExport,
}: {
  chain: string;
  rows: DirectLender[];
  silo: SiloSnapshot;
  expanded: boolean;
  rewardPlan: RewardPlan | null;
  sortState: TableSortState;
  onSort: (key: TableSortKey) => void;
  onToggle: () => void;
  onJumpToVault: (vaultAddress: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-semibold text-white">Direct lenders</h3>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-full border border-emerald-300/30 px-3 py-1 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-300/10 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-slate-500 disabled:hover:bg-transparent"
            disabled={rows.length === 0}
            type="button"
            onClick={onExport}
          >
            Export CSV
          </button>
          <button
            className="rounded-full border border-white/10 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
            type="button"
            onClick={onToggle}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>
      {!expanded ? (
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
                  <SortHeader align="right" label="Shares" sortKey="shares" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 text-right font-medium">
                  <SortHeader align="right" label="Assets" sortKey="assets" sortState={sortState} onClick={onSort} />
                </th>
                <th className="px-5 py-3 text-right font-medium">Reward</th>
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
                  <td className="px-5 py-4 text-right font-mono tabular-nums">
                    {row.totalShares.toString()}
                  </td>
                  <td className="px-5 py-4 text-right font-mono tabular-nums">
                    {formatUnitsRounded(row.totalAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                  </td>
                  <td
                    className={
                      row.isVault
                        ? "px-5 py-4 text-right font-mono tabular-nums text-slate-500"
                        : "px-5 py-4 text-right font-mono tabular-nums"
                    }
                  >
                    {row.isVault
                      ? "N/A"
                      : rewardPlan
                        ? `${formatUnits(
                            rewardPlan.byLeafKey.get(directLeafKey(silo.address, row.address)) ?? ZERO,
                            silo.inputToken.decimals,
                            0,
                          )} ${silo.inputToken.symbol}`
                        : "--"}
                  </td>
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
  onSort,
}: {
  chain: string;
  rows: VaultDepositor[];
  silo: SiloSnapshot;
  vaultAddress: string;
  sortState: TableSortState;
  addressFilter: string;
  addressTypeFilter: string;
  rewardPlan: RewardPlan | null;
  onSort: (key: TableSortKey) => void;
}) {
  const needle = addressFilter.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    const addressMatches = needle ? row.address.toLowerCase().includes(needle) : true;
    const typeMatches = addressTypeFilter === "all" || row.addressType === addressTypeFilter;
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
                <SortHeader
                  align="right"
                  label="Vault shares"
                  sortKey="shares"
                  sortState={sortState}
                  onClick={onSort}
                />
              </th>
              <th className="px-5 py-3 text-right font-medium">
                <SortHeader
                  align="right"
                  label="Attributed assets"
                  sortKey="assets"
                  sortState={sortState}
                  onClick={onSort}
                />
              </th>
              <th className="px-5 py-3 text-right font-medium">Reward</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-200">
            {filteredRows.map((row) => (
              <tr key={row.address} className="hover:bg-white/[0.03]">
                <td className="px-5 py-4">
                  <AddressLink address={row.address} chain={chain} />
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">
                    {row.addressType}
                  </span>
                </td>
                <td className="px-5 py-4 text-right font-mono tabular-nums">
                  {row.vaultShares.toString()}
                </td>
                <td className="px-5 py-4 text-right font-mono tabular-nums">
                  {formatUnitsRounded(row.attributedSiloAssets, silo.inputToken.decimals, 2)} {silo.inputToken.symbol}
                </td>
                <td className="px-5 py-4 text-right font-mono tabular-nums">
                  {rewardPlan
                    ? `${formatUnits(
                        rewardPlan.byLeafKey.get(vaultLeafKey(silo.address, vaultAddress, row.address)) ?? ZERO,
                        silo.inputToken.decimals,
                        0,
                      )} ${silo.inputToken.symbol}`
                    : "--"}
                </td>
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

function addCsvReward(csvRewards: Map<string, bigint>, address: string, amount: bigint) {
  csvRewards.set(address, (csvRewards.get(address) ?? ZERO) + amount);
}

function buildRewardPlan(allSilos: SiloSnapshot[], rewardRaw: bigint, rewardDecimals: number): RewardPlan {
  const byLeafKey = new Map<string, bigint>();
  const csvRewards = new Map<string, bigint>();
  let distributed = ZERO;
  let leafAssets = ZERO;
  const totalAssets = allSilos.reduce((sum, silo) => sum + silo.totalAssets, ZERO);

  if (rewardRaw === ZERO || totalAssets === ZERO) {
    return {
      rewardRaw,
      byLeafKey,
      csvRewards,
      totalAssets,
      distributed,
      undistributed: rewardRaw,
      nonAttributableAssets: totalAssets,
    };
  }

  for (const silo of allSilos) {
    for (const lender of silo.directLenders) {
      if (lender.isVault) {
        continue;
      }
      const reward = floorToWholeUnits((rewardRaw * lender.totalAssets) / totalAssets, rewardDecimals);
      byLeafKey.set(directLeafKey(silo.address, lender.address), reward);
      addCsvReward(csvRewards, lender.address, reward);
      distributed += reward;
      leafAssets += lender.totalAssets;
    }

    for (const vault of silo.vaults) {
      if (isVaultWarning(vault)) {
        continue;
      }
      for (const depositor of vault.depositors) {
        const reward = floorToWholeUnits((rewardRaw * depositor.attributedSiloAssets) / totalAssets, rewardDecimals);
        byLeafKey.set(vaultLeafKey(silo.address, vault.address, depositor.address), reward);
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
    totalAssets,
    distributed,
    undistributed: rewardRaw > distributed ? rewardRaw - distributed : ZERO,
    nonAttributableAssets: totalAssets > leafAssets ? totalAssets - leafAssets : ZERO,
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
}: {
  chain: string;
  vault: VaultSnapshot;
  silo: SiloSnapshot;
  expanded: boolean;
  onToggle: () => void;
  addressFilter: string;
  addressTypeFilter: string;
  rewardPlan: RewardPlan | null;
}) {
  const [depositorSort, setDepositorSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const hasWarning = isVaultWarning(vault);
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className={hasWarning ? "font-semibold text-amber-100" : "font-semibold text-emerald-100"}>
            {vault.name || "Unnamed SiloVault"}
          </h3>
          <div className="mt-1">
            <AddressLink address={vault.address} chain={chain} />
          </div>
          <p className={hasWarning ? "mt-2 text-sm text-amber-100/70" : "mt-2 text-sm text-emerald-100/70"}>
            Vault assets: {formatUnitsRounded(vault.vaultSiloAssets, silo.inputToken.decimals, 2)}{" "}
            {silo.inputToken.symbol}
          </p>
        </div>
        {hasWarning ? (
          <span className="rounded-full bg-amber-300/20 px-3 py-1 text-sm text-amber-100">{warningLabel(vault)}</span>
        ) : (
          <button
            className="rounded-full bg-emerald-300/20 px-3 py-1 text-sm text-emerald-100 transition hover:bg-emerald-300/30"
            type="button"
            onClick={onToggle}
          >
            {expanded ? "Collapse" : "Expand"} depositors
          </button>
        )}
      </div>
      {hasWarning ? (
        <div className="mt-4 max-w-2xl space-y-2 text-sm leading-6 text-amber-100/75">
          <p>
            Depositors cannot be enumerated for this vault. Its assets are shown here so reward calculations can
            surface the non-attributable amount.
          </p>
          {unavailableReward > ZERO ? (
            <p className="font-semibold text-amber-100">
              Undistributed from this vault: {formatUnits(unavailableReward, silo.inputToken.decimals)}{" "}
              {silo.inputToken.symbol}
            </p>
          ) : null}
        </div>
      ) : expanded ? (
        <div className="mt-4">
          <DepositorTable
            addressFilter={addressFilter}
            addressTypeFilter={addressTypeFilter}
            chain={chain}
            rewardPlan={rewardPlan}
            rows={vault.depositors}
            silo={silo}
            sortState={depositorSort}
            vaultAddress={vault.address}
            onSort={(key) => setDepositorSort((current) => nextSortState(current, key))}
          />
        </div>
      ) : null}
    </div>
  );
}

function getInitialChain(): ChainSnapshot {
  return chains.find((chain) => chain.silos.length > 0) ?? chains[0];
}

export default function App() {
  const initialChain = getInitialChain();
  const [selectedChainName, setSelectedChainName] = useState(initialChain.chain);
  const [selectedSiloAddress, setSelectedSiloAddress] = useState(initialChain.silos[0]?.address ?? "");
  const [addressFilter, setAddressFilter] = useState("");
  const [addressTypeFilter, setAddressTypeFilter] = useState("all");
  const [directSort, setDirectSort] = useState<TableSortState>({ key: "assets", direction: "desc" });
  const [directExpanded, setDirectExpanded] = useState(true);
  const [expandedVaults, setExpandedVaults] = useState<Record<string, boolean>>({});
  const [rewardInput, setRewardInput] = useState("");

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

  const lenderNeedle = addressFilter.trim().toLowerCase();
  const typeMatches = (addressType: string) => addressTypeFilter === "all" || addressType === addressTypeFilter;
  const filterActive = lenderNeedle.length > 0 || addressTypeFilter !== "all";
  const filteredLenders = selectedSilo
    ? selectedSilo.directLenders.filter((lender) => {
        const addressMatches = lenderNeedle ? lender.address.toLowerCase().includes(lenderNeedle) : true;
        return addressMatches && typeMatches(lender.addressType);
      })
    : [];
  const visibleLenders = selectedSilo ? sortDirectLenders(filteredLenders, directSort) : [];
  const visibleVaults = selectedSilo
    ? selectedSilo.vaults.filter((vault) => {
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
      })
    : [];

  const vaultWarnings = selectedSilo?.vaults.filter(isVaultWarning).length ?? 0;
  const hasVisibleFilterResults = !filterActive || visibleLenders.length > 0 || visibleVaults.length > 0;
  const rewardRaw = selectedSilo ? parseUnits(rewardInput, selectedSilo.inputToken.decimals) : null;
  const rewardInputInvalid = rewardInput.trim() !== "" && rewardRaw === null;
  const rewardPlan =
    selectedSilo && rewardRaw !== null ? buildRewardPlan(allSilos, rewardRaw, selectedSilo.inputToken.decimals) : null;

  function selectChain(chain: ChainSnapshot) {
    setSelectedChainName(chain.chain);
    setSelectedSiloAddress(chain.silos[0]?.address ?? "");
    setAddressTypeFilter("all");
    setDirectExpanded(true);
    setExpandedVaults({});
    setRewardInput("");
  }

  function expandAll() {
    if (!selectedSilo) {
      return;
    }
    setDirectExpanded(true);
    setExpandedVaults(Object.fromEntries(selectedSilo.vaults.map((vault) => [vault.address, true])));
  }

  function collapseAll() {
    if (!selectedSilo) {
      return;
    }
    setDirectExpanded(false);
    setExpandedVaults(Object.fromEntries(selectedSilo.vaults.map((vault) => [vault.address, false])));
  }

  function jumpToVault(vaultAddress: string) {
    setExpandedVaults((current) => ({ ...current, [vaultAddress]: true }));
    window.requestAnimationFrame(() => {
      document.getElementById(vaultElementId(vaultAddress))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
        <header className="border-b border-white/10 pb-8">
          <div>
            <h1 className="max-w-4xl text-4xl font-semibold tracking-tight sm:text-6xl">Review Silo Lenders</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
              Static, no-RPC snapshot explorer for direct holders and vault depositors across chains.
            </p>
          </div>
        </header>

        <div className="min-w-0 space-y-6 py-8">
          <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-slate-950/30 sm:p-5">
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
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
                        onClick={() => {
                          setSelectedSiloAddress(silo.address);
                          setAddressTypeFilter("all");
                          setDirectExpanded(true);
                          setExpandedVaults({});
                          setRewardInput("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedSiloAddress(silo.address);
                            setAddressTypeFilter("all");
                            setDirectExpanded(true);
                            setExpandedVaults({});
                            setRewardInput("");
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-semibold">{silo.inputToken.symbol} Silo</span>
                          {selectedSilo?.address === silo.address ? (
                            <span className="shrink-0 rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                          <AddressLink address={silo.address} chain={selectedChain.chain} />
                          <span>Block {new Intl.NumberFormat("en-US").format(silo.snapshotBlock)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          {selectedSilo ? (
            <section className="min-w-0 space-y-6">
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-slate-950/40">
              <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="text-sm font-medium text-emerald-200">
                    {selectedSilo.inputToken.symbol} / Silo {selectedSilo.siloId ? `#${selectedSilo.siloId}` : "#--"}
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold">Silo lender details</h2>
                  <div className="mt-3">
                    <AddressLink address={selectedSilo.address} chain={selectedChain.chain} />
                  </div>
                  <p className="mt-3 text-sm text-slate-400">
                    Snapshot block {new Intl.NumberFormat("en-US").format(selectedSilo.snapshotBlock)}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Global reward amount</p>
                  <div className="mt-3 flex gap-3">
                    <input
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-300 outline-none placeholder:text-slate-600"
                      placeholder={`0.00 ${selectedSilo.inputToken.symbol}`}
                      value={rewardInput}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setRewardInput(nextValue);
                        if (nextValue.trim()) {
                          setDirectExpanded(true);
                          setExpandedVaults(Object.fromEntries(selectedSilo.vaults.map((vault) => [vault.address, true])));
                        }
                      }}
                    />
                    <button
                      className="rounded-xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
                      disabled={!rewardPlan || rewardPlan.rewardRaw === ZERO || rewardInputInvalid}
                      type="button"
                      onClick={() => {
                        if (!selectedSilo || !rewardPlan) {
                          return;
                        }
                        const rows = [["address", "raw_amount", "assets"]];
                        for (const [address, reward] of [...rewardPlan.csvRewards.entries()].sort(([a], [b]) =>
                          a.localeCompare(b),
                        )) {
                          rows.push([
                            address,
                            reward.toString(),
                            formatUnitsFixed(reward, selectedSilo.inputToken.decimals),
                          ]);
                        }
                        downloadCsv(`global-snapshot-rewards.csv`, rows);
                      }}
                    >
                      Download CSV
                    </button>
                  </div>
                  {rewardInputInvalid ? (
                    <p className="mt-3 text-xs text-amber-200">
                      Enter a non-negative amount with at most {selectedSilo.inputToken.decimals} decimals.
                    </p>
                  ) : rewardPlan && rewardPlan.rewardRaw > ZERO ? (
                    <div className="mt-3 space-y-1 text-xs text-slate-400">
                      <p>
                        Global distributed: {formatUnits(rewardPlan.distributed, selectedSilo.inputToken.decimals)}{" "}
                        {selectedSilo.inputToken.symbol}
                      </p>
                      {rewardPlan.undistributed > ZERO ? (
                        <p className="text-amber-200">
                          Undistributed: {formatUnits(rewardPlan.undistributed, selectedSilo.inputToken.decimals)}{" "}
                          {selectedSilo.inputToken.symbol}
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
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <MetricCard
                  label="Total shares"
                  value={selectedSilo.totalShares.toString()}
                  hint="Collateral supply"
                />
                <MetricCard
                  label="Total assets"
                  value={`${formatUnitsRounded(selectedSilo.totalAssets, selectedSilo.inputToken.decimals, 2)} ${
                    selectedSilo.inputToken.symbol
                  }`}
                  hint="Redeemable silo assets"
                />
                <MetricCard
                  label="Vault assets"
                  value={`${formatUnitsRounded(
                    selectedSilo.vaults.reduce((sum, vault) => sum + vault.vaultSiloAssets, 0n),
                    selectedSilo.inputToken.decimals,
                    2,
                  )} ${selectedSilo.inputToken.symbol}`}
                  hint="Attributable through vault depositors"
                />
              </div>
            </div>

            <div className="grid gap-4 rounded-3xl border border-white/10 bg-white/[0.04] p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(12rem,0.7fr)_auto] lg:items-end">
              <div className="min-w-0">
                <label className="text-xs uppercase tracking-[0.22em] text-slate-500" htmlFor="filter">
                  Address filter
                </label>
                <input
                  id="filter"
                  className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 font-mono text-sm text-slate-300 outline-none placeholder:text-slate-600"
                  placeholder="Search by address substring"
                  value={addressFilter}
                  onChange={(event) => setAddressFilter(event.target.value)}
                />
              </div>
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
            </div>

            {(!filterActive || visibleLenders.length > 0) ? (
              <HolderTable
                chain={selectedChain.chain}
                expanded={directExpanded}
                rows={visibleLenders}
                silo={selectedSilo}
                rewardPlan={rewardPlan}
                sortState={directSort}
                onJumpToVault={jumpToVault}
                onExport={() => {
                  downloadCsv(
                    `${selectedChain.chain}-${selectedSilo.address}-direct-lenders.csv`,
                    [
                      ["Address", "Type", "Assets"],
                      ...visibleLenders.map((row) => [
                        row.address,
                        row.addressType,
                        formatUnitsPlain(row.totalAssets, selectedSilo.inputToken.decimals),
                      ]),
                    ],
                  );
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
                      : `${selectedSilo.vaults.length - vaultWarnings} indexed, ${vaultWarnings} warning${
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
                      chain={selectedChain.chain}
                      expanded={expandedVaults[vault.address] ?? index < DEFAULT_EXPANDED_LIMIT}
                      silo={selectedSilo}
                      rewardPlan={rewardPlan}
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
