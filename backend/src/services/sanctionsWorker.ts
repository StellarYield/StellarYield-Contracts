import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getRequestBodyHash } from "./adminAuditLog.js";

export interface SanctionsCheckResult {
  scannedAddresses: number;
  blacklistedAddresses: string[];
}

/** An object entry in a JSON sanctions list; the address may sit under any of these keys. */
interface SanctionsListEntry {
  address?: unknown;
  id?: unknown;
  account?: unknown;
}

export function parseSanctionsContent(content: string): Set<string> {
  const addresses = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const items: unknown[] = parsed;
      for (const item of items) {
        if (typeof item === "string") {
          addresses.add(item.trim());
        } else if (item && typeof item === "object") {
          const entry = item as SanctionsListEntry;
          const addr = entry.address || entry.id || entry.account;
          if (typeof addr === "string") addresses.add(addr.trim());
        }
      }
      return addresses;
    }
  } catch {
    // Treat as CSV or plain text line-by-line
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(",");
    for (const part of parts) {
      const cleaned = part.trim().replace(/^["']|["']$/g, "");
      if (cleaned.startsWith("G") || cleaned.startsWith("C")) {
        addresses.add(cleaned);
      }
    }
  }

  return addresses;
}

export async function fetchSanctionsList(url: string): Promise<Set<string>> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch sanctions list: HTTP ${resp.status}`);
  }
  const text = await resp.text();
  return parseSanctionsContent(text);
}

export async function runSanctionsCheck(customUrl?: string): Promise<SanctionsCheckResult> {
  const url = customUrl || config.sanctionsListUrl;
  if (!url) {
    logger.info("SANCTIONS_LIST_URL is not configured; skipping sanctions auto-blacklist check");
    return { scannedAddresses: 0, blacklistedAddresses: [] };
  }

  logger.info({ url }, "Starting sanctions list check");
  const sanctionedSet = await fetchSanctionsList(url);
  if (sanctionedSet.size === 0) {
    logger.info("Sanctions list is empty");
    return { scannedAddresses: 0, blacklistedAddresses: [] };
  }

  const transferRows = await query<{ address: string }>(
    `SELECT DISTINCT from_address AS address FROM transfers
     UNION
     SELECT DISTINCT to_address AS address FROM transfers`,
  );

  const blacklisted: string[] = [];
  let vaults: Array<{ id: number }> = [];
  try {
    vaults = await query<{ id: number }>("SELECT id FROM vaults");
  } catch {
    vaults = [];
  }

  for (const row of transferRows) {
    const addr = row.address;
    if (sanctionedSet.has(addr)) {
      // 1. Blacklist on user level
      await query(
        `INSERT INTO users (address, aml_flagged, aml_flagged_at, updated_at)
         VALUES ($1, TRUE, NOW(), NOW())
         ON CONFLICT (address) DO UPDATE
         SET aml_flagged = TRUE, aml_flagged_at = NOW(), updated_at = NOW()`,
        [addr],
      );

      // 2. Blacklist on vault level for all active vaults
      for (const vault of vaults) {
        try {
          await query(
            `INSERT INTO vault_blacklisted_addresses (vault_id, address, added_by, created_at)
             VALUES ($1, $2, 'sanctions_auto_blacklist', NOW())
             ON CONFLICT (vault_id, address) DO NOTHING`,
            [vault.id, addr],
          );
        } catch {
          // ignore if table does not exist
        }
      }

      // 3. Record in admin_audit_log
      const bodyHash = getRequestBodyHash({ address: addr, reason: "OFAC sanctions auto-blacklist" });
      await query(
        `INSERT INTO admin_audit_log (api_key_label, action, target, ip_address, request_body_hash, created_at)
         VALUES ('system:sanctions_job', 'auto_blacklist', $1, '127.0.0.1', $2, NOW())`,
        [addr, bodyHash],
      );

      logger.info({ address: addr }, "Auto-blacklisted sanctioned address from transfer activity");
      blacklisted.push(addr);
    }
  }

  logger.info(
    { scannedAddresses: transferRows.length, blacklistedAddresses: blacklisted.length },
    "Completed sanctions check",
  );

  return {
    scannedAddresses: transferRows.length,
    blacklistedAddresses: blacklisted,
  };
}
