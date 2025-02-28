const { getWithdrawAuthority } = require("./utils/solana");
const { getTokenHolders, withdrawFees } = require("./services/token");
const { distributeRewards } = require("./services/distribution");
const {
  WITHDRAW_AUTHORITY_PRIVATE_KEY,
  DISTRIBUTION_INTERVAL,
} = require("./config/constants");

async function main() {
  const withdrawAuthority = getWithdrawAuthority(
    WITHDRAW_AUTHORITY_PRIVATE_KEY
  );

  async function runDistribution() {
    try {
      const holders = await getTokenHolders();
      console.log(`Found ${holders.length} holders`);

      const withdrawnAmount = await withdrawFees(withdrawAuthority);
      console.log(`Withdrawn amount: ${withdrawnAmount}`);

      if (withdrawnAmount > 0n) {
        await distributeRewards(withdrawAuthority, holders, withdrawnAmount);
        console.log("Distribution completed successfully!");
      } else {
        console.log("No fees to distribute");
      }
    } catch (error) {
      console.error("Distribution error:", error);
    }
  }

  // Initial run
  await runDistribution();

  // Schedule subsequent runs
  setInterval(runDistribution, DISTRIBUTION_INTERVAL);
  console.log("Distribution scheduler started...");
}

main().catch(console.error);
