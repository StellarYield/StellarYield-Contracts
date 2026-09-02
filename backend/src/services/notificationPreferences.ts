import { query } from "../db/index.js";

/** A single per-user notification preference row (#988, #989). */
export interface NotificationPreference {
  eventType: string;
  channel: string;
  enabled: boolean;
  vaultContractId: string | null;
  updatedAt: string;
}

export interface PreferenceInput {
  eventType: string;
  channel: string;
  enabled: boolean;
  vaultContractId?: string | null;
}

interface PreferenceRow {
  event_type: string;
  channel: string;
  enabled: boolean;
  vault_contract_id: string | null;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Return every notification preference row for a user. */
export async function getPreferences(userAddress: string): Promise<NotificationPreference[]> {
  const rows = await query<PreferenceRow>(
    `SELECT event_type, channel, enabled, vault_contract_id, updated_at
       FROM user_notification_preferences
      WHERE user_address = $1
      ORDER BY event_type, channel, vault_contract_id NULLS FIRST`,
    [userAddress],
  );
  return rows.map((r) => ({
    eventType: r.event_type,
    channel: r.channel,
    enabled: r.enabled,
    vaultContractId: r.vault_contract_id,
    updatedAt: toIso(r.updated_at),
  }));
}

/** Insert or update a batch of preferences for a user. */
export async function upsertPreferences(
  userAddress: string,
  preferences: PreferenceInput[],
): Promise<void> {
  for (const p of preferences) {
    await query(
      `INSERT INTO user_notification_preferences
         (user_address, event_type, channel, enabled, vault_contract_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_address, event_type, channel, COALESCE(vault_contract_id, ''))
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [userAddress, p.eventType, p.channel, p.enabled, p.vaultContractId ?? null],
    );
  }
}

/**
 * Resolve whether a webhook delivery should proceed for a given user, event
 * and channel. A vault-scoped preference row wins over an all-vaults (NULL)
 * row; absence of any row defaults to enabled (#990).
 */
export async function isDeliveryEnabled(
  userAddress: string,
  eventType: string,
  channel: string,
  vaultContractId: string | null,
): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>(
    `SELECT enabled
       FROM user_notification_preferences
      WHERE user_address = $1
        AND event_type = $2
        AND channel = $3
        AND (vault_contract_id = $4 OR vault_contract_id IS NULL)
      ORDER BY vault_contract_id NULLS LAST
      LIMIT 1`,
    [userAddress, eventType, channel, vaultContractId],
  );
  if (rows.length === 0) return true;
  return rows[0].enabled;
}
