/** Minimal CSV helpers for Beefy holder exports (Address,Amount,LP,Percent,Contract). */

export type BeefyCsvRow = {
  address: string;
  amountRaw: string;
  lpRaw: string;
  percentRaw: string;
  contract: string;
  amount: bigint;
  lp: bigint;
  /** Percent as a rational: value / 10^scale (e.g. 0.16165225 → 16165225 / 10^8). */
  percentNumer: bigint;
  percentScale: number;
};

export function parseLooseInteger(raw: string): bigint {
  const t = raw.trim().replace(/,/g, "");
  if (!t) {
    return 0n;
  }
  if (/e/i.test(t)) {
    const [coeff, expStr] = t.toLowerCase().split("e");
    const exp = Number(expStr);
    if (!Number.isFinite(exp)) {
      return 0n;
    }
    const negative = coeff.startsWith("-");
    const body = negative ? coeff.slice(1) : coeff.startsWith("+") ? coeff.slice(1) : coeff;
    const [whole, frac = ""] = body.split(".");
    const digits = `${whole}${frac}`.replace(/^0+/, "") || "0";
    const move = exp - frac.length;
    let value: bigint;
    if (move >= 0) {
      value = BigInt(digits) * 10n ** BigInt(move);
    } else {
      value = BigInt(digits) / 10n ** BigInt(-move);
    }
    return negative ? -value : value;
  }
  if (t.includes(".")) {
    const [whole] = t.split(".");
    return BigInt(whole || "0");
  }
  return BigInt(t);
}

export function parsePercent(raw: string): { numer: bigint; scale: number } {
  const t = raw.trim();
  if (!t) {
    return { numer: 0n, scale: 0 };
  }
  const negative = t.startsWith("-");
  const body = negative ? t.slice(1) : t;
  const [whole, frac = ""] = body.split(".");
  const digits = `${whole || "0"}${frac}`.replace(/^0+/, "") || "0";
  const numer = negative ? -BigInt(digits) : BigInt(digits);
  return { numer, scale: frac.length };
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseBeefyCsv(text: string): BeefyCsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = {
    address: header.indexOf("address"),
    amount: header.indexOf("amount"),
    lp: header.indexOf("lp"),
    percent: header.indexOf("percent"),
    contract: header.indexOf("contract"),
  };
  if (idx.address < 0 || idx.amount < 0 || idx.lp < 0 || idx.percent < 0) {
    throw new Error("Beefy CSV missing required columns (Address, Amount, LP, Percent)");
  }

  const rows: BeefyCsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const address = (cells[idx.address] || "").toLowerCase();
    if (!address) {
      continue;
    }
    const amountRaw = cells[idx.amount] || "";
    const lpRaw = cells[idx.lp] || "";
    const percentRaw = cells[idx.percent] || "";
    const contract = idx.contract >= 0 ? cells[idx.contract] || "" : "";
    const { numer, scale } = parsePercent(percentRaw);
    rows.push({
      address,
      amountRaw,
      lpRaw,
      percentRaw,
      contract,
      amount: parseLooseInteger(amountRaw),
      lp: parseLooseInteger(lpRaw),
      percentNumer: numer,
      percentScale: scale,
    });
  }
  return rows;
}
