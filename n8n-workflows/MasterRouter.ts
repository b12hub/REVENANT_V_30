/**
 * MasterRouter.ts
 * Phase 2 – Deterministic Router (Blueprint for n8n Code Node)
 *
 * This module computes a normalized Risk Score (0–100) and an Ambiguity
 * Score (0–100) from the request context, then deterministically selects
 * the downstream micro‑workflow route.
 *
 * Weights and thresholds can be tuned via the CONFIG constant without
 * changing the core logic.
 */

// ================================================================
// 1. Type Definitions (for documentation; JS-compatible in n8n)
// ================================================================

interface GeoPoint {
  lat: number;
  lon: number;
}

interface RoutingInput {
  /** Transaction amount in UZS (0 if not a transaction) */
  amount: number;
  /** User's registered location (optional) */
  userLocation?: GeoPoint;
  /** Location inferred from device (optional) */
  deviceLocation?: GeoPoint;
  /** Number of requests from this user in the last hour */
  recentRequestCount: number;
  /** Device trust score provided by the perimeter (0 = untrusted, 100 = fully trusted) */
  deviceTrustScore: number;
  /** Normalised intent: 'FAQ', 'TRANSACTION', 'ACCESS_ISSUE', 'PAYMENT_ISSUE', etc. */
  intent: string;
  /** Destination account (for transfers) – undefined if missing */
  destinationAccount?: string;
  /** Full user message for ambiguity checks */
  message?: string;
}

interface RoutingDecision {
  route: string;
  risk_score: number;
  ambiguity_score: number;
}

// ================================================================
// 2. Configuration – All magic numbers live here
// ================================================================

const CONFIG = {
  // Risk Score weights (must sum to 1)
  WEIGHTS: {
    amount: 0.40,
    geo: 0.25,
    velocity: 0.20,
    device: 0.15,
  },

  // Amount risk: linear up to the hard block limit (50M UZS)
  AMOUNT_MAX: 50_000_000,

  // Geo mismatch: distance threshold in kilometres (if lat/lon available)
  GEO_MISMATCH_KM: 100,
  // Score contribution when mismatch is confirmed (0 or 100)
  GEO_MISMATCH_SCORE: 100,

  // Velocity risk: max “normal” requests per hour
  VELOCITY_MAX_PER_HOUR: 60,

  // Ambiguity: required fields per intent
  REQUIRED_FIELDS: {
    TRANSACTION: ['amount', 'destinationAccount'],
    FAQ: ['message'],
    // fallback – no required fields means ambiguity always 0
    DEFAULT: [],
  },
};

// ================================================================
// 3. Helper: Haversine distance (km) – safe even without coordinates
// ================================================================

function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius in km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

// ================================================================
// 4. Individual Risk Components (each returns 0–100)
// ================================================================

function amountRisk(amount: number): number {
  // Linear scale: 0 at 0 UZS, 100 at AMOUNT_MAX (50M)
  return Math.min((amount / CONFIG.AMOUNT_MAX) * 100, 100);
}

function geoRisk(userLoc?: GeoPoint, deviceLoc?: GeoPoint): number {
  if (!userLoc || !deviceLoc) {
    // Without data we cannot prove mismatch => assume safe (0)
    return 0;
  }
  const dist = haversineDistance(userLoc, deviceLoc);
  return dist > CONFIG.GEO_MISMATCH_KM ? CONFIG.GEO_MISMATCH_SCORE : 0;
}

function velocityRisk(recentCount: number): number {
  // Linear scale: 0 at 0 requests, 100 at VELOCITY_MAX_PER_HOUR
  return Math.min((recentCount / CONFIG.VELOCITY_MAX_PER_HOUR) * 100, 100);
}

function deviceRisk(trustScore: number): number {
  // Invert: high trust => low risk
  return 100 - trustScore;
}

// ================================================================
// 5. Composite Risk Score (weighted arithmetic mean)
// ================================================================

function calculateRiskScore(input: RoutingInput): number {
  const w = CONFIG.WEIGHTS;
  const score =
    w.amount * amountRisk(input.amount) +
    w.geo * geoRisk(input.userLocation, input.deviceLocation) +
    w.velocity * velocityRisk(input.recentRequestCount) +
    w.device * deviceRisk(input.deviceTrustScore);

  return Math.round(score);
}

// ================================================================
// 6. Ambiguity Score (missing required context)
// ================================================================

function calculateAmbiguityScore(input: RoutingInput): number {
  // Determine which fields are required for this intent
  const required = CONFIG.REQUIRED_FIELDS[
    input.intent as keyof typeof CONFIG.REQUIRED_FIELDS
  ] ?? CONFIG.REQUIRED_FIELDS.DEFAULT;

  if (required.length === 0) return 0;

  let missingCount = 0;
  for (const field of required) {
    const value = (input as any)[field];
    if (field === 'amount') {
      // Amount is required if it is 0 or NaN
      if (!value || value <= 0) missingCount++;
    } else if (field === 'destinationAccount') {
      if (!value || typeof value !== 'string' || value.trim() === '') missingCount++;
    } else if (field === 'message') {
      if (!value || typeof value !== 'string' || value.trim() === '') missingCount++;
    }
  }

  // Linear mapping: all missing → 100, none missing → 0
  return Math.round((missingCount / required.length) * 100);
}

// ================================================================
// 7. Triage Logic – Deterministic Routing
// ================================================================

function determineRoute(input: RoutingInput): RoutingDecision {
  const risk_score = calculateRiskScore(input);
  const ambiguity_score = calculateAmbiguityScore(input);

  let route: string;

  // Rule 1: High ambiguity → always ask for clarification
  if (ambiguity_score > 40) {
    route = 'CLARIFICATION_LOOP';
  }
  // Rule 2: Simple FAQ with low risk → fast FAQ flow
  else if (input.intent === 'FAQ' && risk_score < 20) {
    route = 'FLOW_FAQ';
  }
  // Rule 3: High risk → security flow
  else if (risk_score > 80) {
    route = 'FLOW_SECURITY';
  }
  // Rule 4: Transaction intent → transaction flow
  else if (input.intent === 'TRANSACTION') {
    route = 'FLOW_TRANSACTION';
  }
  // Fallback for any other combination (general_inquiry, access_issue, etc.)
  else {
    route = 'FLOW_GENERAL';
  }

  return { route, risk_score, ambiguity_score };
}

// ================================================================
// 8. Exported entry point – drop this into an n8n Code Node
// ================================================================

/**
 * Main function for n8n Code Node.
 * Expects `$input.first().json` to contain the RoutingInput fields.
 * Returns the RoutingDecision as `{ json: { route, risk_score, ambiguity_score } }`.
 */
function routerNode(input: any): { json: RoutingDecision } {
  // Safely coerce inputs
  const safeInput: RoutingInput = {
    amount: parseFloat(input.amount) || 0,
    userLocation: input.userLocation || undefined,
    deviceLocation: input.deviceLocation || undefined,
    recentRequestCount: parseInt(input.recentRequestCount, 10) || 0,
    deviceTrustScore: Math.min(100, Math.max(0, parseFloat(input.deviceTrustScore) || 0)),
    intent: input.intent || 'DEFAULT',
    destinationAccount: input.destinationAccount,
    message: input.message,
  };

  const decision = determineRoute(safeInput);
  return { json: decision };
}

export { determineRoute, routerNode };
export type { RoutingInput, RoutingDecision };
// ================================================================
// 9. JSON Schema of the Routing Decision (for downstream nodes)
// ================================================================
/*
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "RoutingDecision",
  "type": "object",
  "properties": {
    "route": {
      "type": "string",
      "enum": [
        "CLARIFICATION_LOOP",
        "FLOW_FAQ",
        "FLOW_SECURITY",
        "FLOW_TRANSACTION",
        "FLOW_GENERAL"
      ]
    },
    "risk_score": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "ambiguity_score": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    }
  },
  "required": ["route", "risk_score", "ambiguity_score"]
}
*/