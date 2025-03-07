const fetch = require("node-fetch");
const { VersionedTransaction, PublicKey } = require("@solana/web3.js");
const { connection } = require("../utils/solana");
const { SLIPPAGE_BPS } = require("../config/constants");

// Priority fee settings
const PRIORITY_FEE_MICROLAMPORTS = 100000; // 0.1 SOL
const COMPUTE_UNITS = 600000; // For swaps

async function fetchWithRetry(url, options, retries = 5, delay = 5000) {
  // Reduced delay from 50s to 5s for faster retries
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

async function sendAndConfirmVersionedTxWithRetry(
  tx,
  signers,
  maxRetries = 5,
  delayMs = 250
) {
  let lastSignature = null;
  let blockhashInfo = await connection.getLatestBlockhash("confirmed");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Check if the last signature is already confirmed
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

      // Update blockhash and sign
      blockhashInfo = await connection.getLatestBlockhash("confirmed");
      tx.message.recentBlockhash = blockhashInfo.blockhash;
      tx.sign(signers);

      // Send the transaction
      lastSignature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2, // Initial retries within send
      });

      // Confirm the transaction
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
      lastSignature =
        error.signature || lastSignature || tx.signatures[0]?.toString(); // Fallback to tx signature if available
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
            return lastSignature; // Success if confirmed on-chain
          }
        }
        throw error; // Final failure if still unconfirmed
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
          computeUnitPriceMicroLamports: PRIORITY_FEE_MICROLAMPORTS,
          computeUnitLimit: COMPUTE_UNITS,
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

  // Step 4: Simulate transaction (optional, for debugging)
  const simulation = await connection.simulateTransaction(swapTransaction);
  if (simulation.value.err) {
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }
  console.log(
    `Swap simulation: ${simulation.value.unitsConsumed} compute units used`
  );

  // Step 5: Send and confirm with retry logic
  const swapSignature = await sendAndConfirmVersionedTxWithRetry(
    swapTransaction,
    [withdrawAuthority]
  );
  console.log(`Swap completed. TX: ${swapSignature}`);
  return swapSignature;
}

module.exports = { performJupiterSwap, sendAndConfirmVersionedTxWithRetry }; // Export for reuse

