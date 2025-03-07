const { BN } = require("bn.js");
const { isNativeSol } = require("../utils/helpers");
const {
  connection,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("../utils/solana");
const {
  getSplBalance,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  sendAndConfirmWithRetry,
  TOKEN_PROGRAM_ID,
} = require("./token");
const { performJupiterSwap } = require("./swap");
const {
  OUTPUT_MINTS,
  BATCH_SIZE,
  TOTAL_SUPPLY,
  MINT_ADDRESS,
} = require("../config/constants");
const { ComputeBudgetProgram } = require("@solana/web3.js");
const { createAssociatedTokenAccountInstruction } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const { getDrtPriceInUsd } = require("./price");

let currentOutputIndex = 0;
const COMPUTE_UNITS_TRANSFER = 100000;
const COMPUTE_UNITS_SWAP = 300000;

async function getDynamicPriorityFee(connection) {
  const recentFees = await connection.getRecentPrioritizationFees();
  const medianFee = recentFees
    .map((f) => f.prioritizationFee)
    .sort((a, b) => a - b)[Math.floor(recentFees.length / 2)] || 0;
  return Math.max(medianFee * 1.5, 50000);
}

function ensureTokenAccountsFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({}), "utf-8");
  }
}

function getTokenAccountsFile(tokenMint) {
  const files = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "../data/USDC-TokenAccount.json",
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "../data/ETH-TokenAccount.json",
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "../data/BTC-TokenAccount.json",
  };
  return path.resolve(__dirname, files[tokenMint] || "../data/TokenAccount.json");
}

function loadTokenAccountsCache(filePath) {
  ensureTokenAccountsFileExists(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveTokenAccountsCache(filePath, tokenAccounts) {
  fs.writeFileSync(filePath, JSON.stringify(tokenAccounts, null, 2), "utf-8");
}

async function createAndConfirmATA(withdrawAuthority, outputMintPk, holderPk) {
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
    console.log(`Initial ATA creation for ${holderPk} failed, retrying with explicit transaction...`);
    const tx = new Transaction();
    const PRIORITY_FEE_MICROLAMPORTS = await getDynamicPriorityFee(connection);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_TRANSFER }));
    tx.add(createAssociatedTokenAccountInstruction(
      withdrawAuthority.publicKey,
      ata.address,
      holderPk,
      outputMintPk,
      TOKEN_PROGRAM_ID
    ));
    const signature = await sendAndConfirmWithRetry(tx, [withdrawAuthority]);
    console.log(`ATA creation TX: ${signature}`);
    const retryInfo = await connection.getAccountInfo(ata.address);
    if (!retryInfo || retryInfo.data.length === 0) {
      throw new Error(`ATA creation for ${holderPk} failed to confirm after retry`);
    }
  }
  return ata;
}

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

  const solBalance = await connection.getBalance(withdrawAuthority.publicKey);
  console.log(`Withdraw authority SOL balance: ${solBalance / 1e9} SOL`);

  const drtPriceUsd = await getDrtPriceInUsd();
  const DRT_DECIMALS = 9;
  const DOLLARS_THRESHOLD = 15;
  const MINIMUM_BALANCE = BigInt(Math.ceil((DOLLARS_THRESHOLD / drtPriceUsd) * 10 ** DRT_DECIMALS));
  console.log(`Minimum DRT balance: ${MINIMUM_BALANCE} ($${DOLLARS_THRESHOLD})`);

  batchTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }));
  batchTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_TRANSFER }));

  const totalSupplyBig = BigInt(TOTAL_SUPPLY);
  const amountBig = BigInt(amount);
  let totalDistributed = 0n;

  for (const [index, holder] of holders.entries()) {
    console.log(`Processing holder ${index + 1}/${holders.length}: ${holder.address}`);
    let share; // Declare share here to ensure scope
    try {
      const holderPk = new PublicKey(holder.address);
      const holderBalance = BigInt(holder.amount);

      if (holderBalance === 0n || holderBalance <= MINIMUM_BALANCE) {
        console.log(`Skipping ${holder.address} (balance ${holderBalance} <= ${MINIMUM_BALANCE})`);
        continue;
      }

      const shareFloat = (Number(holderBalance) * Number(amount)) / Number(totalSupplyBig);
      share = BigInt(Math.floor(shareFloat));
      if (isBtc && share === 0n && holderBalance > 0n) share = 1n;
      if (totalDistributed + share > amountBig) share = amountBig - totalDistributed;
      if (share === 0n) {
        console.log(`Skipping ${holder.address} (adjusted share is 0)`);
        continue;
      }

      totalDistributed += share;
      console.log(`Calculated share for ${holder.address}: ${share}`);

      if (isSolOutput) {
        const accountInfo = await connection.getAccountInfo(holderPk);
        if (!accountInfo || accountInfo.owner.toBase58() !== SystemProgram.programId.toBase58()) {
          console.log(`Skipping ${holder.address} (not system-owned)`);
          continue;
        }
        batchTx.add(SystemProgram.transfer({
          fromPubkey: withdrawAuthority.publicKey,
          toPubkey: holderPk,
          lamports: Number(share),
        }));
      } else {
        if (!PublicKey.isOnCurve(holderPk)) {
          console.log(`Skipping ${holder.address} - not an Ed25519 key`);
          continue;
        }

        let holderAtaPubkey;
        const cachedAta = tokenAccountsCache[holder.address];

        if (cachedAta) {
          holderAtaPubkey = new PublicKey(cachedAta);
          const ataInfo = await connection.getAccountInfo(holderAtaPubkey);
          if (!ataInfo || ataInfo.data.length === 0 || ataInfo.owner.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
            console.log(`Cached ATA ${holderAtaPubkey} for ${holder.address} is invalid, recreating...`);
            delete tokenAccountsCache[holder.address];
          } else {
            console.log(`Using valid cached ATA ${holderAtaPubkey} for ${holder.address}`);
          }
        }

        if (!tokenAccountsCache[holder.address]) {
          console.log(`No valid cached ATA for ${holder.address}, creating...`);
          if (solBalance < 0.0025 * 1e9) {
            throw new Error(`Insufficient SOL (${solBalance / 1e9}) for ATA creation`);
          }
          const holderAta = await createAndConfirmATA(withdrawAuthority, outputMintPk, holderPk);
          holderAtaPubkey = holderAta.address;
          tokenAccountsCache[holder.address] = holderAtaPubkey.toBase58();
          saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
          console.log(`Created and cached ATA ${holderAtaPubkey} for ${holder.address}`);
        } else {
          holderAtaPubkey = new PublicKey(tokenAccountsCache[holder.address]);
        }

        batchTx.add(createTransferInstruction(
          sourceAtaPubkey,
          holderAtaPubkey,
          withdrawAuthority.publicKey,
          Number(share),
          [],
          TOKEN_PROGRAM_ID
        ));
      }

      instructionsCount++;
      console.log(`Added instruction for ${holder.address}, batch size: ${instructionsCount}`);

      if (instructionsCount >= BATCH_SIZE || totalDistributed >= amountBig) {
        try {
          const signature = await sendAndConfirmWithRetry(batchTx, [withdrawAuthority]);
          console.log(`Batch of ${instructionsCount} transfers sent. TX: ${signature}`);
        } catch (error) {
          console.error(`Batch failed:`, error);
          totalDistributed -= share; // Use scoped share
          failedHolders.push({ holder, share });
        }
        batchTx = new Transaction();
        batchTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }));
        batchTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_TRANSFER }));
        instructionsCount = 0;
      }
    } catch (err) {
      console.error(`Error processing ${holder.address}:`, err);
      if (share) { // Only push if share was calculated
        failedHolders.push({ holder, share });
      }
    }

    if (totalDistributed >= amountBig) {
      console.log(`Total distributed (${totalDistributed}) reached amount (${amountBig})`);
      break;
    }
  }

  if (instructionsCount > 0) {
    try {
      const signature = await sendAndConfirmWithRetry(batchTx, [withdrawAuthority]);
      console.log(`Final batch of ${instructionsCount} transfers sent. TX: ${signature}`);
    } catch (error) {
      console.error(`Final batch failed:`, error);
      failedHolders.push(...holders.slice(holders.length - instructionsCount).map(h => ({
        holder: h,
        share: BigInt(Math.floor((Number(BigInt(h.amount)) * Number(amount)) / Number(totalSupplyBig)))
      })));
    }
  }

  if (failedHolders.length > 0) {
    console.log(`Retrying ${failedHolders.length} failed holders...`);
    for (const { holder, share } of failedHolders) {
      console.log(`Retrying ${holder.address} with share ${share}`);
      try {
        const holderPk = new PublicKey(holder.address);
        const holderBalance = BigInt(holder.amount);
        if (holderBalance <= MINIMUM_BALANCE) continue;

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_TRANSFER }));

        if (isSolOutput) {
          tx.add(SystemProgram.transfer({
            fromPubkey: withdrawAuthority.publicKey,
            toPubkey: holderPk,
            lamports: Number(share),
          }));
        } else {
          let holderAtaPubkey;
          const cachedAta = tokenAccountsCache[holder.address];
          if (cachedAta) {
            holderAtaPubkey = new PublicKey(cachedAta);
            const ataInfo = await connection.getAccountInfo(holderAtaPubkey);
            if (!ataInfo || ataInfo.data.length === 0 || ataInfo.owner.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
              delete tokenAccountsCache[holder.address];
            }
          }
          if (!tokenAccountsCache[holder.address]) {
            const holderAta = await createAndConfirmATA(withdrawAuthority, outputMintPk, holderPk);
            holderAtaPubkey = holderAta.address;
            tokenAccountsCache[holder.address] = holderAtaPubkey.toBase58();
            saveTokenAccountsCache(tokenAccountsFile, tokenAccountsCache);
          } else {
            holderAtaPubkey = new PublicKey(tokenAccountsCache[holder.address]);
          }
          tx.add(createTransferInstruction(
            sourceAtaPubkey,
            holderAtaPubkey,
            withdrawAuthority.publicKey,
            Number(share),
            [],
            TOKEN_PROGRAM_ID
          ));
        }

        const signature = await sendAndConfirmWithRetry(tx, [withdrawAuthority]);
        console.log(`Retry for ${holder.address} succeeded. TX: ${signature}`);
      } catch (err) {
        console.error(`Retry failed for ${holder.address}:`, err);
      }
    }
  }

  console.log(`Distributed: ${totalDistributed}, Failed: ${failedHolders.length}`);
}

async function distributeRewards(withdrawAuthority, holders, withdrawnAmount) {
  const outputMint = OUTPUT_MINTS[currentOutputIndex];
  currentOutputIndex = (currentOutputIndex + 1) % OUTPUT_MINTS.length;
  const isSolOutput = isNativeSol(outputMint);
  const outputMintPk = new PublicKey(outputMint);
  const treasuryWalletPk = new PublicKey("CEC28iG14pTEZ6jtKqTRp4tohKYvVKZJAgycfUq5faXg");
  const devWalletPk = new PublicKey("4BYJtpPXD7mxrzSBi7rkeHehBKW2TzgnAD39vEJddNpt");

  let beforeAmount = 0n;
  let sourceAtaPubkey = null;

  if (isSolOutput) {
    beforeAmount = BigInt(await connection.getBalance(withdrawAuthority.publicKey));
  } else {
    const { ataPubkey, amount } = await getSplBalance(outputMintPk, withdrawAuthority.publicKey, withdrawAuthority);
    sourceAtaPubkey = ataPubkey;
    beforeAmount = amount;
  }

  console.log(`Initiating swap to ${outputMint}...`);
  await performJupiterSwap(withdrawAuthority, MINT_ADDRESS.toBase58(), outputMint, withdrawnAmount, isSolOutput);

  let afterAmount = isSolOutput
    ? BigInt(await connection.getBalance(withdrawAuthority.publicKey))
    : (await getSplBalance(outputMintPk, withdrawAuthority.publicKey, withdrawAuthority)).amount;

  const tokensReceived = afterAmount - beforeAmount;
  if (tokensReceived <= 0n) throw new Error("Swap failed - no tokens received");
  console.log(`Received ${tokensReceived} of mint ${outputMint}`);

  const toDistribute = (tokensReceived * 80n) / 100n;
  const toTreasury = (tokensReceived * 17n) / 100n;
  const toDevWallet = (tokensReceived * 3n) / 100n;

  const tx = new Transaction();
  const PRIORITY_FEE_MICROLAMPORTS = await getDynamicPriorityFee(connection);
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_TRANSFER }));

  if (isSolOutput) {
    tx.add(SystemProgram.transfer({
      fromPubkey: withdrawAuthority.publicKey,
      toPubkey: treasuryWalletPk,
      lamports: Number(toTreasury),
    }));
    tx.add(SystemProgram.transfer({
      fromPubkey: withdrawAuthority.publicKey,
      toPubkey: devWalletPk,
      lamports: Number(toDevWallet),
    }));
  } else {
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      connection,
      withdrawAuthority,
      outputMintPk,
      treasuryWalletPk,
      false,
      "confirmed"
    );
    const devWalletAta = await getOrCreateAssociatedTokenAccount(
      connection,
      withdrawAuthority,
      outputMintPk,
      devWalletPk,
      false,
      "confirmed"
    );
    tx.add(createTransferInstruction(
      sourceAtaPubkey,
      treasuryAta.address,
      withdrawAuthority.publicKey,
      Number(toTreasury),
      [],
      TOKEN_PROGRAM_ID
    ));
    tx.add(createTransferInstruction(
      sourceAtaPubkey,
      devWalletAta.address,
      withdrawAuthority.publicKey,
      Number(toDevWallet),
      [],
      TOKEN_PROGRAM_ID
    ));
  }

  const signature = await sendAndConfirmWithRetry(tx, [withdrawAuthority]);
  console.log(`Treasury and dev wallet transfers completed. TX: ${signature}`);

  console.log(`Distributing ${toDistribute} of mint ${outputMint} to holders...`);
  await distributeToHolders(withdrawAuthority, holders, toDistribute, outputMint, isSolOutput, sourceAtaPubkey);
}

module.exports = { distributeRewards };
