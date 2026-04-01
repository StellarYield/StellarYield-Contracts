/**
 * Thin wrapper around `@stellar/freighter-api` for signing transactions in the browser.
 */
export async function signTransactionWithFreighter(
  transactionXdr: string,
  opts: {
    /** e.g. `Networks.TESTNET` / `Networks.PUBLIC` string from `@stellar/stellar-sdk` */
    networkPassphrase?: string;
    address?: string;
  } = {},
): Promise<{ signedTxXdr: string; signerAddress: string }> {
  const { signTransaction } = await import("@stellar/freighter-api");
  const result = await signTransaction(transactionXdr, opts);
  if ("error" in result && result.error) {
    throw new Error(String(result.error));
  }
  return {
    signedTxXdr: result.signedTxXdr,
    signerAddress: result.signerAddress,
  };
}
