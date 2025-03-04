const fetch = require("node-fetch");
const { VersionedTransaction, PublicKey } = require("@solana/web3.js");
const { connection } = require("../utils/solana");
const { SLIPPAGE_BPS } = require("../config/constants");

// Priority fee settings
const PRIORITY_FEE_MICROLAMPORTS = 100000; // 0.1 SOL, adjust as needed
const COMPUTE_UNITS = 600000; // For swaps, adjust based on simulation

async function fetchWithRetry(url, options, retries = 5, delay = 50000) {
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

async function performJupiterSwap(
  withdrawAuthority,
  inputMint,
  outputMint,
  amount,
  isSolOutput
) {
  // Step 1: Get quote from Jupiter
  const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${SLIPPAGE_BPS}`;

  let quoteData;
  try {
    const quoteResponse = await fetchWithRetry(quoteUrl);
    quoteData = await quoteResponse.json();
    if (!quoteData || quoteData.error) {
      throw new Error(
        "Failed to get quote: " + (quoteData?.error || "Unknown error")
      );
    }
  } catch (error) {
    throw new Error(`Quote fetch failed: ${error.message}`);
  }

  // Step 2: Request swap transaction with priority fees included
  let swapData;
  try {
    const swapResponse = await fetchWithRetry(
      "https://api.jup.ag/swap/v1/swap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: withdrawAuthority.publicKey.toBase58(),
          wrapAndUnwrapSol: isSolOutput,
          computeUnitPriceMicroLamports: PRIORITY_FEE_MICROLAMPORTS, // Priority fee
          computeUnitLimit: COMPUTE_UNITS, // Compute budget
        }),
      }
    );
    swapData = await swapResponse.json();
    if (swapData.error) {
      throw new Error("Swap failed: " + swapData.error);
    }
  } catch (error) {
    throw new Error(`Swap request failed: ${error.message}`);
  }

  // Step 3: Deserialize the VersionedTransaction
  const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
  const swapTransaction = VersionedTransaction.deserialize(swapTransactionBuf);

  // Step 4: Update blockhash and sign (no manual instruction modification)
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  swapTransaction.message.recentBlockhash = blockhash; // Update blockhash
  swapTransaction.sign([withdrawAuthority]); // Sign with the updated blockhash

  // Step 5: Simulate transaction (optional, for debugging)
  const simulation = await connection.simulateTransaction(swapTransaction);
  if (simulation.value.err) {
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }
  console.log(
    `Swap simulation: ${simulation.value.unitsConsumed} compute units used`
  );

  // Step 6: Send and confirm transaction
  const swapSignature = await connection.sendRawTransaction(
    swapTransaction.serialize(),
    {
      skipPreflight: false,
      maxRetries: 10,
      preflightCommitment: "confirmed",
    }
  );

  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature: swapSignature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed",
      { maxRetries: 10 }
    );

    if (confirmation.value.err) {
      throw new Error(
        `Confirmation failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    console.log(`Swap completed. TX: ${swapSignature}`);
    return swapSignature;
  } catch (error) {
    throw new Error(`Swap confirmation failed: ${error.message}`);
  }
}

module.exports = { performJupiterSwap };
