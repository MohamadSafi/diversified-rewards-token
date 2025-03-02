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
  TOKEN_PROGRAM_ID,
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

let currentOutputIndex = 0;

async function retryOperation(operation, maxRetries = 3, delayMs = 2000) {
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

async function distributeToHolders(
  withdrawAuthority,
  holders,
  amount,
  outputMint,
  isSolOutput,
  sourceAtaPubkey
) {
  let batchTx = new Transaction();
  let instructionsCount = 0;
  const outputMintPk = new PublicKey(outputMint);
  let failedHolders = []; // Track holders that fail for retry

  for (const holder of holders) {
    try {
      const holderPk = new PublicKey(holder.address);
      const holderBalance = BigInt(holder.amount);
      const share = (holderBalance * amount) / TOTAL_SUPPLY;

      if (share === 0n) continue;

      if (isSolOutput) {
        const accountInfo = await connection.getAccountInfo(holderPk);
        if (
          !accountInfo ||
          accountInfo.owner.toBase58() !== SystemProgram.programId.toBase58()
        ) {
          console.log(
            `Skipping ${holder.address} (not a system-owned account)`
          );
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

        let holderAta;
        try {
          holderAta = await retryOperation(() =>
            getOrCreateAssociatedTokenAccount(
              connection,
              withdrawAuthority,
              outputMintPk,
              holderPk,
              false,
              "confirmed"
            )
          );
        } catch (error) {
          console.error(
            `Failed to get/create ATA for ${holder.address} after retries:`,
            error
          );
          failedHolders.push({ holder, share }); // Queue for retry later
          continue;
        }

        batchTx.add(
          createTransferInstruction(
            sourceAtaPubkey,
            holderAta.address,
            withdrawAuthority.publicKey,
            Number(share),
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      instructionsCount++;
      if (instructionsCount === BATCH_SIZE) {
        const signature = await retryOperation(() =>
          sendAndConfirmTransaction(connection, batchTx, [withdrawAuthority])
        );
        console.log(
          `Batch of ${instructionsCount} transfers sent. TX: ${signature}`
        );
        batchTx = new Transaction();
        instructionsCount = 0;
      }
    } catch (err) {
      console.error(`Error distributing to ${holder.address}:`, err);
      failedHolders.push({ holder, share });
    }
  }

  // Send final batch if any
  if (batchTx.instructions.length > 0) {
    const signature = await retryOperation(() =>
      sendAndConfirmTransaction(connection, batchTx, [withdrawAuthority])
    );
    console.log(
      `Final batch of ${batchTx.instructions.length} transfers sent. TX: ${signature}`
    );
  }

  // Retry failed holders
  if (failedHolders.length > 0) {
    console.log(`Retrying ${failedHolders.length} failed holders...`);
    for (const { holder, share } of failedHolders) {
      try {
        const holderPk = new PublicKey(holder.address);
        if (isSolOutput) {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: withdrawAuthority.publicKey,
              toPubkey: holderPk,
              lamports: Number(share),
            })
          );
          const signature = await retryOperation(() =>
            sendAndConfirmTransaction(connection, tx, [withdrawAuthority])
          );
          console.log(
            `Retry for ${holder.address} succeeded. TX: ${signature}`
          );
        } else {
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
          const tx = new Transaction().add(
            createTransferInstruction(
              sourceAtaPubkey,
              holderAta.address,
              withdrawAuthority.publicKey,
              Number(share),
              [],
              TOKEN_PROGRAM_ID
            )
          );
          const signature = await retryOperation(() =>
            sendAndConfirmTransaction(connection, tx, [withdrawAuthority])
          );
          console.log(
            `Retry for ${holder.address} succeeded. TX: ${signature}`
          );
        }
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
  const toTreasury = (tokensReceived * 19n) / 100n;
  const toSideWallet = tokensReceived - toDistribute - toTreasury;

  if (toTreasury > 0n) {
    console.log(`Sending ${toTreasury} to treasury...`);
    if (isSolOutput) {
      const treasuryTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: withdrawAuthority.publicKey,
          toPubkey: TREASURY_WALLET,
          lamports: new BN(toTreasury.toString()),
        })
      );
      await sendAndConfirmTransaction(connection, treasuryTx, [
        withdrawAuthority,
      ]);
    } else {
      const treasuryAta = await getOrCreateAssociatedTokenAccount(
        connection,
        withdrawAuthority,
        outputMintPk,
        TREASURY_WALLET
      );
      const { ataPubkey } = await getSplBalance(
        outputMintPk,
        withdrawAuthority.publicKey,
        withdrawAuthority
      );

      const transferIx = createTransferInstruction(
        ataPubkey,
        treasuryAta.address,
        withdrawAuthority.publicKey,
        Number(toTreasury),
        [],
        TOKEN_PROGRAM_ID
      );
      const tx = new Transaction().add(transferIx);
      await sendAndConfirmTransaction(connection, tx, [withdrawAuthority]);
    }
    console.log("20% sent to treasury.");
  }
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
