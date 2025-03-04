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
const {
  connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require("../utils/solana");
const { ComputeBudgetProgram } = require("@solana/web3.js");
const { MINT_ADDRESS, RPC_URL } = require("../config/constants");

const COMPUTE_UNITS = 50000;

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

async function retryOperation(operation, maxRetries = 10, delayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt === maxRetries) throw error;
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

    // If fewer than limit, we've reached the last page
    if (pageHolders.length < 1000) {
      hasMore = false;
    } else {
      page++;
    }

    // Optional: Add a small delay to avoid rate limiting
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

  // Create destination token account
  const destinationTokenAccount = await retryOperation(() =>
    getOrCreateAssociatedTokenAccount(
      connection,
      withdrawAuthority,
      MINT_ADDRESS,
      withdrawAuthority.publicKey,
      false,
      "confirmed",
      undefined,
      TOKEN_2022_PROGRAM_ID
    )
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

  // Process batches sequentially with retries
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `Processing batch ${i + 1}/${batches.length} with ${
        batch.length
      } accounts...`
    );

    const signature = await retryOperation(
      async () => {
        const tx = new Transaction();
        const priorityFee = await getDynamicPriorityFee(connection);
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee,
          })
        );
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: COMPUTE_UNITS,
          })
        );

        tx.add(
          createHarvestWithheldTokensToMintInstruction(
            MINT_ADDRESS,
            batch,
            TOKEN_2022_PROGRAM_ID
          )
        );

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = withdrawAuthority.publicKey;

        const signature = await sendAndConfirmTransaction(
          connection,
          tx,
          [withdrawAuthority],
          {
            commitment: "confirmed",
            maxRetries: 10,
            skipPreflight: false,
            preflightCommitment: "confirmed",
          }
        );
        console.log(
          `Harvest batch ${i + 1} completed. Signature: ${signature}`
        );
        return signature;
      },
      10,
      500 // 10 retries, 500ms delay
    );

    if (!signature) {
      throw new Error(
        `Harvest batch ${i + 1} failed after retries, aborting withdrawal`
      );
    }
    harvestSignatures.push(signature);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Throttle RPC load
  }

  // Only proceed if all batches succeeded
  console.log(
    `All ${batches.length} harvest batches completed successfully. Signatures:`,
    harvestSignatures
  );

  console.log("Withdrawing withheld tokens from the mint...");
  const withdrawTx = new Transaction();
  const withdrawPriorityFee = await getDynamicPriorityFee(connection);
  withdrawTx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: withdrawPriorityFee,
    })
  );
  withdrawTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: COMPUTE_UNITS,
    })
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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  withdrawTx.recentBlockhash = blockhash;
  withdrawTx.lastValidBlockHeight = lastValidBlockHeight;
  withdrawTx.feePayer = withdrawAuthority.publicKey;

  const withdrawSignature = await retryOperation(() =>
    sendAndConfirmTransaction(connection, withdrawTx, [withdrawAuthority], {
      commitment: "confirmed",
      maxRetries: 20,
      skipPreflight: false,
      preflightCommitment: "confirmed",
    })
  );
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
};
