import streamData from "../../scripts/lender-snapshot/data/stream.json";
import arbUsdcCsv from "../../data/beefy/silov2_arbitrum_usdc_valamore_with_LP_0xd49e6dd2949ad41900ca677.csv?raw";
import avaxAusdCsv from "../../data/beefy/silov2_avalanche_ausd_valamore_with_LP_0x632F679cFe08F69892e3a0.csv?raw";
import avaxUsdcCsv from "../../data/beefy/silov2_avalanche_usdc_mev_with_LP_0x42EeaBF997DDF03121d9FAd0331f6838915bBCFF.csv?raw";
import avaxUsdtCsv from "../../data/beefy/silov2_avalanche_usdt_valamore_with_LP_0xf9D8C8572CABB23f8a3b75.csv?raw";
import { mulPercent, parseBeefyCsv, type BeefyCsvRow } from "./parseCsv";

type StreamInputToken = {
  address: string;
  decimals: number;
  symbol: string;
};

type StreamDepositor = {
  pending_assets?: string | number;
};

type StreamVault = {
  name?: string;
  depositors?: Record<string, StreamDepositor>;
};

type StreamSilo = {
  input_token: StreamInputToken;
  vaults?: Record<string, StreamVault>;
};

type StreamRoot = Record<
  string,
  {
    chain_id: number;
    silos: Record<string, StreamSilo>;
  }
>;

type BeefyVaultDef = {
  id: string;
  label: string;
  proxyAddress: string;
  chain: string;
  vaultAddress: string;
  csv: string;
};

const VAULT_DEFS: BeefyVaultDef[] = [
  {
    id: "arbitrum-usdc-valamore",
    label: "Arbitrum USDC (Varlamore)",
    proxyAddress: "0xd49e6dd2949ad41900ca6779d1d23d7754935af5",
    chain: "arbitrum",
    vaultAddress: "0x2ba39e5388ac6c702cb29aea78d52aa66832f1ee",
    csv: arbUsdcCsv,
  },
  {
    id: "avalanche-usdc-mev",
    label: "Avalanche USDC (MEV)",
    proxyAddress: "0x42eeabf997ddf03121d9fad0331f6838915bbcff",
    chain: "avalanche",
    vaultAddress: "0x4dc1ce9b9f9ef00c144bfad305f16c62293dc0e8",
    csv: avaxUsdcCsv,
  },
  {
    id: "avalanche-ausd-valamore",
    label: "Avalanche AUSD (Varlamore)",
    proxyAddress: "0x632f679cfe08f69892e3a09185c25711dbf68ec9",
    chain: "avalanche",
    vaultAddress: "0x3d7b0c3997e48fa3fc96cd057d1fb4e5f891835b",
    csv: avaxAusdCsv,
  },
  {
    id: "avalanche-usdt-valamore",
    label: "Avalanche USDt (Varlamore)",
    proxyAddress: "0xf9d8c8572cabb23f8a3b75a343cd761dccb04eb6",
    chain: "avalanche",
    vaultAddress: "0x6c09bfdc1df45d6c4ff78dc9f1c13af29eb335d4",
    csv: avaxUsdtCsv,
  },
];

export type BeefyHolder = BeefyCsvRow & {
  netAmount: bigint;
};

export type BeefyVaultSnapshot = {
  id: string;
  label: string;
  proxyAddress: string;
  chain: string;
  chainId: number;
  vaultAddress: string;
  vaultName: string;
  siloAddress: string;
  inputToken: StreamInputToken;
  /** Proxy net deposited assets from the Stream snapshot (raw integer). */
  totalPendingAssets: bigint;
  holders: BeefyHolder[];
};

function lookupStreamPosition(
  root: StreamRoot,
  chain: string,
  vaultAddress: string,
  proxyAddress: string,
): {
  chainId: number;
  siloAddress: string;
  vaultName: string;
  inputToken: StreamInputToken;
  totalPendingAssets: bigint;
} {
  const chainData = root[chain];
  if (!chainData) {
    throw new Error(`Stream snapshot missing chain '${chain}'`);
  }
  const vaultKey = vaultAddress.toLowerCase();
  const proxyKey = proxyAddress.toLowerCase();

  for (const [siloAddress, silo] of Object.entries(chainData.silos)) {
    const vault = silo.vaults?.[vaultKey];
    if (!vault) {
      continue;
    }
    const depositor = vault.depositors?.[proxyKey];
    if (!depositor || depositor.pending_assets === undefined || depositor.pending_assets === null) {
      throw new Error(`Stream snapshot missing pending_assets for proxy ${proxyAddress} in vault ${vaultAddress}`);
    }
    return {
      chainId: chainData.chain_id,
      siloAddress,
      vaultName: vault.name || vaultAddress,
      inputToken: silo.input_token,
      totalPendingAssets: BigInt(String(depositor.pending_assets)),
    };
  }
  throw new Error(`Stream snapshot missing vault ${vaultAddress} on ${chain}`);
}

function buildVault(def: BeefyVaultDef, root: StreamRoot): BeefyVaultSnapshot {
  const meta = lookupStreamPosition(root, def.chain, def.vaultAddress, def.proxyAddress);
  const rows = parseBeefyCsv(def.csv);
  const holders: BeefyHolder[] = rows.map((row) => ({
    ...row,
    netAmount: mulPercent(meta.totalPendingAssets, row.percentNumer, row.percentScale),
  }));
  return {
    id: def.id,
    label: def.label,
    proxyAddress: def.proxyAddress,
    chain: def.chain,
    chainId: meta.chainId,
    vaultAddress: def.vaultAddress,
    vaultName: meta.vaultName,
    siloAddress: meta.siloAddress,
    inputToken: meta.inputToken,
    totalPendingAssets: meta.totalPendingAssets,
    holders,
  };
}

const root = streamData as unknown as StreamRoot;

/** All Beefy proxy vaults with holders and Net Amount attributed from Stream pending assets. */
export const BEEFY_VAULTS: BeefyVaultSnapshot[] = VAULT_DEFS.map((def) => buildVault(def, root));
