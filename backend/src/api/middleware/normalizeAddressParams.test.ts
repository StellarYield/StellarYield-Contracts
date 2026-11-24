import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { normalizeAddressParam } from "./normalizeAddressParams.js";

const VALID_ACCOUNT = `G${"B".repeat(55)}`;
const VALID_CONTRACT = `C${"B".repeat(55)}`;

describe("normalizeAddressParams", () => {
  it("uppercases address and contractId params before validation", async () => {
    const app = express();
    app.param("address", normalizeAddressParam("address"));
    app.param("contractId", normalizeAddressParam("contractId"));

    app.get("/users/:address", (req, res) => {
      res.json({ address: req.params.address });
    });

    app.get("/vaults/:contractId", (req, res) => {
      res.json({ contractId: req.params.contractId });
    });

    const addressRes = await request(app).get(`/users/${VALID_ACCOUNT.toLowerCase()}`);
    expect(addressRes.status).toBe(200);
    expect(addressRes.body.address).toBe(VALID_ACCOUNT);

    const contractRes = await request(app).get(`/vaults/${VALID_CONTRACT.toLowerCase()}`);
    expect(contractRes.status).toBe(200);
    expect(contractRes.body.contractId).toBe(VALID_CONTRACT);
  });

  it("does not modify non-address params", async () => {
    const app = express();
    app.param("contractId", normalizeAddressParam("contractId"));

    app.get("/vaults/:contractId/epochs/:epoch", (req, res) => {
      res.json({ contractId: req.params.contractId, epoch: req.params.epoch });
    });

    const res = await request(app).get(`/vaults/${VALID_CONTRACT.toLowerCase()}/epochs/42`);
    expect(res.status).toBe(200);
    expect(res.body.contractId).toBe(VALID_CONTRACT);
    expect(res.body.epoch).toBe("42");
  });
});
