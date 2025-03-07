const {
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getOrCreateAssociatedTokenAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
} = require("@solana/spl-token");
const fetch = require("node-fetch");
const web3 = require("@solana/web3.js");
const ComputeBudgetProgram = web3.ComputeBudgetProgram;
const { connection, PublicKey, Transaction } = require("../utils/solana");
const { MINT_ADDRESS, RPC_URL } = require("../config/constants");

const COMPUTE_UNITS = 200000;

async function fetchWithRetry(url, options, retries = 5, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `HTTP error! status: ${response.status}, body: ${errorText}`
        );
      }
      return response;
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(
        `Fetch attempt ${attempt}/${retries} failed: ${error.message}. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function sendAndConfirmWithRetry(
  tx,
  signers,
  maxRetries = 5,
  delayMs = 250
) {
  let lastSignature = null;
  let blockhashInfo = await connection.getLatestBlockhash("confirmed");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (lastSignature) {
        const status = await connection.getSignatureStatus(lastSignature, {
          searchTransactionHistory: true,
        });
        if (status.value && !status.value.err) {
          console.log(
            `Transaction ${lastSignature} already confirmed on-chain`
          );
          return lastSignature;
        }
      }

      blockhashInfo = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhashInfo.blockhash;
      tx.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;
      tx.feePayer = signers[0].publicKey;

      lastSignature = await connection.sendTransaction(tx, signers, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2,
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature: lastSignature,
          blockhash: blockhashInfo.blockhash,
          lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(
          `Confirmation failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      console.log(`Transaction confirmed. Signature: ${lastSignature}`);
      return lastSignature;
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error);
      lastSignature = error.signature || lastSignature;
      if (attempt === maxRetries) {
        console.error("Max retries reached, checking final status...");
        if (lastSignature) {
          const status = await connection.getSignatureStatus(lastSignature, {
            searchTransactionHistory: true,
          });
          if (status.value && !status.value.err) {
            console.log(
              `Transaction ${lastSignature} confirmed despite retries`
            );
            return lastSignature;
          }
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function getDynamicPriorityFee(connection) {
  const recentFees = await connection.getRecentPrioritizationFees();
  const medianFee =
    recentFees.map((f) => f.prioritizationFee).sort((a, b) => a - b)[
      Math.floor(recentFees.length / 2)
    ] || 0;
  return Math.max(medianFee, 10000);
}

async function getTokenHolders() {
  const fetchPage = async (page) => {
    const response = await fetchWithRetry(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `getTokenAccounts-${page}`,
        method: "getTokenAccounts",
        params: {
          mint: MINT_ADDRESS.toBase58(),
          page: page,
          limit: 1000,
          options: { showZeroBalance: false },
        },
      }),
    });
    const data = await response.json();
    return data.result?.token_accounts || [];
  };

  const allHolders = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    console.log(`Fetching page ${page} of token holders...`);
    const pageHolders = await fetchPage(page);
    allHolders.push(...pageHolders);
    if (pageHolders.length < 1000) hasMore = false;
    else page++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!allHolders.length) {
    console.log("No token holders found.");
    return [];
  }

  console.log(`Fetched ${allHolders.length} token holders in total.`);
  return allHolders.map((account) => ({
    tokenAccount: account.address,
    address: account.owner,
    amount: account.amount,
  }));
}

async function withdrawFees(withdrawAuthority) {
  const startTime = Date.now();

  const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    withdrawAuthority,
    MINT_ADDRESS,
    withdrawAuthority.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  const initialBalance = await connection.getTokenAccountBalance(
    destinationTokenAccount.address,
    "confirmed"
  );
  const initialAmount = BigInt(initialBalance.value.amount);

  const holders = await getTokenHolders();
  console.log(`Found ${holders.length} token accounts from Helius API`);
  const tokenAccounts = holders.map((h) => new PublicKey(h.tokenAccount));

  const BATCH_SIZE = 25;
  const batches = [];
  for (let i = 0; i < tokenAccounts.length; i += BATCH_SIZE) {
    batches.push(tokenAccounts.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `Harvesting from ${tokenAccounts.length} token accounts in ${batches.length} batches...`
  );
  const harvestSignatures = [];

  // Parallel harvest with full confirmation
  const harvestPromises = batches.map(async (batch, i) => {
    const tx = new Transaction();
    const priorityFee = await getDynamicPriorityFee(connection);
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
    );
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }));
    tx.add(
      createHarvestWithheldTokensToMintInstruction(
        MINT_ADDRESS,
        batch,
        TOKEN_2022_PROGRAM_ID
      )
    );

    const signature = await sendAndConfirmWithRetry(tx, [withdrawAuthority]);
    if (signature) {
      harvestSignatures.push(signature);
      console.log(`Harvest batch ${i + 1} completed. Signature: ${signature}`);
    } else {
      console.error(`Harvest batch ${i + 1} failed`);
    }
    return signature;
  });

  // Wait for all harvests to confirm
  const results = await Promise.all(harvestPromises);
  console.log(
    `All ${batches.length} harvest batches processed. Signatures:`,
    harvestSignatures
  );

  // Check for failed batches
  if (harvestSignatures.length !== batches.length) {
    console.warn(
      `Only ${harvestSignatures.length}/${batches.length} batches succeeded`
    );
  }

  console.log("Withdrawing withheld tokens from the mint...");
  const withdrawTx = new Transaction();
  const priorityFee = await getDynamicPriorityFee(connection);
  withdrawTx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
  );
  withdrawTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS })
  );
  withdrawTx.add(
    createWithdrawWithheldTokensFromMintInstruction(
      MINT_ADDRESS,
      destinationTokenAccount.address,
      withdrawAuthority.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const withdrawSignature = await sendAndConfirmWithRetry(withdrawTx, [
    withdrawAuthority,
  ]);
  console.log("Withdrawal transaction signature:", withdrawSignature);

  const finalBalance = await connection.getTokenAccountBalance(
    destinationTokenAccount.address,
    "confirmed"
  );
  const finalAmount = BigInt(finalBalance.value.amount);

  const withdrawnAmount = finalAmount - initialAmount;
  console.log("Withdrawn amount (calculated):", withdrawnAmount);
  console.log(`Withdraw took ${Date.now() - startTime}ms`);

  return withdrawnAmount;
}

async function getSplBalance(mintPk, ownerPk, payer) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPk,
    ownerPk
  );
  const balanceInfo = await connection.getTokenAccountBalance(ata.address);
  return {
    ataPubkey: ata.address,
    amount: BigInt(balanceInfo.value.amount),
  };
}

module.exports = {
  getTokenHolders,
  withdrawFees,
  getSplBalance,
  getOrCreateAssociatedTokenAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  sendAndConfirmWithRetry, // Export for use elsewhere
};

