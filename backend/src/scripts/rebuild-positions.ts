import "dotenv/config";
import { query, pool } from "../db/index.js";
import { logger } from "../logger.js";

interface Args {
  contractId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let contractId: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--contractId") {
      contractId = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { contractId, dryRun };
}

interface DepositEvent {
  vault_id: string;
  user: string;
  amount: string;
  shares_issued: string;
  ledger_sequence: number;
}

interface WithdrawEvent {
  vault_id: string;
  user: string;
  shares_burned: string;
  amount_returned: string;
  ledger_sequence: number;
}

interface RefundedEvent {
  vault_id: string;
  user: string;
  amount: string;
  ledger_sequence: number;
}

interface TransferEvent {
  vault_id: string;
  from_address: string;
  to_address: string;
  amount: string;
  ledger_sequence: number;
}

interface PositionState {
  [key: string]: {
    vault_id: string;
    user_address: string;
    share_balance: bigint;
    deposit_total: bigint;
    last_updated_ledger: number;
  };
}

async function rebuildPositions(contractId?: string, dryRun = false): Promise<void> {
  try {
    logger.info({ contractId, dryRun }, "Starting position rebuild");

    // Build position state from events
    const positions: PositionState = {};

    // Fetch all relevant events in ledger order
    const depositEvents = await query<DepositEvent>(`
      SELECT data->>'vault_id' as vault_id,
             data->>'user' as user,
             data->>'amount' as amount,
             data->>'shares_issued' as shares_issued,
             ledger_sequence
      FROM indexed_events
      WHERE event_type = 'deposit'
        ${contractId ? "AND data->>'contract_id' = $1" : ""}
      ORDER BY ledger_sequence ASC, event_index ASC
    `, contractId ? [contractId] : []);

    for (const event of depositEvents) {
      const key = `${event.vault_id}:${event.user}`;
      if (!positions[key]) {
        positions[key] = {
          vault_id: event.vault_id,
          user_address: event.user,
          share_balance: 0n,
          deposit_total: 0n,
          last_updated_ledger: event.ledger_sequence,
        };
      }
      positions[key].share_balance += BigInt(event.shares_issued);
      positions[key].deposit_total += BigInt(event.amount);
      positions[key].last_updated_ledger = event.ledger_sequence;
    }

    // Process withdrawals
    const withdrawEvents = await query<WithdrawEvent>(`
      SELECT data->>'vault_id' as vault_id,
             data->>'user' as user,
             data->>'shares_burned' as shares_burned,
             data->>'amount_returned' as amount_returned,
             ledger_sequence
      FROM indexed_events
      WHERE event_type = 'withdraw'
        ${contractId ? "AND data->>'contract_id' = $1" : ""}
      ORDER BY ledger_sequence ASC, event_index ASC
    `, contractId ? [contractId] : []);

    for (const event of withdrawEvents) {
      const key = `${event.vault_id}:${event.user}`;
      if (positions[key]) {
        positions[key].share_balance -= BigInt(event.shares_burned);
        positions[key].last_updated_ledger = event.ledger_sequence;
      }
    }

    // Process refunds
    const refundedEvents = await query<RefundedEvent>(`
      SELECT data->>'vault_id' as vault_id,
             data->>'user' as user,
             data->>'amount' as amount,
             ledger_sequence
      FROM indexed_events
      WHERE event_type = 'refunded'
        ${contractId ? "AND data->>'contract_id' = $1" : ""}
      ORDER BY ledger_sequence ASC, event_index ASC
    `, contractId ? [contractId] : []);

    for (const event of refundedEvents) {
      const key = `${event.vault_id}:${event.user}`;
      if (positions[key]) {
        positions[key].deposit_total -= BigInt(event.amount);
        positions[key].last_updated_ledger = event.ledger_sequence;
      }
    }

    // Process share transfers
    const transferEvents = await query<TransferEvent>(`
      SELECT data->>'vault_id' as vault_id,
             data->>'from_address' as from_address,
             data->>'to_address' as to_address,
             data->>'amount' as amount,
             ledger_sequence
      FROM indexed_events
      WHERE event_type = 'transfer' AND data->>'type' = 'share'
        ${contractId ? "AND data->>'contract_id' = $1" : ""}
      ORDER BY ledger_sequence ASC, event_index ASC
    `, contractId ? [contractId] : []);

    for (const event of transferEvents) {
      const fromKey = `${event.vault_id}:${event.from_address}`;
      const toKey = `${event.vault_id}:${event.to_address}`;

      if (positions[fromKey]) {
        positions[fromKey].share_balance -= BigInt(event.amount);
        positions[fromKey].last_updated_ledger = event.ledger_sequence;
      }

      if (!positions[toKey]) {
        positions[toKey] = {
          vault_id: event.vault_id,
          user_address: event.to_address,
          share_balance: 0n,
          deposit_total: 0n,
          last_updated_ledger: event.ledger_sequence,
        };
      }
      positions[toKey].share_balance += BigInt(event.amount);
      positions[toKey].last_updated_ledger = event.ledger_sequence;
    }

    if (dryRun) {
      logger.info({ positionCount: Object.keys(positions).length }, "Dry run complete - no changes made");
      for (const [key, pos] of Object.entries(positions)) {
        logger.info(
          {
            key,
            vault_id: pos.vault_id,
            user: pos.user_address,
            shares: pos.share_balance.toString(),
            deposits: pos.deposit_total.toString(),
            lastLedger: pos.last_updated_ledger,
          },
          "Position"
        );
      }
    } else {
      // Update database
      const posArray = Object.values(positions);

      // Start transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Clear existing positions (optional - or update if exists)
        for (const pos of posArray) {
          await client.query(
            `INSERT INTO user_vault_positions
              (vault_id, user_address, share_balance, deposit_total, last_updated_ledger, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (vault_id, user_address) DO UPDATE SET
              share_balance = EXCLUDED.share_balance,
              deposit_total = EXCLUDED.deposit_total,
              last_updated_ledger = EXCLUDED.last_updated_ledger,
              updated_at = NOW()`,
            [pos.vault_id, pos.user_address, pos.share_balance.toString(), pos.deposit_total.toString(), pos.last_updated_ledger]
          );
        }

        await client.query("COMMIT");
        logger.info({ positionCount: posArray.length }, "Positions rebuilt successfully");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    await pool.end();
  } catch (err) {
    logger.error(err, "Failed to rebuild positions");
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));
await rebuildPositions(args.contractId, args.dryRun);
process.exit(0);
