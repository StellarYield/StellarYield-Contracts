import type { Request, Response, NextFunction } from "express";
import { UserService } from "../../services/user.js";

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

export async function getUserPortfolio(req: Request, res: Response, next: NextFunction) {
  try {
    const portfolio = await userService.getUserPortfolio(String(req.params["address"]));
    res.json(portfolio);
  } catch (err) {
    next(err);
  }
}
