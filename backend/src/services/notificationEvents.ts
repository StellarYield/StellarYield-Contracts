/**
 * Canonical list of notification event types clients may subscribe to or set
 * preferences for. Shared by the webhook subscription API (#1020), the user
 * notification-preferences API (#989) and the per-vault subscription API (#991).
 */
export const KNOWN_EVENTS = [
  "deposit",
  "withdraw",
  "yield_distributed",
  "yield_claimed",
  "vault_state_changed",
  "vault_created",
  "cancel_funding",
  "request_early_redemption",
  "user.deposit",
  "user.withdraw",
  "user.early_redemption_requested",
  "vault.cancelled",
  "vault.matured",
  "vault.funded",
] as const;

export type KnownEvent = (typeof KNOWN_EVENTS)[number];

const KNOWN_EVENT_SET: ReadonlySet<string> = new Set(KNOWN_EVENTS);

export function isKnownEvent(event: string): event is KnownEvent {
  return KNOWN_EVENT_SET.has(event);
}

/**
 * User-specific events: the notify() event name maps to a canonical event_type
 * (as stored in user_notification_preferences) plus the payload keys that hold
 * the affected user's address. Events not listed here are broadcasts and are
 * never filtered by per-user preferences (#990).
 */
export const USER_SPECIFIC_EVENTS: Record<
  string,
  { eventType: string; addressKeys: string[] }
> = {
  deposit: { eventType: "deposit", addressKeys: ["receiver", "caller", "address"] },
  "user.deposit": { eventType: "deposit", addressKeys: ["receiver", "caller", "address"] },
  withdraw: { eventType: "withdraw", addressKeys: ["owner", "receiver", "caller"] },
  "user.withdraw": { eventType: "withdraw", addressKeys: ["owner", "receiver", "caller"] },
  yield_claimed: { eventType: "yield_claimed", addressKeys: ["user", "address", "receiver"] },
  "user.early_redemption_requested": {
    eventType: "request_early_redemption",
    addressKeys: ["owner", "user", "caller"],
  },
};

/**
 * Resolve a notify() event into its canonical event_type and the subject
 * user's address, or null when the event is not user-specific / has no address.
 */
export function resolveUserEvent(
  event: string,
  data: Record<string, unknown>,
): { eventType: string; userAddress: string } | null {
  const mapping = USER_SPECIFIC_EVENTS[event];
  if (!mapping) return null;
  for (const key of mapping.addressKeys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      return { eventType: mapping.eventType, userAddress: value };
    }
  }
  return null;
}
