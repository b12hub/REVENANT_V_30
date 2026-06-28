// src/routing/intentRouter.ts
//
// O(1) intent → VLAN resolution. A Map, not a switch statement — a switch
// with this many cases relies on V8's jump-table optimization kicking in,
// which is an implementation detail, not a guarantee; Map.get() is O(1) by
// the data structure's actual contract, not by JIT behavior we're hoping
// for. That distinction matters on a path with a <5ms budget.

export type VlanTarget =
  | 'VLAN_10_P2P'
  | 'VLAN_20_FAQ'
  | 'VLAN_30_BILLPAY'
  | 'VLAN_40_CREDIT'
  | 'VLAN_50_MERCHANT';

/**
 * Every intent explicitly listed here is one this gateway KNOWS about and
 * has deliberately decided where to send. Deliberately verbose rather than
 * routing everything non-money-related through a bare fallback — an
 * intent silently falling into "default" should be rare enough that it's
 * always worth a log line, not the normal case for half the taxonomy.
 */
const INTENT_TO_VLAN: ReadonlyMap<string, VlanTarget> = new Map([
  // VLAN 10 — P2P Money Movement
  ['P2P_TRANSFER', 'VLAN_10_P2P'],

  // VLAN 40 — Credit / BNPL. Wire string is LOAN_ORIGINATION — see header note.
  ['LOAN_ORIGINATION', 'VLAN_40_CREDIT'],

  // VLAN 50 — Merchant / POS Checkout
  ['MERCHANT_CHECKOUT', 'VLAN_50_MERCHANT'],

  // VLAN 30 — Bill-Pay & Government Services. These three intent strings
  // are this router's own reasonable naming, not yet confirmed against the
  // upstream classifier's actual emitted values — rename here if/when that
  // classifier's real output differs.
  ['UTILITY_PAYMENT', 'VLAN_30_BILLPAY'],
  ['TAX_PAYMENT', 'VLAN_30_BILLPAY'],
  ['MOBILE_TOPUP', 'VLAN_30_BILLPAY'],

  // VLAN 20 — Call-Center / FAQ (the default path). Listed explicitly
  // rather than relying on fallback for these specific known intents —
  // only a truly UNKNOWN intent should hit the fallback branch below.
  ['FRAUD_REPORT', 'VLAN_20_FAQ'],
  ['CARD_BLOCK', 'VLAN_20_FAQ'],
  ['TRANSFER_ISSUE', 'VLAN_20_FAQ'],
  ['BALANCE_INQUIRY', 'VLAN_20_FAQ'],
  ['SECURITY_ALERT', 'VLAN_20_FAQ'],
  ['GENERAL_INQUIRY', 'VLAN_20_FAQ'],
]);

const FALLBACK_TARGET: VlanTarget = 'VLAN_20_FAQ';

export interface IntentRoutingResult {
  target: VlanTarget;
  /** False only when an intent reached this function that isn't in the map above. */
  matchedKnownIntent: boolean;
}

export function resolveVlanTarget(intent: string): IntentRoutingResult {
  const target = INTENT_TO_VLAN.get(intent);

  if (target) {
    return { target, matchedKnownIntent: true };
  }

  // Reaching here means the upstream classifier emitted an intent string
  // this router has never been told about — a real signal worth
  // surfacing (classifier drift, a new intent shipped without updating
  // this map, a typo), not something to swallow silently into FAQ.
  return { target: FALLBACK_TARGET, matchedKnownIntent: false };
}