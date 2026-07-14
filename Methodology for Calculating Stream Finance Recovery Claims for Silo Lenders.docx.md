# **Methodology for Calculating Stream Finance Recovery Claims for Silo Lenders**

This document describes the methodology used by SiloDAO to reconstruct lender balances and calculate recovery claims against Stream Finance. It accompanies the claim submission prepared by SiloDAO's legal counsel and serves as the public technical reference for users wishing to verify or reproduce the calculations.

## **1\. Executive Summary**

Following the Stream Finance incident, Silo reconstructed the lending positions of all affected lenders to determine the outstanding amounts that should be included in recovery claims against Stream Finance.

This document explains:  
• Which lenders are included.  
• How balances were reconstructed.  
• How claim amounts were calculated.  
• Adjustments made for borrowers and Trevee distributions.  
• How users can verify their balances.  
• How anyone can reproduce the calculations using the public UI and open-source scripts.

## **2\. Background**

Silo users supplied liquidity either directly into isolated lending markets (Silos) or indirectly through Managed Vaults. Three categories of affected markets exist:

• Markets collateralized by Stream-issued assets (xUSD, xBTC).  
• Markets collateralized by Trevee-issued assets (wstkscUSD, wstkscETH).  
• Markets collateralized by Pendle-issued assets (e.g. PT Wrapped stkscETH 18DEC2025 and PT Wrapped stkscUSD 29MAY2025).

For claim calculation purposes, there is no distinction between direct lenders and managed vault depositors because all deposits ultimately provided liquidity to the affected markets.

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

Step 1 – Snapshot Block  
The baseline snapshot block is 54144258, corresponding to the point at which Stream publicly announced the losses.

Step 2 – Identify Impacted Markets  
All affected Stream, Trevee, and Pendle collateral markets were identified using the published market list.

Step 3 – Reconstruct Lender Balances  
Every user's lending position was reconstructed as it existed at block 54144258\. Reconstruction accounted for all subsequent deposits, withdrawals, share transfers, and vault share transfers. Interest accrued after the snapshot, DAO fees, and managed vault fees were intentionally excluded.

Step 4 – Borrow Adjustment  
Three markets allowed users to borrow xUSD. Because interest continued accruing after the Stream incident, collateral values increased significantly, allowing some users to borrow amounts exceeding their original deposits. To avoid double recovery, each user's claim amount is reduced by the outstanding xUSD borrowed as of the snapshot. The public UI provides a transparent breakdown of deposits, debt, and resulting claim amount.

Step 5 – Trevee Adjustment  
Users who had already received a recovery distribution from Trevee had their claim reduced by the amount already distributed through Silo. For example, a lender with a reconstructed claim of 100 USDC who previously received 5 USDC from Trevee's backing reserves has a final Stream claim of 95 USDC.

Step 6 – Pendle Markets  
For Pendle-issued collateral, Silo reconstructs lender balances, while Pendle coordinates its own recovery process. Users should follow Pendle's guidance regarding claim submission.

## **5\. Claim Amount Definition**

Claim Amount \= Snapshot Deposits − Snapshot Borrow Balance − Recovery Already Distributed

The Claim Amount represents the amount Silo believes Stream Finance should compensate.

## **6\. Using the Public UI**

1\. Visit [https://silo-finance.github.io/lenders-snapshot/](https://silo-finance.github.io/lenders-snapshot/)  
2\. Select the relevant category (Stream, Trevee, or Pendle).  
3\. Enter your wallet address in the Address Filter.

The UI displays:  
• Net Deposited Assets – Reconstructed lending balance after borrower adjustments.  
• Debt – Outstanding borrow balance at the snapshot.  
• Claim Amount – Amount included in the recovery claim.  
• Calculation Breakdown – Deposits, withdrawals, transfers, and adjustments used to derive the final claim amount.

## **7\. Verification and Transparency**

Users and third parties may verify the calculations by:  
• Inspecting the public UI.  
• Reviewing the [published GitHub repository](https://github.com/silo-finance/lenders-snapshot/tree/master/scripts/lender-snapshot).  
• Reproducing the calculations from on-chain data.  
• Comparing the exported claim spreadsheets with the published methodology.

## **8\. Claim Submission**

For Stream-related claims, SiloDAO will submit claims through its legal counsel on behalf of affected lenders. Users do not need to submit individual claims.

For Trevee-related claims, Trevee has already submitted its claim to Stream Finance. If compensation is received, Silo will assist with distributing the amounts allocated to affected Silo users according to the balances shown under “Trevee Claims” in our [public UI](https://silo-finance.github.io/lenders-snapshot/).

For Pendle-related claims, Silo has reconstructed the balances of affected lenders with exposure to Pendle-issued assets. These balances will be shared with the Pendle team so they can proceed with their recovery process and any claims they choose to submit to Stream Finance. The "Pendle Claims" section of the [public UI](https://silo-finance.github.io/lenders-snapshot/) allows affected users to review the balances that will be shared with Pendle.