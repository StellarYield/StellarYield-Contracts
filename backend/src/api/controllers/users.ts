import type { Request, Response, NextFunction } from "express";
import { deflateRawSync } from "node:zlib";
import { UserService } from "../../services/user.js";
import { readKycVerified } from "../../services/stellar.js";
import { query } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";
import { userServiceInstance } from "../../services/userSingleton.js";
import { decrementSseConnections, incrementSseConnections } from "../../services/metrics.js";

const userService = new UserService();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) === 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(files: Record<string, unknown>): Buffer {
  const encoder = new TextEncoder();
  const fileData = Object.entries(files).map(([name, payload]) => {
    const content = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    return { name, content };
  });

  const localFileHeaders: Buffer[] = [];
  const centralDirectoryEntries: Buffer[] = [];
  const fileContents: Buffer[] = [];

  let offset = 0;
  for (const file of fileData) {
    const nameBuffer = encoder.encode(file.name);
    const compressed = deflateRawSync(file.content);
    const crc = crc32(file.content);
    const header = Buffer.alloc(30 + nameBuffer.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.content.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    Buffer.from(nameBuffer).copy(header, 30);
    localFileHeaders.push(header);

    const entry = Buffer.alloc(46 + nameBuffer.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.content.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    Buffer.from(nameBuffer).copy(entry, 46);
    centralDirectoryEntries.push(entry);

    fileContents.push(Buffer.concat([header, compressed]));
    offset += header.length + compressed.length;
  }

  const centralDirectorySize = centralDirectoryEntries.reduce((sum, entry) => sum + entry.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(fileData.length, 8);
  endRecord.writeUInt16LE(fileData.length, 10);
  endRecord.writeUInt32LE(centralDirectorySize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...fileContents, ...centralDirectoryEntries, endRecord]);
}

export async function exportUserData(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);

    const userRows = await query<{ id: number; address: string; kyc_verified: boolean; created_at: Date; updated_at: Date }>(
      `SELECT id, address, kyc_verified, created_at, updated_at FROM users WHERE address = $1 LIMIT 1`,
      [address],
    );

    if (userRows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
    }

    const positionsRows = await query<{
      id: number;
      user_address: string;
      vault_id: number;
      shares: string;
      deposited: string;
      last_claimed_epoch: number;
      updated_at: Date;
    }>(
      `SELECT uvp.id, uvp.user_address, uvp.vault_id, uvp.shares, uvp.deposited, uvp.last_claimed_epoch, uvp.updated_at
       FROM user_vault_positions uvp
       WHERE uvp.user_address = $1
       ORDER BY uvp.updated_at DESC`,
      [address],
    );

    const yieldRows = await query<{
      contract_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT contract_id, event_type, payload, created_at
       FROM indexed_events
       WHERE event_type IN ('yield_claimed', 'yield_claimed_partial')
         AND (payload->>'user' = $1 OR payload->>'address' = $1)
       ORDER BY ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC`,
      [address],
    );

    const eventRows = await query<{
      id: number;
      ledger: number;
      tx_hash: string;
      contract_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      // Only matches event types whose payload is stored with a flat 'user'/'address' key
      // (e.g. yield_claimed, kyc_set). Deposit/withdraw/vault-lifecycle events store the raw
      // on-chain event instead, so they aren't retrievable by user address here.
      `SELECT id, ledger, tx_hash, contract_id, event_type, payload, created_at
       FROM indexed_events
       WHERE (payload->>'user' = $1 OR payload->>'address' = $1)
       ORDER BY ledger DESC, tx_index DESC NULLS LAST, event_index DESC NULLS LAST, id DESC`,
      [address],
    );

    const archiveBuffer = buildZipBuffer({
      "user.json": userRows[0],
      "positions.json": positionsRows,
      "yield-history.json": yieldRows,
      "events.json": eventRows,
    });

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="user-${address}-data-export.zip"`);
    res.end(archiveBuffer);
  } catch (err) {
    next(err);
  }
}

export async function getUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await userService.getUser(String(req.params["address"]));
    if (!user) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, "User not found", 404);
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolio(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const portfolio = await userService.getUserPortfolio(
      String(req.params["address"]),
    );
    res.json(portfolio);
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolioPnl(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const pnl = await userService.getUserPortfolioPnl(
      String(req.params["address"]),
    );
    res.json(pnl);
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolioAllocation(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const allocation = await userService.getUserPortfolioAllocation(
      String(req.params["address"]),
    );
    res.json(allocation);
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolioDiversification(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const diversification = await userService.getUserPortfolioDiversification(
      String(req.params["address"]),
    );
    res.json(diversification);
  } catch (err) {
    next(err);
  }
}

export async function getUserIncomeForecast(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const monthsParam = req.query["months"];
    const months =
      typeof monthsParam === "string" && /^\d+$/.test(monthsParam)
        ? Math.min(12, Math.max(1, parseInt(monthsParam, 10)))
        : 6;

    const forecast = await userService.getUserIncomeForecast(address, months);
    res.json(forecast);
  } catch (err) {
    next(err);
  }
}

export async function getUserShareHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const history = await userService.getShareBalanceHistory(
      String(req.params["address"]),
      typeof req.query["vaultId"] === "string" ? req.query["vaultId"] : undefined,
    );
    res.json(history);
  } catch (err) {
    next(err);
  }
}

export async function getPortfoliosBatch(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { addresses } = req.body as { addresses: string[] };
    const portfolios = await userService.getPortfoliosBatch(addresses);
    res.json(portfolios);
  } catch (err) {
    next(err);
  }
}

export async function getPositionsBatch(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { addresses } = req.body as { addresses: string[] };
    const positions = await userService.getPortfoliosBatch(addresses);
    res.json(positions);
  } catch (err) {
    next(err);
  }
}

export async function getUserKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const verified = await readKycVerified(
      String(req.query["vaultId"]),
      String(req.params["address"]),
    );
    res.json({ verified });
  } catch (err) {
    next(err);
  }
}

export async function searchUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const search = String(req.query["search"] ?? "");
    const users = await userService.searchUsers(search);
    res.json(users);
  } catch (err) {
    next(err);
  }
}

export async function getUserYieldHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const page = Number(req.query["page"] ?? 1);
    const pageSize = Number(req.query["pageSize"] ?? 20);
    const result = await userService.getUserYieldHistory(address, page, pageSize);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserYieldSummary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const summary = await userService.getUserYieldSummary(String(req.params["address"]));
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

export async function getUserYieldBreakdown(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const address = String(req.params["address"]);
    const vaultId = String(req.query["vaultId"]);

    const breakdown = await userService.getUserYieldBreakdown(address, vaultId);
    if (!breakdown) {
      res.status(404).json({ error: "NotFound", message: "User position not found for vault" });
      return;
    }

    res.json(breakdown);
  } catch (err) {
    next(err);
  }
}

export async function getUserKycHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);
    const page = Math.max(1, Number(req.query["page"] ?? 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query["pageSize"] ?? 20)));
    const offset = (page - 1) * pageSize;

    const rows = await query<{
      contract_id: string;
      ledger: number;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT contract_id, ledger, payload, created_at
       FROM indexed_events
       WHERE event_type = 'kyc_set'
         AND (payload->>'user' = $1 OR payload->>'address' = $1)
       ORDER BY (payload->>'timestamp')::numeric DESC NULLS LAST, created_at DESC
       LIMIT $2 OFFSET $3`,
      [address, pageSize, offset],
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM indexed_events
       WHERE event_type = 'kyc_set'
         AND (payload->>'user' = $1 OR payload->>'address' = $1)`,
      [address],
    );

    const total = parseInt(countResult[0]?.count ?? "0", 10);

    const data = rows.map((row) => {
      const ts = row.payload["timestamp"];
      const timestamp = ts != null
        ? new Date(Number(ts) * 1000).toISOString()
        : row.created_at.toISOString();
      return {
        vaultContractId: row.contract_id,
        verified: Boolean(row.payload["verified"]),
        ledger: row.ledger,
        timestamp,
      };
    });

    res.json({ data, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

export async function getKycBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { addresses, vaultId } = req.body as { addresses: string[]; vaultId: string };
    const results = await Promise.all(
      addresses.map(async (address) => {
        try {
          const verified = await readKycVerified(vaultId, address);
          return [address, verified] as const;
        } catch {
          return [address, false] as const;
        }
      }),
    );
    res.json(Object.fromEntries(results));
  } catch (err) {
    next(err);
  }
}

export async function streamUserPositions(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);

    const portfolio = await userService.getUserPortfolio(address);

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    res.write(`data: ${JSON.stringify({ type: "initial", portfolio })}\n\n`);

    // This stream is written straight to the response instead of going through
    // SseManager/SseService, so the connection gauge is maintained here (#1092).
    incrementSseConnections();

    const unsubscribe = userServiceInstance.onPositionUpdate(address, (position) => {
      const event = {
        type: "position_updated",
        vaultContractId: position.vaultContractId,
        shares: position.shares,
        deposited: position.deposited,
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on("close", () => {
      unsubscribe();
      decrementSseConnections();
      res.end();
    });
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolioValue(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);
    const portfolioValue = await userService.getUserPortfolioValue(address);
    res.json(portfolioValue);
  } catch (err) {
    next(err);
  }
}

export async function getUserPortfolioHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);
    const fromParam = req.query["from"];
    const toParam = req.query["to"];
    const intervalParam = req.query["interval"];

    const from = fromParam ? new Date(String(fromParam)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = toParam ? new Date(String(toParam)) : new Date();
    const interval = (intervalParam === "1d" || intervalParam === "7d") ? intervalParam : "1d";

    const history = await userService.getUserPortfolioHistory(address, from, to, interval);
    res.json(history);
  } catch (err) {
    next(err);
  }
}

export async function getUserFirstDeposit(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);
    const firstDeposit = await userService.getUserFirstDeposit(address);

    if (!firstDeposit) {
      res.status(404).json({ error: "NotFound", message: "No deposit found for this address" });
      return;
    }

    res.json(firstDeposit);
  } catch (err) {
    next(err);
  }
}

export async function getUserRealizedYield(req: Request, res: Response, next: NextFunction) {
  try {
    const address = String(req.params["address"]);
    const fromParam = req.query["from"];
    const toParam = req.query["to"];

    const from = fromParam ? new Date(String(fromParam)) : undefined;
    const to = toParam ? new Date(String(toParam)) : undefined;

    const realizedYield = await userService.getUserRealizedYield(address, from, to);
    res.json(realizedYield);
  } catch (err) {
    next(err);
  }
}
