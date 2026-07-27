import type { Request, Response, NextFunction } from "express";
import { YieldService } from "../../services/yield.js";
import { NotificationService } from "../../services/notifications.js";

const yieldService = new YieldService();
const notificationService = new NotificationService();

function formatYieldPerShare(yieldAmount: string, totalShares: string): string {
  const yieldBig = BigInt(yieldAmount);
  const sharesBig = BigInt(totalShares);
  if (sharesBig === BigInt(0)) return "0";
  const DECIMALS = BigInt(10) ** BigInt(18);
  const result = (yieldBig * DECIMALS) / sharesBig;
  const resultStr = result.toString();
  const padded = resultStr.padStart(19, "0");
  const integer = padded.slice(0, -18);
  const fraction = padded.slice(-18);
  return `${integer}.${fraction}`;
}

export async function getVaultEpochs(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = String(req.params["contractId"]);
    // Yield range filters, already validated by the route schema (#858).
    const { minYield, maxYield } = (req.query ?? {}) as unknown as {
      minYield?: string;
      maxYield?: string;
    };
    const epochs = await yieldService.getVaultEpochs(contractId, {
      minYield,
      maxYield,
    });

    // Batched per-vault lookups so status/participationRate don't cost an
    // extra pair of queries per epoch (#816, #817).
    const [claimStats, holderCounts] = await Promise.all([
      yieldService.getClaimStatsForVault(contractId),
      yieldService.getHolderCountsForVault(contractId),
    ]);

    res.json(
      epochs.map((e) => {
        const stats = claimStats.get(e.epoch) ?? { claimedAmount: "0", uniqueClaimants: 0 };
        const totalHolders = holderCounts.get(e.epoch) ?? 0;
        return {
          ...e,
          netYield: e.netYield,
          yieldPerShare: formatYieldPerShare(e.yieldAmount, e.totalShares),
          distributedAt: e.distributedAt ? e.distributedAt.toISOString() : null,
          status: yieldService.deriveEpochStatus(e.yieldAmount, stats.claimedAmount),
          participationRate: yieldService.calculateParticipationRate(
            stats.uniqueClaimants,
            totalHolders,
          ),
        };
      }),
    );
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
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getYieldSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const summary = await yieldService.getYieldSummary(String(req.params["contractId"]));
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
