const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  VersionedTransaction,
} = require("@solana/web3.js");
const { RPC_URL } = require("../config/constants");
const bs58 = require("bs58");

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  httpHeaders: { "Content-Type": "application/json" },
  fetch: (url, options) => fetch(url, { ...options, timeout: 30000 }),
});

function getWithdrawAuthority(privateKey) {
  return Keypair.fromSecretKey(bs58.default.decode(privateKey));
}

module.exports = {
  connection,
  getWithdrawAuthority,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  VersionedTransaction,
};
