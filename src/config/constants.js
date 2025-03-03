const { PublicKey } = require("@solana/web3.js");
require("dotenv").config();

module.exports = {
  RPC_URL: process.env.RPC_URL,
  MINT_ADDRESS: new PublicKey(process.env.MINT_ADDRESS),
  TREASURY_WALLET: new PublicKey(process.env.TREASURY_WALLET),
  WITHDRAW_AUTHORITY_PRIVATE_KEY: process.env.WITHDRAW_AUTHORITY_PRIVATE_KEY,
  OUTPUT_MINTS: [
    "So11111111111111111111111111111111111111112", // SOL
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", //wBTC
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // wETH
  ],
  BATCH_SIZE: 20,
  SLIPPAGE_BPS: 2000, // 20% slippage
  TOTAL_SUPPLY: 1_000_000_000n * 10n ** BigInt(9),
  DISTRIBUTION_INTERVAL: 180 * 1000, // 3 minutes
};
