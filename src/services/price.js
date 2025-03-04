const fetch = require("node-fetch");

async function getDrtPriceInUsd() {
  const DRT_MINT = "FjFccmB1ZBUVB13s12koLPseRi9ZSzNj9daJStCVXM25";
  const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";

  try {
    const response = await fetch(`${DEXSCREENER_API}/${DRT_MINT}`, {
      timeout: 10000,
    });
    if (!response.ok) {
      throw new Error(
        `HTTP error ${response.status}: ${await response.text()}`
      );
    }

    const data = await response.json();
    if (!data.pairs || data.pairs.length === 0) {
      throw new Error("No trading pairs found for DRT");
    }

    // Find a pair with USD price (e.g., against USDC or SOL with conversion)
    const usdPair = data.pairs.find(
      (pair) => pair.priceUsd && parseFloat(pair.priceUsd) > 0
    );
    if (!usdPair) {
      throw new Error("No valid USD price found in pairs");
    }

    const drtPriceUsd = parseFloat(usdPair.priceUsd);
    console.log(`DRT price from DEX Screener API: $${drtPriceUsd}`);
    return drtPriceUsd;
  } catch (err) {
    console.error(
      "Failed to fetch DRT price from DEX Screener, using fallback $0.0009846:",
      err
    );
    return 0.0009846; // Fallback price
  }
}

module.exports = { getDrtPriceInUsd };
