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
const COMPUTE_UNITS = 2000000; // Define at module level since it’s static

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
  const priorityFee = Math.max(medianFee * 2, 50_000); // At least 50k µLamports (0.025 SOL)

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
  const tokenAccountsFile = getTokenAccountsFile(outputMint);
  const tokenAccountsCache = loadTokenAccountsCache(tokenAccountsFile);
  const outputMintPk = new PublicKey(outputMint);
  const isBtc = outputMint === "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  let batchTx = new Transaction();
  let instructionsCount = 0;
  let failedHolders = [];
  const PRIORITY_FEE_MICROLAMPORTS = await getDynamicPriorityFee(connection);

  // Check SOL balance
  const solBalance = await connection.getBalance(withdrawAuthority.publicKey);
  console.log(`Withdraw authority SOL balance: ${solBalance / 1e9} SOL`);

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

  // Calculate shares with higher precision
  const totalSupplyBig = BigInt(TOTAL_SUPPLY);
  const amountBig = BigInt(amount);
  let totalDistributed = 0n; // Track distributed amount to avoid exceeding input

  for (const [index, holder] of holders.entries()) {
    console.log(
      `Processing holder ${index + 1}/${holders.length}: ${holder.address}`
    );
    try {
      const holderPk = new PublicKey(holder.address);
      const holderBalance = BigInt(holder.amount);

      // Use floating-point for precision, then convert to integer lamports
      const shareFloat =
        (Number(holderBalance) * Number(amount)) / Number(totalSupplyBig);
      let share = BigInt(Math.max(Math.floor(shareFloat), isBtc ? 1 : 0)); // Minimum 1 lamport for BTC

      // Ensure we don’t exceed the total amount
      if (totalDistributed + share > amountBig) {
        share = amountBig - totalDistributed; // Adjust to fit remaining amount
      }
      if (share === 0n) {
        console.log(`Skipping ${holder.address} (adjusted share is 0)`);
        continue;
      }

      totalDistributed += share;
      console.log(`Calculated share for ${holder.address}: ${share} lamports`);

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

        let holderAtaAddress = tokenAccountsCache[holder.address];
        let holderAtaPubkey;

        if (holderAtaAddress) {
          holderAtaPubkey = new PublicKey(holderAtaAddress);
          const ataInfo = await connection.getAccountInfo(holderAtaPubkey);
          if (!ataInfo || ataInfo.data.length === 0) {
            console.log(
              `Cached ATA ${holderAtaAddress} for ${holder.address} is invalid or empty. Recreating...`
            );
            holderAtaAddress = null;
          } else if (isBtc) {
            console.log(
              `BTC cached ATA ${holderAtaAddress} for ${holder.address} validated`
            );
          }
        }

        if (!holderAtaAddress) {
          console.log(
            `No cached ATA for ${holder.address}, creating new one...`
          );
          if (solBalance < 0.0025 * 1e9) {
            throw new Error(
              `Insufficient SOL (${solBalance / 1e9}) to create ATA for ${
                holder.address
              }`
            );
          }
          const holderAta = await retryOperation(
            async () => {
              const ata = await getOrCreateAssociatedTokenAccount(
                connection,
                withdrawAuthority,
                outputMintPk,
                holderPk,
                false,
                "confirmed"
              );
              const ataInfo = await connection.getAccountInfo(ata.address);
              if (!ataInfo || ataInfo.data.length === 0) {
                throw new Error(
                  `Failed to confirm ATA creation for ${holder.address}`
                );
              }
              return ata;
            },
            3,
            3000
          );
          holderAtaAddress = holderAta.address.toBase58();
          holderAtaPubkey = holderAta.address;
          tokenAccountsCache[holder.address] = holderAtaAddress;
          saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
          console.log(
            `Created and cached ATA ${holderAtaAddress} for ${holder.address}`
          );
        } else {
          holderAtaPubkey = new PublicKey(holderAtaAddress);
        }

        if (isBtc) {
          console.log(
            `Adding BTC transfer: ${sourceAtaPubkey.toBase58()} -> ${holderAtaPubkey.toBase58()}, amount: ${Number(
              share
            )}`
          );
        }
        batchTx.add(
          createTransferInstruction(
            sourceAtaPubkey,
            holderAtaPubkey,
            withdrawAuthority.publicKey,
            Number(share),
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      instructionsCount++;
      console.log(
        `Added instruction for ${holder.address}, batch size: ${instructionsCount}`
      );

      if (instructionsCount >= BATCH_SIZE || totalDistributed >= amountBig) {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        batchTx.recentBlockhash = blockhash;
        batchTx.lastValidBlockHeight = lastValidBlockHeight;
        batchTx.feePayer = withdrawAuthority.publicKey;

        try {
          const signature = await retryOperation(
            async () => {
              const sig = await sendAndConfirmTransaction(
                connection,
                batchTx,
                [withdrawAuthority],
                {
                  commitment: "confirmed",
                  maxRetries: 10,
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                }
              );
              if (isBtc) console.log(`BTC batch TX: ${sig}`);
              return sig;
            },
            3,
            3000
          );
          console.log(
            `Batch of ${instructionsCount} transfers sent. TX: ${signature}`
          );
        } catch (err) {
          console.error(`Batch failed:`, err);
          for (let i = 0; i < instructionsCount; i++) {
            const h = holders[i];
            const hShare = BigInt(
              Math.max(
                Math.floor(
                  (Number(BigInt(h.amount)) * Number(amount)) /
                    Number(totalSupplyBig)
                ),
                isBtc ? 1 : 0
              )
            );
            if (hShare > 0n) failedHolders.push({ holder: h, share: hShare });
          }
        }

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
      console.error(`Error processing ${holder.address}:`, err);
      failedHolders.push({ holder, share });
    }

    if (totalDistributed >= amountBig) {
      console.log(
        `Total distributed (${totalDistributed}) reached or exceeded amount (${amountBig}), stopping distribution`
      );
      break;
    }
  }

  // Handle remaining instructions
  if (instructionsCount > 0) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    batchTx.recentBlockhash = blockhash;
    batchTx.lastValidBlockHeight = lastValidBlockHeight;
    batchTx.feePayer = withdrawAuthority.publicKey;

    try {
      const signature = await retryOperation(
        async () => {
          const sig = await sendAndConfirmTransaction(
            connection,
            batchTx,
            [withdrawAuthority],
            {
              commitment: "confirmed",
              maxRetries: 10,
              skipPreflight: false,
              preflightCommitment: "confirmed",
            }
          );
          if (isBtc) console.log(`BTC final batch TX: ${sig}`);
          return sig;
        },
        3,
        3000
      );
      console.log(
        `Final batch of ${instructionsCount} transfers sent. TX: ${signature}`
      );
    } catch (err) {
      console.error(`Final batch failed:`, err);
      for (let i = 0; i < instructionsCount; i++) {
        const h = holders[i];
        const hShare = BigInt(
          Math.max(
            Math.floor(
              (Number(BigInt(h.amount)) * Number(amount)) /
                Number(totalSupplyBig)
            ),
            isBtc ? 1 : 0
          )
        );
        if (hShare > 0n) failedHolders.push({ holder: h, share: hShare });
      }
    }
  }

  // Retry failed holders
  if (failedHolders.length > 0) {
    console.log(`Retrying ${failedHolders.length} failed holders...`);
    for (const { holder, share } of failedHolders) {
      console.log(`Retrying ${holder.address} with share ${share}`);
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
          let holderAtaPubkey;

          if (!holderAtaAddress) {
            console.log(
              `No cached ATA for retry ${holder.address}, creating...`
            );
            if (solBalance < 0.0025 * 1e9) {
              throw new Error(
                `Insufficient SOL (${solBalance / 1e9}) to create ATA for ${
                  holder.address
                } in retry`
              );
            }
            const holderAta = await retryOperation(
              async () => {
                const ata = await getOrCreateAssociatedTokenAccount(
                  connection,
                  withdrawAuthority,
                  outputMintPk,
                  holderPk,
                  false,
                  "confirmed"
                );
                const ataInfo = await connection.getAccountInfo(ata.address);
                if (!ataInfo || ataInfo.data.length === 0) {
                  throw new Error(
                    `Failed to confirm ATA creation for ${holder.address} in retry`
                  );
                }
                return ata;
              },
              3,
              3000
            );
            holderAtaAddress = holderAta.address.toBase58();
            holderAtaPubkey = holderAta.address;
            tokenAccountsCache[holder.address] = holderAtaAddress;
            saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
            console.log(
              `Retry created ATA ${holderAtaAddress} for ${holder.address}`
            );
          } else {
            holderAtaPubkey = new PublicKey(holderAtaAddress);
            const ataInfo = await connection.getAccountInfo(holderAtaPubkey);
            if (!ataInfo || ataInfo.data.length === 0) {
              throw new Error(
                `Cached ATA ${holderAtaAddress} for ${holder.address} is invalid during retry`
              );
            }
          }

          if (isBtc) {
            console.log(
              `Retrying BTC transfer: ${sourceAtaPubkey.toBase58()} -> ${holderAtaPubkey.toBase58()}, amount: ${Number(
                share
              )}`
            );
          }
          tx.add(
            createTransferInstruction(
              sourceAtaPubkey,
              holderAtaPubkey,
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

        const signature = await retryOperation(
          async () => {
            const sig = await sendAndConfirmTransaction(
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
            if (isBtc) console.log(`BTC retry TX: ${sig}`);
            return sig;
          },
          3,
          3000
        );
        console.log(`Retry for ${holder.address} succeeded. TX: ${signature}`);
      } catch (err) {
        console.error(`Retry failed for ${holder.address}:`, err);
      }
    }
  }

  console.log(
    `Distribution complete. Processed: ${holders.length}, Distributed: ${totalDistributed}, Failed: ${failedHolders.length}`
  );
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
