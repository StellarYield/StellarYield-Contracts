import type { Request, Response, NextFunction } from "express";
import { YieldService } from "../../services/yield.js";

const yieldService = new YieldService();

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
    // Yield range filters, already validated by the route schema (#858).
    const { minYield, maxYield } = (req.query ?? {}) as unknown as {
      minYield?: string;
      maxYield?: string;
    };
    const epochs = await yieldService.getVaultEpochs(String(req.params["contractId"]), {
      minYield,
      maxYield,
    });
    res.json(
      epochs.map((e) => ({
        ...e,
        netYield: e.netYield,
        yieldPerShare: formatYieldPerShare(e.yieldAmount, e.totalShares),
        distributedAt: e.distributedAt ? e.distributedAt.toISOString() : null,
      })),
    );
  } catch (err) {
    next(err);
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
