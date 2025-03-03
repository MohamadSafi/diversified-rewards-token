const { BN } = require("bn.js");
const { isNativeSol } = require("../utils/helpers");
const {
  connection,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} = require("../utils/solana");
const {
  getSplBalance,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} = require("./token");
const { performJupiterSwap } = require("./swap");
const {
  OUTPUT_MINTS,
  TREASURY_WALLET,
  BATCH_SIZE,
  TOTAL_SUPPLY,
  MINT_ADDRESS,
  SIDE_WALLET,
} = require("../config/constants");
const { ComputeBudgetProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

let currentOutputIndex = 0;
const COMPUTE_UNITS = 1000000; // Define at module level since it’s static
const TOKEN_ACCOUNTS_FILE = path.resolve(
  __dirname,
  "../data/TokenAccount.json"
);

async function getDynamicPriorityFee(connection) {
  const recentFees = await connection.getRecentPrioritizationFees();

  if (!recentFees || recentFees.length === 0) {
    return 100_000; // Default high priority fee if no data is available (~0.05 SOL for 500k CU)
  }

  // Sort and find the median fee
  const medianFee = recentFees
    .map((f) => f.prioritizationFee)
    .sort((a, b) => a - b)[Math.floor(recentFees.length / 2)];

  // Apply a multiplier for priority (e.g., 1.5x the median for faster confirmation)
  const priorityFee = Math.max(medianFee * 1.5, 50_000); // At least 50k µLamports (0.025 SOL)

  return priorityFee;
}

/**
 * Ensures that the token account file exists; if not, creates an empty JSON object.
 */
function ensureTokenAccountsFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({}), "utf-8");
  }
}

function getTokenAccountsFile(tokenMint) {
  if (tokenMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
    return path.resolve(__dirname, "../data/USDC-TokenAccount.json");
  } else if (tokenMint === "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs") {
    return path.resolve(__dirname, "../data/ETH-TokenAccount.json");
  } else if (tokenMint === "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh") {
    return path.resolve(__dirname, "../data/BTC-TokenAccount.json");
  } else {
    // Fallback file for other tokens.
    return path.resolve(__dirname, "../data/TokenAccount.json");
  }
}

/**
 * Loads the token accounts cache from the JSON file into an object.
 */
function loadTokenAccountsCache(filePath) {
  ensureTokenAccountsFileExists(filePath);
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data); // e.g. { "holderPubkey": "holderAtaPubkey", ... }
}

/**
 * Saves the updated token accounts object back to the JSON file.
 */
function saveTokenAccountsCache(filePath, tokenAccounts) {
  fs.writeFileSync(filePath, JSON.stringify(tokenAccounts, null, 2), "utf-8");
}

async function retryOperation(operation, maxRetries = 3, delayMs = 3000) {
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

/**
 * Distribute tokens to holders, using a local JSON to avoid repeated getOrCreate calls.
 */
async function distributeToHolders(
  withdrawAuthority,
  holders,
  amount,
  outputMint,
  isSolOutput,
  sourceAtaPubkey
) {
  // Determine which file to use based on the output mint.
  const tokenAccountsFile = getTokenAccountsFile(outputMint);
  const tokenAccountsCache = loadTokenAccountsCache(tokenAccountsFile);
  const outputMintPk = new PublicKey(outputMint);
  let batchTx = new Transaction();
  let instructionsCount = 0;
  let failedHolders = [];
  const PRIORITY_FEE_MICROLAMPORTS = await getDynamicPriorityFee(connection);

  // Add compute budget instructions
  batchTx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS,
    })
  );
  batchTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: COMPUTE_UNITS,
    })
  );

  for (const holder of holders) {
    let share = 0n;
    try {
      const holderPk = new PublicKey(holder.address);
      const holderBalance = BigInt(holder.amount);
      share = (holderBalance * amount) / TOTAL_SUPPLY;
      if (share === 0n) continue;

      if (isSolOutput) {
        const accountInfo = await connection.getAccountInfo(holderPk);
        if (
          !accountInfo ||
          accountInfo.owner.toBase58() !== SystemProgram.programId.toBase58()
        ) {
          console.log(`Skipping ${holder.address} (not system-owned)`);
          continue;
        }
        batchTx.add(
          SystemProgram.transfer({
            fromPubkey: withdrawAuthority.publicKey,
            toPubkey: holderPk,
            lamports: Number(share),
          })
        );
      } else {
        if (!PublicKey.isOnCurve(holderPk)) {
          console.log(`Skipping ${holder.address} - not an Ed25519 key`);
          continue;
        }

        // Check the token-specific cache
        let holderAtaAddress = tokenAccountsCache[holder.address];
        if (!holderAtaAddress) {
          try {
            const holderAta = await retryOperation(() =>
              getOrCreateAssociatedTokenAccount(
                connection,
                withdrawAuthority,
                outputMintPk,
                holderPk,
                false,
                "confirmed"
              )
            );
            holderAtaAddress = holderAta.address.toBase58();
            // Update and persist the cache
            tokenAccountsCache[holder.address] = holderAtaAddress;
            saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
          } catch (err) {
            console.error(
              `Failed to get/create ATA for ${holder.address}:`,
              err
            );
            failedHolders.push({ holder, share });
            continue;
          }
        }
        batchTx.add(
          createTransferInstruction(
            sourceAtaPubkey,
            new PublicKey(holderAtaAddress),
            withdrawAuthority.publicKey,
            Number(share),
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      instructionsCount++;

      if (instructionsCount >= BATCH_SIZE) {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        batchTx.recentBlockhash = blockhash;
        batchTx.lastValidBlockHeight = lastValidBlockHeight;
        batchTx.feePayer = withdrawAuthority.publicKey;

        const signature = await retryOperation(() =>
          sendAndConfirmTransaction(connection, batchTx, [withdrawAuthority], {
            commitment: "confirmed",
            maxRetries: 10,
            skipPreflight: false,
            preflightCommitment: "confirmed",
          })
        );

        console.log(
          `Batch of ${instructionsCount} transfers sent. TX: ${signature}`
        );

        // Reset for next batch, adding compute budget instructions again.
        batchTx = new Transaction();
        batchTx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: PRIORITY_FEE_MICROLAMPORTS,
          })
        );
        batchTx.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: COMPUTE_UNITS,
          })
        );
        instructionsCount = 0;
      }
    } catch (err) {
      console.error(`Error adding ${holder.address} to batch:`, err);
      failedHolders.push({ holder, share });
    }
  }

  // Send any remaining instructions.
  if (instructionsCount > 0) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    batchTx.recentBlockhash = blockhash;
    batchTx.lastValidBlockHeight = lastValidBlockHeight;
    batchTx.feePayer = withdrawAuthority.publicKey;

    const signature = await retryOperation(() =>
      sendAndConfirmTransaction(connection, batchTx, [withdrawAuthority], {
        commitment: "confirmed",
        maxRetries: 10,
        skipPreflight: false,
        preflightCommitment: "confirmed",
      })
    );

    console.log(
      `Final batch of ${instructionsCount} transfers sent. TX: ${signature}`
    );
  }

  // Retry failed holders individually.
  if (failedHolders.length > 0) {
    console.log(`Retrying ${failedHolders.length} failed holders...`);
    for (const { holder, share } of failedHolders) {
      try {
        const holderPk = new PublicKey(holder.address);
        const tx = new Transaction();
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: PRIORITY_FEE_MICROLAMPORTS,
          })
        );
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: COMPUTE_UNITS,
          })
        );

        if (isSolOutput) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: withdrawAuthority.publicKey,
              toPubkey: holderPk,
              lamports: Number(share),
            })
          );
        } else {
          let holderAtaAddress = tokenAccountsCache[holder.address];
          if (!holderAtaAddress) {
            const holderAta = await retryOperation(() =>
              getOrCreateAssociatedTokenAccount(
                connection,
                withdrawAuthority,
                outputMintPk,
                holderPk,
                false,
                "confirmed"
              )
            );
            holderAtaAddress = holderAta.address.toBase58();
            tokenAccountsCache[holder.address] = holderAtaAddress;
            saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
          }
          tx.add(
            createTransferInstruction(
              sourceAtaPubkey,
              new PublicKey(holderAtaAddress),
              withdrawAuthority.publicKey,
              Number(share),
              [],
              TOKEN_PROGRAM_ID
            )
          );
        }

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = withdrawAuthority.publicKey;

        const signature = await retryOperation(() =>
          sendAndConfirmTransaction(connection, tx, [withdrawAuthority], {
            commitment: "confirmed",
            maxRetries: 10,
            skipPreflight: false,
            preflightCommitment: "confirmed",
          })
        );
        console.log(`Retry for ${holder.address} succeeded. TX: ${signature}`);
      } catch (err) {
        console.error(`Retry failed for ${holder.address}:`, err);
      }
    }
  }
}

async function distributeRewards(withdrawAuthority, holders, withdrawnAmount) {
  const outputMint = OUTPUT_MINTS[currentOutputIndex];
  currentOutputIndex = (currentOutputIndex + 1) % OUTPUT_MINTS.length;
  const isSolOutput = isNativeSol(outputMint);
  const outputMintPk = new PublicKey(outputMint);
  const treasuryWalletPk = new PublicKey(
    "CEC28iG14pTEZ6jtKqTRp4tohKYvVKZJAgycfUq5faXg"
  );
  const sideWalletPk = new PublicKey(
    "4BYJtpPXD7mxrzSBi7rkeHehBKW2TzgnAD39vEJddNpt"
  );

  let beforeAmount = 0n;
  let sourceAtaPubkey = null;

  if (isSolOutput) {
    beforeAmount = BigInt(
      await connection.getBalance(withdrawAuthority.publicKey)
    );
  } else {
    try {
      const { ataPubkey, amount } = await getSplBalance(
        outputMintPk,
        withdrawAuthority.publicKey,
        withdrawAuthority
      );
      sourceAtaPubkey = ataPubkey;
      beforeAmount = amount;
    } catch (error) {
      console.error(
        "Error getting withdrawAuthority ATA balance, creating ATA:",
        error
      );
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        withdrawAuthority,
        outputMintPk,
        withdrawAuthority.publicKey,
        false,
        "confirmed"
      );
      sourceAtaPubkey = ata.address;
      beforeAmount = 0n; // Assume 0 if it didn’t exist before
    }
  }

  console.log(`Initiating swap to ${outputMint}...`);
  await performJupiterSwap(
    withdrawAuthority,
    MINT_ADDRESS.toBase58(),
    outputMint,
    withdrawnAmount,
    isSolOutput,
    3
  );

  let afterAmount = 0n;
  if (isSolOutput) {
    afterAmount = BigInt(
      await connection.getBalance(withdrawAuthority.publicKey)
    );
  } else {
    const { amount } = await getSplBalance(
      outputMintPk,
      withdrawAuthority.publicKey,
      withdrawAuthority
    );
    afterAmount = amount;
  }

  const tokensReceived = afterAmount - beforeAmount;
  if (tokensReceived <= 0n) throw new Error("Swap failed - no tokens received");
  console.log(`Received ${tokensReceived} of mint ${outputMint}`);

  const toDistribute = (tokensReceived * 80n) / 100n;
  const toTreasury = (tokensReceived * 17n) / 100n; // 17% to treasury
  const toSideWallet = (tokensReceived * 3n) / 100n; // 3% to side wallet

  // console.log(
  //   `Distributing ${toDistribute} to holders, ${toTreasury} to treasury, ${toSideWallet} to side wallet...`
  // );

  // // Send to Treasury Wallet
  // const treasuryTx = new Transaction();
  // const treasuryPriorityFee = await getDynamicPriorityFee(connection);
  // treasuryTx.add(
  //   ComputeBudgetProgram.setComputeUnitPrice({
  //     microLamports: treasuryPriorityFee,
  //   })
  // );
  // treasuryTx.add(
  //   ComputeBudgetProgram.setComputeUnitLimit({
  //     units: COMPUTE_UNITS,
  //   })
  // );

  // if (isSolOutput) {
  //   treasuryTx.add(
  //     SystemProgram.transfer({
  //       fromPubkey: withdrawAuthority.publicKey,
  //       toPubkey: treasuryWalletPk,
  //       lamports: Number(toTreasury),
  //     })
  //   );
  // } else {
  //   const treasuryAta = await retryOperation(() =>
  //     getOrCreateAssociatedTokenAccount(
  //       connection,
  //       withdrawAuthority,
  //       outputMintPk,
  //       treasuryWalletPk,
  //       false,
  //       "confirmed"
  //     )
  //   );
  //   treasuryTx.add(
  //     createTransferInstruction(
  //       sourceAtaPubkey,
  //       treasuryAta.address,
  //       withdrawAuthority.publicKey,
  //       Number(toTreasury),
  //       [],
  //       TOKEN_PROGRAM_ID
  //     )
  //   );
  // }

  // const treasuryBlockhash = await connection.getLatestBlockhash("confirmed");
  // treasuryTx.recentBlockhash = treasuryBlockhash.blockhash;
  // treasuryTx.lastValidBlockHeight = treasuryBlockhash.lastValidBlockHeight;
  // treasuryTx.feePayer = withdrawAuthority.publicKey;

  // const treasurySignature = await retryOperation(() =>
  //   sendAndConfirmTransaction(connection, treasuryTx, [withdrawAuthority], {
  //     commitment: "confirmed",
  //     maxRetries: 10,
  //     skipPreflight: false,
  //     preflightCommitment: "confirmed",
  //   })
  // );
  // console.log(
  //   `Sent ${toTreasury} to treasury wallet. TX: ${treasurySignature}`
  // );

  // // Send to Side Wallet
  // const sideTx = new Transaction();
  // const sidePriorityFee = await getDynamicPriorityFee(connection);
  // sideTx.add(
  //   ComputeBudgetProgram.setComputeUnitPrice({
  //     microLamports: sidePriorityFee,
  //   })
  // );
  // sideTx.add(
  //   ComputeBudgetProgram.setComputeUnitLimit({
  //     units: COMPUTE_UNITS,
  //   })
  // );

  // if (isSolOutput) {
  //   sideTx.add(
  //     SystemProgram.transfer({
  //       fromPubkey: withdrawAuthority.publicKey,
  //       toPubkey: sideWalletPk,
  //       lamports: Number(toSideWallet),
  //     })
  //   );
  // } else {
  //   const sideAta = await retryOperation(() =>
  //     getOrCreateAssociatedTokenAccount(
  //       connection,
  //       withdrawAuthority,
  //       outputMintPk,
  //       sideWalletPk,
  //       false,
  //       "confirmed"
  //     )
  //   );
  //   sideTx.add(
  //     createTransferInstruction(
  //       sourceAtaPubkey,
  //       sideAta.address,
  //       withdrawAuthority.publicKey,
  //       Number(toSideWallet),
  //       [],
  //       TOKEN_PROGRAM_ID
  //     )
  //   );
  // }

  // const sideBlockhash = await connection.getLatestBlockhash("confirmed");
  // sideTx.recentBlockhash = sideBlockhash.blockhash;
  // sideTx.lastValidBlockHeight = sideBlockhash.lastValidBlockHeight;
  // sideTx.feePayer = withdrawAuthority.publicKey;

  // const sideSignature = await retryOperation(() =>
  //   sendAndConfirmTransaction(connection, sideTx, [withdrawAuthority], {
  //     commitment: "confirmed",
  //     maxRetries: 10,
  //     skipPreflight: false,
  //     preflightCommitment: "confirmed",
  //   })
  // );
  // console.log(`Sent ${toSideWallet} to side wallet. TX: ${sideSignature}`);

  console.log(
    `Distributing ${toDistribute} of mint ${outputMint} to holders...`
  );
  await distributeToHolders(
    withdrawAuthority,
    holders,
    toDistribute,
    outputMint,
    isSolOutput,
    sourceAtaPubkey
  );
}

module.exports = { distributeRewards };
