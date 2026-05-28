import { rpc } from "@stellar/stellar-sdk";
import { config } from "../config.js";

export function getSorobanRpc(): rpc.Server {
  return new rpc.Server(config.stellar.rpcUrl);
}
