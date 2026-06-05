import { useState } from "react";

const chains = ["Sonic", "Ethereum"];

const holders = [
  { address: "0x8f4...b91a", type: "EOA", shares: "7,492,104.87", assets: "7,614.29" },
  { address: "0xc24...a8d0", type: "SiloVault", shares: "2,902,551.10", assets: "2,948.55" },
  { address: "0x19b...7c45", type: "Contract", shares: "881,440.00", assets: "895.21" },
  { address: "0x51a...02ef", type: "EOA", shares: "419,770.54", assets: "426.44" },
];

const depositors = [
  { address: "0x2a0...913d", type: "EOA", shares: "1,004.20", assets: "1,018.84" },
  { address: "0xab4...33f8", type: "EOA", shares: "803.54", assets: "815.26" },
  { address: "0xd91...e3ad", type: "Contract", shares: "240.19", assets: "243.69" },
];

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-emerald-950/20">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-2 text-sm text-slate-400">{hint}</p>
    </div>
  );
}

function DataTable({
  title,
  rows,
  isDepositor,
}: {
  title: string;
  rows: typeof holders;
  isDepositor?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <h3 className="font-semibold text-white">{title}</h3>
        <div className="flex gap-2 text-xs text-slate-400">
          <button className="rounded-full border border-emerald-300/30 px-3 py-1 text-emerald-200">
            Sort shares
          </button>
          <button className="rounded-full border border-white/10 px-3 py-1">Sort assets</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-white/10 text-sm">
          <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-5 py-3 font-medium">Address</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 text-right font-medium">{isDepositor ? "Vault shares" : "Shares"}</th>
              <th className="px-5 py-3 text-right font-medium">
                {isDepositor ? "Attributed assets" : "Assets"}
              </th>
              <th className="px-5 py-3 text-right font-medium">Reward</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-200">
            {rows.map((row) => (
              <tr key={row.address} className="hover:bg-white/[0.03]">
                <td className="px-5 py-4 font-mono text-emerald-200">{row.address}</td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{row.type}</span>
                </td>
                <td className="px-5 py-4 text-right tabular-nums">{row.shares}</td>
                <td className="px-5 py-4 text-right tabular-nums">{row.assets}</td>
                <td className="px-5 py-4 text-right text-slate-500">--</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function App() {
  const [selectedChain, setSelectedChain] = useState("Sonic");

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.20),_transparent_34rem),linear-gradient(135deg,#020617_0%,#0f172a_52%,#05150f_100%)] text-white">
      <section className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-white/10 pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-emerald-200">
              Lenders Snapshot
            </div>
            <h1 className="mt-5 max-w-4xl text-4xl font-semibold tracking-tight sm:text-6xl">
              Review Silo lenders and prepare reward distributions.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
              Static, no-RPC snapshot explorer for direct holders and vault depositors across chains.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-2">
            <div className="grid grid-cols-2 gap-2">
              {chains.map((chain) => (
                <button
                  key={chain}
                  className={`rounded-xl px-5 py-3 text-sm font-semibold transition ${
                    selectedChain === chain
                      ? "bg-emerald-300 text-slate-950 shadow-lg shadow-emerald-500/20"
                      : "text-slate-300 hover:bg-white/10"
                  }`}
                  type="button"
                  onClick={() => setSelectedChain(chain)}
                >
                  {chain}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="grid gap-6 py-8 lg:grid-cols-[21rem_1fr]">
          <aside className="space-y-4">
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Chain</p>
                  <h2 className="mt-1 text-xl font-semibold">{selectedChain}</h2>
                </div>
                <span className="rounded-full bg-emerald-300/10 px-3 py-1 text-sm text-emerald-200">1 silo</span>
              </div>
              <div className="mt-5 space-y-3">
                <button className="w-full rounded-2xl border border-emerald-300/40 bg-emerald-300/10 p-4 text-left shadow-lg shadow-emerald-950/30">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">USDC Silo</span>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs text-slate-300">Selected</span>
                  </div>
                  <p className="mt-2 font-mono text-xs text-emerald-100/80">0x0000...0000</p>
                  <p className="mt-3 text-sm text-slate-400">Snapshot block 54,144,258</p>
                </button>
                <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-500">
                  Additional silos will appear here when the bundled JSON includes them.
                </div>
              </div>
            </div>
          </aside>

          <section className="space-y-6">
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-slate-950/40">
              <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="text-sm font-medium text-emerald-200">USDC / Silo #--</p>
                  <h2 className="mt-2 text-3xl font-semibold">Silo lender details</h2>
                  <a className="mt-3 inline-flex font-mono text-sm text-slate-400 hover:text-emerald-200" href="#">
                    0x0000000000000000000000000000000000000000
                  </a>
                </div>
                <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Reward amount</p>
                  <div className="mt-3 flex gap-3">
                    <input
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-300 outline-none placeholder:text-slate-600"
                      placeholder="0.00 USDC"
                      readOnly
                    />
                    <button className="rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-slate-400">
                      CSV
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">Reward calculation will activate once data is wired.</p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <MetricCard label="Total shares" value="264.37B" hint="Collateral + protected supply" />
                <MetricCard label="Total assets" value="283,410.42" hint="Redeemable silo assets" />
                <MetricCard label="Vault assets" value="2,948.55" hint="Attributable through vault depositors" />
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
              <label className="text-xs uppercase tracking-[0.22em] text-slate-500" htmlFor="filter">
                Address filter
              </label>
              <input
                id="filter"
                className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 font-mono text-sm text-slate-300 outline-none placeholder:text-slate-600"
                placeholder="Search by address substring"
                readOnly
              />
            </div>

            <DataTable title="Direct lenders" rows={holders} />

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">Vaults</h2>
                <span className="text-sm text-slate-400">1 indexed, 1 warning</span>
              </div>
              <div className="rounded-3xl border border-emerald-300/20 bg-emerald-300/[0.06] p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-emerald-100">SiloVault Alpha</h3>
                    <p className="mt-1 font-mono text-xs text-emerald-100/70">0xc24...a8d0</p>
                  </div>
                  <span className="rounded-full bg-emerald-300/20 px-3 py-1 text-sm text-emerald-100">
                    Expanded
                  </span>
                </div>
                <div className="mt-4">
                  <DataTable title="Vault depositors" rows={depositors} isDepositor />
                </div>
              </div>
              <div className="rounded-3xl border border-amber-300/30 bg-amber-300/[0.08] p-5">
                <div className="flex items-start gap-4">
                  <div className="mt-1 h-2.5 w-2.5 rounded-full bg-amber-300" />
                  <div>
                    <h3 className="font-semibold text-amber-100">Vault not indexed</h3>
                    <p className="mt-1 text-sm leading-6 text-amber-100/75">
                      Depositors cannot be enumerated for this vault. Its total assets will be highlighted as
                      undistributed once rewards are calculated.
                    </p>
                    <p className="mt-3 text-sm text-amber-100/70">Vault assets: 412.90 USDC</p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
