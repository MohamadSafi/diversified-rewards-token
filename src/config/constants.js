const { PublicKey } = require("@solana/web3.js");
require("dotenv").config();

module.exports = {
  RPC_URL: process.env.RPC_URL,
  MINT_ADDRESS: new PublicKey(process.env.MINT_ADDRESS),
  TREASURY_WALLET: new PublicKey(process.env.TREASURY_WALLET),
  WITHDRAW_AUTHORITY_PRIVATE_KEY: process.env.WITHDRAW_AUTHORITY_PRIVATE_KEY,
  OUTPUT_MINTS: [
    "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // SOL
    "So11111111111111111111111111111111111111112", // wBTC
    "2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk", // wETH
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  ],
  BATCH_SIZE: 10,
  SLIPPAGE_BPS: 2000, // 10% slippage
  TOTAL_SUPPLY: 1_000_000_000n * 10n ** BigInt(9),
  DISTRIBUTION_INTERVAL: 180 * 1000, // 3 minutes
};
