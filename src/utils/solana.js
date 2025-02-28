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

const connection = new Connection(RPC_URL, "confirmed");

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
