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
} = require("../config/constants");

let currentOutputIndex = 0;

async function sendBatchWithRetry(
  connection,
  batchTx,
  withdrawAuthority,
  retries = 3
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const latestBlockhash = await connection.getLatestBlockhash();
      batchTx.recentBlockhash = latestBlockhash.blockhash;
      batchTx.feePayer = withdrawAuthority.publicKey;
      const signature = await sendAndConfirmTransaction(connection, batchTx, [
        withdrawAuthority,
      ]);
      console.log(
        `Batch of ${batchTx.instructions.length} transfers sent. TX: ${signature}`
      );
      return signature;
    } catch (err) {
      if (attempt === retries) {
        throw err; // After max retries, throw the error
      }
      console.log(`Retry ${attempt}/${retries} failed:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before retry
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

        const holderAta = await getOrCreateAssociatedTokenAccount(
          connection,
          withdrawAuthority,
          outputMintPk,
          holderPk
        );

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
        await sendBatchWithRetry(connection, batchTx, withdrawAuthority);
        batchTx = new Transaction();
        instructionsCount = 0;
      }
    } catch (err) {
      console.error(`Error distributing to ${holder.address}:`, err);
    }
  }

  if (batchTx.instructions.length > 0) {
    await sendBatchWithRetry(connection, batchTx, withdrawAuthority);
  }
}

async function distributeRewards(withdrawAuthority, holders, withdrawnAmount) {
  const outputMint = OUTPUT_MINTS[currentOutputIndex];
  currentOutputIndex = (currentOutputIndex + 1) % OUTPUT_MINTS.length;
  const isSolOutput = isNativeSol(outputMint);
  const outputMintPk = new PublicKey(outputMint);

  let beforeAmount = isSolOutput
    ? BigInt(await connection.getBalance(withdrawAuthority.publicKey))
    : (
        await getSplBalance(
          outputMintPk,
          withdrawAuthority.publicKey,
          withdrawAuthority
        )
      ).amount;

  await performJupiterSwap(
    withdrawAuthority,
    MINT_ADDRESS.toBase58(),
    outputMint,
    withdrawnAmount,
    isSolOutput
  );

  let afterAmount = isSolOutput
    ? BigInt(await connection.getBalance(withdrawAuthority.publicKey))
    : (
        await getSplBalance(
          outputMintPk,
          withdrawAuthority.publicKey,
          withdrawAuthority
        )
      ).amount;

  const tokensReceived = afterAmount - beforeAmount;
  if (tokensReceived <= 0n) throw new Error("Swap failed - no tokens received");

  const toDistribute = (tokensReceived * 4n) / 5n; // 80%
  const toTreasury = (tokensReceived * 5n) / 100n;

  if (toTreasury > 0n) {
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
  }

  const sourceAtaPubkey = !isSolOutput
    ? (
        await getSplBalance(
          outputMintPk,
          withdrawAuthority.publicKey,
          withdrawAuthority
        )
      ).ataPubkey
    : null;

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
