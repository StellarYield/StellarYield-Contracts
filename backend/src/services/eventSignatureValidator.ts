import { Keypair } from "@stellar/stellar-sdk";
import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function reconstructSignedLedgerEntry(event: {
  ledger: number;
  txHash: string;
  contractId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Buffer {
  const payload = { ...event.payload };
  delete payload.signature;
  delete payload.signature_valid;
  return Buffer.from(JSON.stringify({
    ledger: event.ledger,
    tx_hash: event.txHash,
    contract_id: event.contractId,
    event_type: event.eventType,
    payload: sortJson(payload),
  }));
}

export function verifyStellarEventSignature(
  event: {
    ledger: number;
    txHash: string;
    contractId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
  signingKey = config.stellarEventSigningKey,
): boolean {
  const payload = event.payload;
  const signatureValue = payload.signature;
  if (typeof signatureValue !== "string" || signatureValue.length === 0) return true;

  const keyValue =
    (typeof payload.signing_key === "string" ? payload.signing_key : undefined) ??
    (typeof payload.signer === "string" ? payload.signer : undefined) ??
    (typeof payload.public_key === "string" ? payload.public_key : undefined) ??
    signingKey;
  if (!keyValue) return false;

  try {
    const keypair = Keypair.fromPublicKey(keyValue);
    const signed = reconstructSignedLedgerEntry(event);
    let signature: Buffer;
    try {
      signature = Buffer.from(signatureValue, "base64");
      if (signature.length === 64) return keypair.verify(signed, signature);
    } catch {
      // Try hexadecimal below.
    }
    signature = /^[0-9a-f]+$/i.test(signatureValue)
      ? Buffer.from(signatureValue, "hex")
      : Buffer.alloc(0);
    return signature.length === 64 && keypair.verify(signed, signature);
  } catch {
    return false;
  }
}

export class EventSignatureValidator {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    const rows = await query<{
      id: number;
      ledger: number;
      tx_hash: string;
      contract_id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(`SELECT id, ledger, tx_hash, contract_id, event_type, payload
       FROM indexed_events
      WHERE signature_valid = TRUE
        AND payload ? 'signature'
      ORDER BY id
      LIMIT 500`);

    for (const row of rows) {
      const valid = verifyStellarEventSignature({
        ledger: row.ledger,
        txHash: row.tx_hash,
        contractId: row.contract_id,
        eventType: row.event_type,
        payload: row.payload,
      });
      if (!valid) {
        await query("UPDATE indexed_events SET signature_valid = FALSE WHERE id = $1", [row.id]);
      }
    }
    if (rows.length > 0) {
      logger.info({ checked: rows.length }, "EventSignatureValidator: validation pass complete");
    }
  }
}
