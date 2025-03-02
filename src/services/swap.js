const fetch = require("node-fetch");
const { VersionedTransaction } = require("@solana/web3.js");
const { connection } = require("../utils/solana");
const { SLIPPAGE_BPS } = require("../config/constants");

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
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

async function performJupiterSwap(
  withdrawAuthority,
  inputMint,
  outputMint,
  amount,
  isSolOutput
) {
  const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${SLIPPAGE_BPS}`;

  const quoteResponse = await fetchWithRetry(quoteUrl);
  const quoteData = await quoteResponse.json();

  if (!quoteData || quoteData.error) {
    throw new Error(
      "Failed to get quote: " + (quoteData?.error || "Unknown error")
    );
  }

  const swapResponse = await fetchWithRetry("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: withdrawAuthority.publicKey.toBase58(),
      wrapAndUnwrapSol: isSolOutput,
    }),
  });

  const swapData = await swapResponse.json();
  if (swapData.error) {
    throw new Error("Swap failed: " + swapData.error);
  }

  const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
  const swapTransaction = VersionedTransaction.deserialize(swapTransactionBuf);

  const latestBlockhash = await connection.getLatestBlockhash();
  swapTransaction.message.recentBlockhash = latestBlockhash.blockhash;
  swapTransaction.sign([withdrawAuthority]);

  const swapSignature = await connection.sendRawTransaction(
    swapTransaction.serialize()
  );
  await connection.confirmTransaction({
    signature: swapSignature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));
  return swapSignature;
}

module.exports = { performJupiterSwap };
