import type { Request, Response, NextFunction } from "express";
import { YieldService, InvalidEpochCursorError } from "../../services/yield.js";
import { NotificationService } from "../../services/notifications.js";
import { formatYieldPerShare } from "../../utils/fixedPoint.js";
import type { Epoch } from "../../types/index.js";

/** Default page size for the multi-epoch batch window (#1072). */
const DEFAULT_EPOCH_PAGE_SIZE = 100;

/** Response header carrying the continuation cursor for the next page (#1072). */
const NEXT_CURSOR_HEADER = "X-Next-Cursor";

const yieldService = new YieldService();
const notificationService = new NotificationService();

/**
 * Shape one epoch for the list/batch responses. `status` and
 * `participationRate` come from the vault-wide claim/holder rollups, which are
 * fetched in one query each so the cost does not grow with the page size
 * (#816, #817).
 */
function toEpochSummary(
  epoch: Epoch,
  claimStats: Map<number, { claimedAmount: string; uniqueClaimants: number }>,
  holderCounts: Map<number, number>,
) {
  const stats = claimStats.get(epoch.epoch) ?? { claimedAmount: "0", uniqueClaimants: 0 };
  const totalHolders = holderCounts.get(epoch.epoch) ?? 0;
  return {
    ...epoch,
    netYield: epoch.netYield,
    yieldPerShare: formatYieldPerShare(epoch.yieldAmount, epoch.totalShares),
    distributedAt: epoch.distributedAt ? epoch.distributedAt.toISOString() : null,
    status: yieldService.deriveEpochStatus(epoch.yieldAmount, stats.claimedAmount),
    participationRate: yieldService.calculateParticipationRate(stats.uniqueClaimants, totalHolders),
  };
}

export async function getVaultEpochs(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    // Validated by the route schema: yield range (#858), epoch window and
    // keyset pagination (#1072).
    const { minYield, maxYield, from, to, limit, cursor } = (req.query ?? {}) as unknown as {
      minYield?: string;
      maxYield?: string;
      from?: number;
      to?: number;
      limit?: number;
      cursor?: string;
    };

    // Paging is opt-in: a request that names no window and no page stays on the
    // original unbounded listing, so existing clients are unaffected.
    const paged =
      from !== undefined || to !== undefined || limit !== undefined || cursor !== undefined;

    let epochs: Epoch[];
    let nextCursor: string | null = null;

    if (paged) {
      const page = await yieldService.getEpochsInRange(contractId, {
        from,
        to,
        limit: limit ?? DEFAULT_EPOCH_PAGE_SIZE,
        cursor,
        minYield,
        maxYield,
      });
      epochs = page.epochs;
      nextCursor = page.nextCursor;
    } else {
      epochs = await yieldService.getVaultEpochs(contractId, { minYield, maxYield });
    }

    // Batched per-vault lookups so status/participationRate don't cost an
    // extra pair of queries per epoch (#816, #817).
    const [claimStats, holderCounts] = await Promise.all([
      yieldService.getClaimStatsForVault(contractId),
      yieldService.getHolderCountsForVault(contractId),
    ]);

    // The body stays a plain array of epoch summaries, so the continuation
    // token rides in a header rather than wrapping the payload in an envelope.
    if (nextCursor) {
      res.set(NEXT_CURSOR_HEADER, nextCursor);
    }

    res.json(epochs.map((e) => toEpochSummary(e, claimStats, holderCounts)));
  } catch (err) {
    if (err instanceof InvalidEpochCursorError) {
      res.status(400).json({ error: "BadRequest", message: err.message });
      return;
    }
    next(err);
  }
}

/**
 * GET /api/v1/yields/:contractId/epochs/:epochId/yield-per-share (#1071).
 *
 * A consumer computing a holder's yield needs the per-share ratio for one
 * epoch. The ratio is only meaningful once the epoch is final, so an epoch that
 * is missing or still open answers 404 — the same response a client would get
 * for an unknown epoch, since neither can be turned into a correct number yet.
 */
export async function getEpochYieldPerShare(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    // Validated as a positive integer by the route schema (#1071).
    const epochId = Number(req.params["epochId"]);

    const result = await yieldService.getEpochYieldPerShare(contractId, epochId);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Epoch not found or not yet finalized" });
      return;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getEpochDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const epoch = Number(req.params["epoch"]);
    const detail = await yieldService.getEpochDetail(contractId, epoch);
    if (!detail) {
      res.status(404).json({ error: "NotFound", message: "Epoch not found" });
      return;
    }

    const [claimStats, totalHolders] = await Promise.all([
      yieldService.getEpochClaimStats(contractId, epoch),
      yieldService.getEpochHolderCount(contractId, epoch),
    ]);

    res.json({
      ...detail,
      status: yieldService.deriveEpochStatus(detail.yieldAmount, claimStats.claimedAmount),
      participationRate: yieldService.calculateParticipationRate(
        claimStats.uniqueClaimants,
        totalHolders,
      ),
    });
  } catch (err) {
    next(err);
  }
}

// ── Epoch comparison (#820) ──────────────────────────────────────────────────
export async function compareEpochs(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const epochA = Number(req.query.a);
    const epochB = Number(req.query.b);

    if (!Number.isInteger(epochA) || epochA <= 0 || !Number.isInteger(epochB) || epochB <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Both a and b must be positive integers" });
      return;
    }

    const result = await yieldService.compareEpochs(contractId, epochA, epochB);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "One or both epochs not found" });
      return;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── Next epoch projection (#821) ─────────────────────────────────────────────
export async function getNextEpochProjection(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const projection = await yieldService.getNextEpochProjection(contractId);
    res.json(projection);
  } catch (err) {
    next(err);
  }
}

// ── Epoch closed webhook (#819) ──────────────────────────────────────────────
export async function handleEpochClosed(
  contractId: string,
  epoch: number,
): Promise<void> {
  const result = await yieldService.closeEpochIfFullyClaimed(contractId, epoch);
  if (result) {
    await notificationService.notify("epoch.closed", {
      contractId,
      epoch,
      yieldAmount: result.epochData.yieldAmount,
      closedAt: result.epochData.closedAt,
    });
  }
}

export async function getUserPendingYield(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await yieldService.getUserPendingYield(
      String(req.params["contractId"]),
      String(req.params["userAddress"]),
      req.queryTimeoutMs,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getYieldSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const summary = await yieldService.getYieldSummary(
      String(req.params["contractId"]),
    );
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

export async function getBulkEpochs(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const from = Number(req.query["from"]);
    const to = Number(req.query["to"]);

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
      res.status(400).json({ error: "BadRequest", message: "from and to must be non-negative integers" });
      return;
    }

    const BULK_EPOCH_LIMIT = 500;
    if (to - from > BULK_EPOCH_LIMIT) {
      res.status(400).json({
        error: "BadRequest",
        message: `Range exceeds the maximum of ${BULK_EPOCH_LIMIT} epochs`,
      });
      return;
    }

    if (from > to) {
      res.status(400).json({ error: "BadRequest", message: "from must be less than or equal to to" });
      return;
    }

    const epochs = await yieldService.getEpochsBulk(contractId, from, to);
    res.json(epochs);
  } catch (err) {
    next(err);
  }
}

export async function getYieldTimeline(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (fromParam) {
      fromDate = new Date(fromParam);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid from date format" });
        return;
      }
    }
    if (toParam) {
      toDate = new Date(toParam);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid to date format" });
        return;
      }
    }

    const result = await yieldService.getYieldTimeline(contractId, fromDate, toDate);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getYieldPerShareHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (fromParam) {
      fromDate = new Date(fromParam);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid from date format" });
        return;
      }
    }

    if (toParam) {
      toDate = new Date(toParam);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid to date format" });
        return;
      }
    }

    const result = await yieldService.getYieldPerShareHistory(
      String(req.params["contractId"]),
      fromDate,
      toDate,
      page,
      pageSize,
    );

    res.json({
      data: result.data,
      total: result.total,
      page,
      pageSize,
    });
  } catch (err) {
    next(err);
  }
}

// ── APY vs target (#985) ──────────────────────────────────────────────────────
export async function getApyVsTarget(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const result = await yieldService.getApyVsTarget(contractId);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── APY trend indicator (#986) ────────────────────────────────────────────────
export async function getApyTrend(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const result = await yieldService.getApyTrend(contractId);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── Rolling APY calculation (#978) ────────────────────────────────────────────
export async function getRollingApy(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const result = await yieldService.getRollingApy(contractId);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── APY history time-series (#979) ────────────────────────────────────────────
export async function getApyHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (fromParam) {
      fromDate = new Date(fromParam);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid from date format" });
        return;
      }
    }

    if (toParam) {
      toDate = new Date(toParam);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: "BadRequest", message: "Invalid to date format" });
        return;
      }
    }

    const result = await yieldService.getApyHistory(contractId, fromDate, toDate);
    if (!result) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── Yield volatility metric per vault (#982) ──────────────────────────────────
export async function getYieldVolatility(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const exists = await yieldService.vaultExists(contractId);
    if (!exists) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    const result = await yieldService.getYieldVolatility(contractId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}


// ── Epoch yield per share (#1071) ─────────────────────────────────────────────
export async function getEpochYieldPerShare(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const contractId = String(req.params["contractId"]);
    const epochId = Number(req.params["epochId"] ?? req.params["epoch"]);

    const result = await yieldService.getEpochYieldPerShare(contractId, epochId);
    if (!result) {
      res.status(404).json({
        error: "NotFound",
        message: "Epoch not found or not yet finalized",
      });
      return;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}
