# **Methodology for Calculating Stream Finance Recovery Claims for Silo Lenders**

This document describes the methodology used by SiloDAO to reconstruct lender balances and calculate recovery claims against Stream Finance. It accompanies the claim submission prepared by SiloDAO's legal counsel and serves as the public technical reference for users wishing to verify or reproduce the calculations.

## **1\. Executive Summary**

Following the Stream Finance incident, Silo reconstructed the lending positions of all affected lenders to determine the outstanding amounts that should be included in recovery claims against Stream Finance.

This document explains:  
• Which lenders are included.  
• How balances were reconstructed.  
• How claim amounts were calculated.  
• Adjustments made for borrowers and for recovery distributions already received.  
• How users can verify their balances.  
• How anyone can reproduce the calculations using the public UI and open-source scripts.

## **2\. Background**

Silo users supplied liquidity either directly into isolated lending markets (Silos) or indirectly through Managed Vaults. Three categories of affected markets exist:

• Markets collateralized by Stream-issued assets (xUSD, xBTC).  
• Markets collateralized by Trevee-issued assets (wstkscUSD, wstkscETH).  
• Markets collateralized by Pendle-issued assets (e.g. PT Wrapped stkscETH 18DEC2025 and PT Wrapped stkscUSD 29MAY2025).

Direct lenders and Managed Vault depositors are included in the same recovery calculation, but their starting balances are reconstructed differently. A direct lender's balance is the amount redeemable from the Silo at the snapshot. A Managed Vault depositor's balance is their proportional share of the assets that the vault had supplied to that Silo. The vault contract itself is not treated as a recovery recipient; its balance is attributed to the underlying depositors.

## **3\. Public Resources**

Public UI: [https://silo-finance.github.io/lenders-snapshot/](https://silo-finance.github.io/lenders-snapshot/)

The UI allows users to:  
• Search for their wallet.  
• Review reconstructed balances.  
• View claim amounts.  
• Inspect the calculation breakdown.

Affected markets:  
https://docs.google.com/spreadsheets/d/12KokCexdD5ON2tG8mfpHakpkV5V0Lt43/edit?gid=749859997\#gid=749859997

We’ve published a [public GitHub repository](https://github.com/silo-finance/lenders-snapshot/tree/master/scripts/lender-snapshot) containing all calculation scripts so anyone can independently reproduce the results.

## **4\. Calculation Methodology**

Step 1 – Snapshot Moment  
The calculations use a common snapshot moment of November 7, 2025, 11:33:16 UTC. Because the affected markets operate on different blockchain networks, each network uses the block corresponding to that moment: Sonic block 54144258, Arbitrum block 397731482, Avalanche block 71568801, and Ethereum block 23747116. The public UI shows the snapshot block applicable to each market.

Step 2 – Identify Impacted Markets  
All affected Stream, Trevee, and Pendle collateral markets were identified using the published market list.

Step 3 – Reconstruct Lender Balances  
Each position is first valued at the snapshot block for its network. The calculation then accounts for activity from the next block through a fixed end block for that network, timestamp-matched to Sonic block 75700045. Deposits, incoming transfers, and loan repayments increase the claim amount. Withdrawals, outgoing transfers, new borrows, outstanding debt at the snapshot, and recovery distributions already received reduce it. The published claim amounts therefore reflect balances as of the end of this review window, not the snapshot block alone.

Interest accrued after the snapshot and DAO or Managed Vault fees are not added as separate calculation entries. Deposits, withdrawals, borrows, and repayments use the asset amounts recorded in the relevant transactions, while share transfers are valued at the snapshot exchange rate because transfer records contain only share quantities.

Step 4 – Borrow Adjustment  
Three Stream markets allowed users to borrow xUSD against their lending position. Because interest continued accruing after the Stream incident, collateral values increased significantly, allowing some users to borrow amounts exceeding their original deposits. To avoid double recovery, each user's claim amount is reduced by the outstanding xUSD debt at the snapshot and by any xUSD borrowed after the snapshot, while repayments made after the snapshot are added back. The xUSD amounts are converted into the lending asset's units on a one-to-one value basis. This treatment may produce a negative claim amount where post-incident borrowing exceeded the value of the snapshot position. The public UI provides a transparent breakdown of deposits, debt, borrows, repayments, and the resulting claim amount.

Step 5 – Distribution Adjustment  
Users who had already received a recovery distribution through Silo have that amount deducted to prevent double recovery. Each distribution is applied across the recipient's compatible positions in the order Trevee, Pendle, and then Stream. A category before the final compatible one is reduced only up to its positive claim balance; the final compatible category absorbs any remainder and may therefore show a negative claim amount. For example, a lender with a reconstructed claim of 100 USDC who previously received 5 USDC from Trevee's backing reserves has a final claim of 95 USDC. Each deduction appears as a distribution entry in the lender's operation history in the UI.

Step 6 – Pendle Markets  
For Pendle-issued collateral, Silo reconstructs lender balances, while Pendle coordinates its own recovery process. Users should follow Pendle's guidance regarding claim submission.

## **5\. Claim Amount Definition**

Claim Amount \= Starting Balance at the Snapshot − Outstanding Debt at the Snapshot \+ Deposits \+ Incoming Transfers \+ Repayments − Withdrawals − Outgoing Transfers − New Borrows − Distributions Already Received

Debt, borrowing, and repayment adjustments apply only to the three Stream markets that allowed borrowing. The result is a signed value: it is not reduced to zero when the calculation produces a negative amount, and negative values are shown as such in the UI.

The Claim Amount represents the amount Silo believes Stream Finance should compensate.

## **6\. Using the Public UI**

1\. Visit [https://silo-finance.github.io/lenders-snapshot/](https://silo-finance.github.io/lenders-snapshot/)  
2\. Select the relevant category (Stream, Trevee, or Pendle).  
3\. Enter your wallet address in the Address Filter.

The UI displays:  
• Net Deposited Assets – The lender's starting balance at the relevant snapshot block, before debt and later activity are applied.  
• Debt – Outstanding xUSD debt at the snapshot block, for the markets that allowed borrowing. Borrows and repayments made after the snapshot appear in the calculation breakdown.  
• Claim Amount – The final amount after all tracked adjustments through the end of the review window.  
• Calculation Breakdown – The deposits, withdrawals, transfers, debt, borrows, repayments, and distributions used to derive the final claim amount, in chronological order.

## **7\. Verification and Transparency**

Users and third parties may verify the calculations by:  
• Inspecting the public UI.  
• Reviewing the [published GitHub repository](https://github.com/silo-finance/lenders-snapshot/tree/master/scripts/lender-snapshot).  
• Reproducing the calculations from on-chain data.  
• Comparing the exported claim spreadsheets with the published methodology.

The repository contains the calculation scripts, the configured market list, the generated snapshot data, and the distribution inputs used for the deductions described in Step 5. Reproducing the scan requires historical (archive) blockchain access for each covered network and a Graph gateway credential. Published snapshot data is checked by an automated quality-assurance script that enforces exact accounting invariants for every lender and vault depositor.

## **8\. Important Limitations**

• Share transfers are converted into asset values using the exchange rate at the relevant snapshot block; transaction-based deposits, withdrawals, borrows, and repayments use their recorded asset amounts.  
• Claim amounts may be negative because of interest timing, post-incident borrowing, fee-share accounting within vaults, or distribution deductions.  
• Where a Managed Vault supplied several markets, the attribution of its remaining claim to an individual market is a calculation convention and does not change the vault's aggregate ownership.  
• Some vaults cannot be fully enumerated; their assets remain visible in the UI even when individual depositors cannot be listed.  
• Share creation and removal associated with deposits and withdrawals are not counted again as transfers, which prevents double counting.  
• Blockchain infrastructure may occasionally return incomplete activity records; the scanner merges repeated results and the quality-assurance process checks exact accounting invariants, subject to the limitations described in the repository.

## **9\. Claim Submission**

For Stream-related claims, SiloDAO intends to use the balances shown in the public UI to submit recovery claims through its legal counsel on behalf of affected lenders. Users do not need to submit individual claims unless the final legal instructions state otherwise.

For Trevee-related claims, the balances shown under “Trevee Claims” in our [public UI](https://silo-finance.github.io/lenders-snapshot/) are provided so affected lenders can verify their positions. Users should follow Trevee's instructions regarding participation in its recovery process; if compensation is received, Silo will assist with distributing the amounts allocated to affected Silo users according to these balances.

For Pendle-related claims, Silo has reconstructed the balances of affected lenders with exposure to Pendle-issued assets. These balances will be shared with the Pendle team so they can proceed with their recovery process and any claims they choose to submit to Stream Finance. The "Pendle Claims" section of the [public UI](https://silo-finance.github.io/lenders-snapshot/) allows affected users to review the balances that will be shared with Pendle.
