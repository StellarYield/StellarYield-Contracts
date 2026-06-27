import type { Request, Response, NextFunction } from "express";
import { UserService } from "../../services/user.js";
import { readKycVerified } from "../../services/stellar.js";

const userService = new UserService();

export async function getUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await userService.getUser(String(req.params["address"]));
    if (!user) {
      res.status(404).json({ error: "NotFound", message: "User not found" });
      return;
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
