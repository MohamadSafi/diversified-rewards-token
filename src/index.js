const { getWithdrawAuthority } = require("./utils/solana");
const { getTokenHolders, withdrawFees } = require("./services/token");
const { distributeRewards } = require("./services/distribution");
const {
  WITHDRAW_AUTHORITY_PRIVATE_KEY,
  DISTRIBUTION_INTERVAL,
} = require("./config/constants");

// Handle uncaught exceptions and rejections to prevent process crash
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function main() {
  let withdrawAuthority;

  // Ensure withdrawAuthority is created safely
  try {
    withdrawAuthority = getWithdrawAuthority(WITHDRAW_AUTHORITY_PRIVATE_KEY);
    console.log("Withdraw authority initialized successfully");
  } catch (error) {
    console.error("Failed to initialize withdraw authority:", error);
    // Exit gracefully if we can't even start
    process.exit(1);
  }

  async function runDistribution() {
    try {
      // Step 1: Get token holders
      let holders;
      try {
        holders = await getTokenHolders();
        console.log(`Found ${holders.length} holders`);
      } catch (error) {
        console.error("Error fetching token holders:", error);
        holders = []; // Proceed with empty array to avoid breaking later steps
      }

      // Step 2: Withdraw fees
      let withdrawnAmount = 0n;
      try {
        withdrawnAmount = await withdrawFees(withdrawAuthority);
        console.log(`Withdrawn amount: ${withdrawnAmount}`);
      } catch (error) {
        console.error("Error withdrawing fees:", error);
        // withdrawnAmount remains 0n, which is safe to continue
      }

      // Step 3: Distribute rewards if there's something to distribute
      // if (withdrawnAmount > 0n) {
      //   try {
      //     await distributeRewards(withdrawAuthority, holders, withdrawnAmount);
      //     console.log("Distribution completed successfully!");
      //   } catch (error) {
      //     console.error("Error distributing rewards:", error);
      //     // Log and continue, no need to throw
      //   }
      // } else {
      //   console.log("No fees to distribute");
      // }
    } catch (error) {
      // This catch should be redundant but keeps us extra safe
      console.error("Unexpected error in runDistribution:", error);
    }
  }

  // Initial run with error handling
  try {
    await runDistribution();
  } catch (error) {
    console.error("Initial distribution run failed:", error);
  }

  // Schedule subsequent runs
  setInterval(async () => {
    try {
      await runDistribution();
    } catch (error) {
      console.error("Scheduled distribution run failed:", error);
    }
  }, DISTRIBUTION_INTERVAL);

  console.log("Distribution scheduler started...");
}

// Start the program with top-level error handling
(async () => {
  try {
    await main();
  } catch (error) {
    console.error("Main function failed:", error);
    // Keep the process alive even if main fails
  }
})();
