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

const COMPUTE_UNITS = 500000;

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
  return Math.max(medianFee, 30000); // Higher minimum for speed
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

  // Estimate pages (e.g., fetch first page to get total, then parallelize)
  const firstPage = await fetchPage(1);
  if (!firstPage.length) return [];

  const estimatedPages = Math.ceil(250 / 1000) || 1; // Replace with actual total if API provides it
  const pagePromises = [];
  for (let page = 2; page <= estimatedPages; page++) {
    pagePromises.push(fetchPage(page));
  }

  const allPages = [firstPage, ...(await Promise.all(pagePromises))];
  const allHolders = allPages.flat();

  return allHolders.map((account) => ({
    tokenAccount: account.address,
    address: account.owner,
    amount: account.amount,
  }));
}

async function withdrawFees(withdrawAuthority) {
  try {
    const startTime = Date.now();

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

    const BATCH_SIZE = 25; // Increased for fewer batches
    const batches = [];
    for (let i = 0; i < tokenAccounts.length; i += BATCH_SIZE) {
      batches.push(tokenAccounts.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `Harvesting from ${tokenAccounts.length} token accounts in ${batches.length} batches...`
    );
    const harvestSignatures = [];

    const concurrencyLimit = 1; // Increased for faster parallel processing
    const batchPromises = [];
    for (const batch of batches) {
      const harvestPromise = retryOperation(
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
              maxRetries: 20, // Aggressive retries
              skipPreflight: false,
              preflightCommitment: "confirmed",
            }
          );
          console.log(`Harvest batch completed. Signature: ${signature}`);
          return signature;
        },
        10,
        500
      ); // More retries, shorter delay

      batchPromises.push(harvestPromise);

      if (batchPromises.length >= concurrencyLimit) {
        harvestSignatures.push(...(await Promise.all(batchPromises)));
        batchPromises.length = 0;
        await new Promise((resolve) => setTimeout(resolve, 100)); // Throttle RPC load
      }
    }
    if (batchPromises.length > 0) {
      harvestSignatures.push(...(await Promise.all(batchPromises)));
    }

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
  } catch (error) {
    console.error("Withdrawal error:", error);
    return withdrawnAmount;
  }
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
