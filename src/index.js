const { getWithdrawAuthority } = require("./utils/solana");
const { getTokenHolders, withdrawFees } = require("./services/token");
const { distributeRewards } = require("./services/distribution");
const {
  WITHDRAW_AUTHORITY_PRIVATE_KEY,
  DISTRIBUTION_INTERVAL,
} = require("./config/constants");

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function retryOperation(operation, maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt === maxRetries) {
        console.error("Max retries reached, proceeding without success");
        return null; // or throw error if you want to handle it differently
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  let withdrawAuthority;
  try {
    withdrawAuthority = getWithdrawAuthority(WITHDRAW_AUTHORITY_PRIVATE_KEY);
    console.log("Withdraw authority initialized successfully");
  } catch (error) {
    console.error("Failed to initialize withdraw authority:", error);
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
        holders = [];
      }

      // Step 2: Withdraw fees
      let withdrawnAmount = 0n;
      try {
        withdrawnAmount = await withdrawFees(withdrawAuthority);
        console.log(`Withdrawn amount: ${withdrawnAmount}`);
      } catch (error) {
        console.error("Error withdrawing fees:", error);
      }

      // Step 3: Distribute rewards with retries
      if (withdrawnAmount > 0n) {
        await retryOperation(
          async () => {
            await distributeRewards(
              withdrawAuthority,
              holders,
              withdrawnAmount
            );
            console.log("Distribution completed successfully!");
          },
          3,
          5000
        ); // Retry 3 times, 5s delay between attempts
      } else {
        console.log("No fees to distribute");
      }
    } catch (error) {
      console.error("Unexpected error in runDistribution:", error);
    }
  }

  // Initial run
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

(async () => {
  try {
    await main();
  } catch (error) {
    console.error("Main function failed:", error);
  }
})();
