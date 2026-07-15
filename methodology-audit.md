# Audit: Methodology for Calculating Stream Finance Recovery Claims

Audit of `Methodology for Calculating Stream Finance Recovery Claims for Silo Lenders.docx.md` against the implementation. Code and committed snapshot data were treated as the source of truth (`scripts/lender-snapshot/snapshot_lenders.py`, `apply_airdrops.py`, `qa_check.py`, `src/App.tsx`, `src/snapshot.ts`, `src/categories.ts`).

**Verdict: the document was not factually ready for publication.** The core formula, the snapshot-block description, the post-snapshot operation set, and the borrow adjustment did not match the implementation. All corrections proposed below have been applied to the document in this branch.

| Severity | Count |
|---|---|
| Critical (wrong methodology) | 4 |
| Material (misleading scope or omission) | 6 |
| Requires external confirmation | 2 |

---

## Critical findings

### 1. One Sonic block presented as the snapshot for a multi-chain dataset

**Where:** Section 4, Step 1 and Step 3.

**Problem:** The document states that the baseline snapshot block is 54144258 and that every position was reconstructed at that block. That block is only the **Sonic** snapshot block. Stream positions also come from Arbitrum (block 397731482), Avalanche (71568801), and Ethereum (23747116) — all matched to the same moment in time, not the same block number. Additionally, the stored snapshot timestamp is **7 November 2025, 11:33:16 UTC**, while Stream publicly announced the loss on **4 November 2025**, so the statement that the block "corresponds to the point at which Stream publicly announced the losses" is false.

**Evidence:** `snapshot_lenders.py` lines 127–188 (per-chain blocks with "timestamp-matched" comments); `data/stream.json` (`snapshot_block_timestamp: 1762515196`); Silo's public transparency report dated 4 November 2025.

**Fix applied:** Step 1 rewritten to describe a common snapshot moment (7 November 2025, 11:33:16 UTC) with the per-chain block numbers listed.

### 2. Reconstruction step omits operations that change the Claim Amount

**Where:** Section 4, Step 3.

**Problem:** The text lists only deposits, withdrawals, and share transfers. The implementation also accounts for outstanding debt at the snapshot, later borrows, later repayments, and distributions already received — and it stops at a fixed end block (timestamp-matched to Sonic block 75700045), so published amounts reflect the end of the review window, not the snapshot alone.

**Evidence:** `snapshot_lenders.py` `_finalize_pending` (lines 1641–1668); `events_to_block` configuration per chain (lines 96–188); borrow/repay/debt scanning (lines 1766–1917).

**Fix applied:** Step 3 rewritten with the complete operation set and the review-window end point.

### 3. Borrow adjustment describes only the opening debt

**Where:** Section 4, Step 4.

**Problem:** The adjustment is not limited to xUSD debt outstanding at the snapshot. New borrows after the snapshot are also deducted and repayments are added back. The xUSD amounts are converted into the lender asset's units on a 1:1 value basis — a material assumption that was not disclosed. The UI's Debt column shows the snapshot-time debt only; later borrows and repayments appear in the breakdown.

**Evidence:** `snapshot_lenders.py` lines 1766–1794 (1:1 decimal conversion), 1870–1917 (borrow/repay flows and `maxRepay` snapshot debt); three configured two-sided markets (lines 137–141, 179–186).

**Fix applied:** Step 4 rewritten to cover snapshot debt, later borrows, later repayments, the 1:1 conversion, and the possibility of negative results.

### 4. The published Claim Amount formula is incomplete

**Where:** Section 5.

**Problem:** `Claim Amount = Snapshot Deposits − Snapshot Borrow Balance − Recovery Already Distributed` excludes every post-snapshot flow and does not describe the number the scripts produce. The actual value is signed and not clamped to zero.

**Evidence:** `qa_check.py` lines 12–24 and `snapshot_lenders.py` lines 1641–1668 enforce the exact formula with zero tolerance:

```
pending_assets = base_assets − debt_at_snapshot
               + deposits + transfers_in + repays
               − withdrawals − transfers_out − borrows
               − airdrops
```

**Fix applied:** Section 5 replaced with the full formula and the signed-value note.

---

## Material findings

### 5. Direct lenders and vault depositors are calculated differently

**Where:** Section 2, last paragraph. The document says there is "no distinction" between the two groups. The economic treatment is consistent, but the starting balances are reconstructed differently: direct positions use the lender's redeemable Silo balance; vault positions allocate the vault's Silo assets proportionally to vault shares. The vault contract itself is not a claim recipient. **Fix applied:** paragraph rewritten.

### 6. The distribution adjustment is broader than a Trevee-only reduction

**Where:** Section 4, Step 5. Distributions are applied across compatible positions in the order **Trevee → Pendle → Stream**. Earlier categories are capped at positive claim balances; the last compatible category absorbs the remainder and can go negative. Stream positions can receive deductions directly. (`apply_airdrops.py` lines 27–67, 255–326.) **Fix applied:** Step 5 rewritten as a Distribution Adjustment with the cascade described.

### 7. The UI definition of Net Deposited Assets was wrong

**Where:** Section 6. Net Deposited Assets is the **starting snapshot value, before** any adjustments — not "after borrower adjustments". Debt is a separate column (snapshot debt only), and Claim Amount is the fully adjusted result. (`src/App.tsx` lines 420–447, 1597–1613.) **Fix applied:** the UI field list corrected and completed.

### 8. Interest and fee treatment stated too absolutely

**Where:** Section 4, Step 3. Interest and fees are not added as separate entries, but transaction-based flows use the asset amounts recorded at transaction time, and vault fee-related share transfers can produce negative balances for fee recipients. (`src/App.tsx` lines 501–521; `qa_check.py` lines 49–52.) **Fix applied:** nuance added in Step 3 and in the new limitations section.

### 9. Completeness and reproducibility overstated

**Where:** Sections 1, 3, and 7. Some vault depositors cannot be enumerated (vault not indexed or not in the withdraw queue); reproduction requires archive RPC access and a Graph API credential plus the committed distribution CSVs; RPC log responses can occasionally be incomplete, which is why repeated scans are merged and QA has documented limits. **Fix applied:** Section 7 expanded with the reproduction requirements and the QA validation, and the limitations section added.

### 10. Missing valuation and negative-balance caveats

**Where:** absent from the document. Share transfers are valued at the snapshot exchange rate; claims are signed and can be negative; multi-market vault attribution is a calculation convention; mint/burn share events are not double-counted; a few immaterial contract positions carry pinned QA residuals. **Fix applied:** new "Important Limitations" section added.
