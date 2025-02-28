const {
  harvestWithheldTokensToMint,
  withdrawWithheldTokensFromMint,
  getOrCreateAssociatedTokenAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
} = require("@solana/spl-token");
const fetch = require("node-fetch");
const { connection } = require("../utils/solana");
const { MINT_ADDRESS, RPC_URL } = require("../config/constants");
const { PublicKey } = require("@solana/web3.js");

async function fetchWithRetry(url, options, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
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

async function getTokenHolders() {
  let allHolders = [];
  let cursor = null;
  let page = 1;

  while (true) {
    try {
      const response = await fetchWithRetry(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "getTokenAccounts",
          method: "getTokenAccounts",
          params: {
            mint: MINT_ADDRESS.toBase58(),
            page: page,
            limit: 1000,
            cursor: cursor,
            options: { showZeroBalance: false },
          },
        }),
      });

      const data = await response.json();
      if (!data.result?.token_accounts?.length) break;

      allHolders = allHolders.concat(data.result.token_accounts);
      cursor = data.result.cursor;
      page++;
    } catch (error) {
      console.error("Error fetching holders:", error);
      break;
    }
  }

  return allHolders.map((account) => ({
    tokenAccount: account.address,
    address: account.owner,
    amount: account.amount,
  }));
}

async function withdrawFees(withdrawAuthority) {
  try {
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
    const tokenAccounts = holders.map((h) => new PublicKey(h.tokenAccount));

    const BATCH_SIZE = 20; // Adjust based on testing; 20 is conservative
    const batches = [];
    for (let i = 0; i < tokenAccounts.length; i += BATCH_SIZE) {
      batches.push(tokenAccounts.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `Harvesting from ${tokenAccounts.length} token accounts in ${batches.length} batches...`
    );

    const harvestSignatures = [];
    for (const batch of batches) {
      const signature = await harvestWithheldTokensToMint(
        connection,
        withdrawAuthority,
        MINT_ADDRESS,
        batch,
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID
      );
      harvestSignatures.push(signature);
      console.log(`Harvest batch completed. Signature: ${signature}`);
    }

    console.log("Withdrawing withheld tokens from the mint...");
    const withdrawSignature = await withdrawWithheldTokensFromMint(
      connection,
      withdrawAuthority,
      MINT_ADDRESS,
      destinationTokenAccount.address,
      withdrawAuthority.publicKey,
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    console.log("Withdrawal transaction signature:", withdrawSignature);

    const finalBalance = await connection.getTokenAccountBalance(
      destinationTokenAccount.address,
      "confirmed"
    );
    const finalAmount = BigInt(finalBalance.value.amount);

    const withdrawnAmount = finalAmount - initialAmount;
    console.log("Withdrawn amount (calculated):", withdrawnAmount);

    return withdrawnAmount;
  } catch (error) {
    console.error("Withdrawal error:", error);
    return 0n;
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
