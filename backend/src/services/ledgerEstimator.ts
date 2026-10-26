import { query } from "../db/index.js";
import { logger } from "../logger.js";

export interface LedgerAnchor {
  ledger: number;
  closed_at: Date;
}

/**
 * Record an anchor in ledger_anchors.
 */
export async function recordLedgerAnchor(ledger: number, closedAt: Date): Promise<void> {
  try {
    await query(
      `INSERT INTO ledger_anchors (ledger, closed_at)
       VALUES ($1, $2)
       ON CONFLICT (ledger) DO UPDATE SET closed_at = EXCLUDED.closed_at`,
      [ledger, closedAt],
    );
  } catch (err) {
    logger.warn({ err, ledger, closedAt }, "Failed to record ledger anchor");
  }
}

/**
 * Interpolate approximate wall-clock time from the nearest two known
 * (ledger, closed_at) anchor rows in ledger_anchors.
 *
 * Acceptance criteria:
 * - Estimates are within +-10 seconds for ledgers between two anchors.
 * - Ledgers outside the known range return null.
 */
export async function ledgerToTimestamp(seq: number): Promise<Date | null> {
  const [lowerRows, upperRows] = await Promise.all([
    query<{ ledger: string; closed_at: Date }>(
      `SELECT ledger, closed_at FROM ledger_anchors
       WHERE ledger <= $1
       ORDER BY ledger DESC
       LIMIT 1`,
      [seq],
    ),
    query<{ ledger: string; closed_at: Date }>(
      `SELECT ledger, closed_at FROM ledger_anchors
       WHERE ledger >= $1
       ORDER BY ledger ASC
       LIMIT 1`,
      [seq],
    ),
  ]);

  const lower = lowerRows[0];
  const upper = upperRows[0];

  if (!lower || !upper) {
    return null;
  }

  const lowerLedger = Number(lower.ledger);
  const upperLedger = Number(upper.ledger);

  if (seq < lowerLedger || seq > upperLedger) {
    return null;
  }

  const lowerTime = new Date(lower.closed_at).getTime();
  const upperTime = new Date(upper.closed_at).getTime();

  if (lowerLedger === upperLedger) {
    return new Date(lowerTime);
  }

  const fraction = (seq - lowerLedger) / (upperLedger - lowerLedger);
  const estimatedTime = Math.round(lowerTime + fraction * (upperTime - lowerTime));

  return new Date(estimatedTime);
}
