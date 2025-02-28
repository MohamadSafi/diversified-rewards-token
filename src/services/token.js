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

async function getTokenHolders() {
  let allHolders = [];
  let cursor = null;
  let page = 1;

  while (true) {
    try {
      const response = await fetch(RPC_URL, {
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

    const harvestSignature = await harvestWithheldTokensToMint(
      connection,
      withdrawAuthority,
      MINT_ADDRESS,
      tokenAccounts,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

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

    const finalBalance = await connection.getTokenAccountBalance(
      destinationTokenAccount.address,
      "confirmed"
    );
    const finalAmount = BigInt(finalBalance.value.amount);

    return finalAmount - initialAmount;
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
