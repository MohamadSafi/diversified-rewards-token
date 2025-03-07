const { getWithdrawAuthority } = require("./utils/solana");
const { getTokenHolders, withdrawFees } = require("./services/token");
const { distributeRewards } = require("./services/distribution");
const { getDrtPriceInUsd } = require("./services/price");

const {
  WITHDRAW_AUTHORITY_PRIVATE_KEY,
  DISTRIBUTION_INTERVAL,
} = require("./config/constants");
const MINIMUM_USD_VALUE = 20;

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function retryOperation(operation, maxRetries = 3, delayMs = 10000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt === maxRetries) {
        console.error("Max retries reached, proceeding without success");
        return null;
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

  let accumulatedAmount = 0n; // Persistent across runs

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
      let drtPriceUsd;
      const drtDecimals = 9; // Adjust if different

      try {
        drtPriceUsd = await getDrtPriceInUsd();
      } catch (error) {
        console.error(
          "Error fetching DRT price, using last known or default:",
          error
        );
        drtPriceUsd = 0.0004; // Fallback price, adjust or persist from last success
      }

      try {
        withdrawnAmount = await withdrawFees(withdrawAuthority);
        console.log(`Withdrawn amount: ${withdrawnAmount}`);
      } catch (error) {
        console.error("Error withdrawing fees:", error);
        // Preserve accumulatedAmount if no new withdrawal
      }

      const totalAmount = withdrawnAmount + accumulatedAmount;
      const totalUsdValue =
        (Number(totalAmount) / 10 ** drtDecimals) * drtPriceUsd;
      console.log(`Total amount including accumulated: ${totalAmount}`);
      console.log(`Total USD value: $${totalUsdValue.toFixed(2)}`);

      if (totalUsdValue < MINIMUM_USD_VALUE) {
        console.log(
          `Total amount ($${totalUsdValue.toFixed(
            2
          )}) is less than $${MINIMUM_USD_VALUE}, skipping distribution and accumulating`
        );
        accumulatedAmount = totalAmount; // Accumulate total
        return;
      }

      // Step 3: Distribute rewards with retries
      if (totalAmount > 0n) {
        const success = await retryOperation(
          async () => {
            await distributeRewards(withdrawAuthority, holders, totalAmount);
            console.log("Distribution completed successfully!");
          },
          3,
          5000
        );

        if (success) {
          accumulatedAmount = 0n; // Reset only on success
        } else {
          console.log(
            "Distribution failed after retries, preserving accumulated amount"
          );
          accumulatedAmount = 0n;
        }
      } else {
        console.log("No fees to distribute");
      }
    } catch (error) {
      console.error("Unexpected error in runDistribution:", error);
      // accumulatedAmount persists unchanged
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

