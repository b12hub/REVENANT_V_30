# REVENANT AI CORE (v26)
## System Architecture Dossier
### Classification: Tier-1 Enterprise Banking Software

---

## EXECUTIVE SUMMARY

**Revenant AI Core v26** is a production-hardened, multi-block AI workflow engine designed for enterprise banking operations in the Uzbekistan market. The system implements a **9-Block Architecture** with defense-in-depth security, W3C-compliant distributed tracing, and cryptographic non-repudiation throughout the transaction lifecycle.

### Primary Purpose
The system functions as an **AI-Powered Customer Support & Transaction Advisory Platform** that:
1. Ingests customer tickets via webhook (text/voice)
2. Classifies intent and severity using hybrid rule-based + AI engines
3. Generates contextual advisories via LLM (OpenRouter/GPT-4o-mini)
4. Routes responses through multiple channels (UI, Email, Webhook)
5. Maintains immutable audit trails with HMAC-SHA256 signing
6. Enforces financial thresholds with human-in-the-loop gates

### Data Flow Architecture
```
WEBHOOK → BLOCK 0 (Ingress/Sanitize) → BLOCK 1 (Biometric) → BLOCK 2 (Classify) 
    → BLOCK 3 (Business Logic) → BLOCK 4 (AI Intelligence) → BLOCK 5 (Ledger/Approval)
    → BLOCK 6 (Memory Core) → BLOCK 7 (Compliance/Audit) → BLOCK 8-9 (Firewall/Execute)
```

---

## SECTION 1: THE BLUEPRINT (Rebuild Instructions)

### 1.1 Executive Data Flow Summary

| Stage | Block | Function | Critical Output |
|-------|-------|----------|-----------------|
| **Ingress** | Block 0 | Input validation, threat detection, trace_id generation | `canonical_ticket` with W3C traceparent |
| **Intelligence** | Block 4 | LLM advisory generation, confidence scoring | `advisory_package` with transaction proposals |
| **Ledger** | Block 5 | Approval workflow, dispatch routing, idempotency | `approval_record` in Supabase |
| **Compliance** | Block 7 | Forensic signing, PII scrubbing, audit ledger | HMAC-SHA256 signed `forensic_manifest` |
| **Firewall** | Block 8-9 | Policy enforcement, execution gating, human approval | `EXECUTE`, `STOP`, or `PAUSE` decision |

### 1.2 Node Deep-Dive Analysis

---

#### **BLOCK 0 (Ingress): PROD Input Normalizer - Hardened V20**

**Location in JSON:** Node ID `63ede8e6-a8a5-42d3-aa9d-6624ef5ca9c1`

**Purpose:** This is the **Identity Resolution Gateway**—the single source of truth for trace_id generation and the first line of financial validation.

**Critical Code Analysis:**

```javascript
// --- 1. IDENTITY RESOLUTION (The Golden Thread) ---
// Fix: Normalize to lowercase to match W3C Regex requirements
const rawTraceParent = (headers["traceparent"] || "").toLowerCase();
const traceRegex = /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/;
const isHeaderValid = traceRegex.test(rawTraceParent);

let trace_id = null;

if (isHeaderValid) {
    trace_id = rawTraceParent.split('-')[1]; // Extracts DEADBEEF...
} else if (bodyData.trace_id) {
    trace_id = String(bodyData.trace_id);
} else {
    trace_id = crypto.randomBytes(16).toString('hex');
}
```

**Why This Is Powerful:**
- **W3C Trace Context Compliance:** The regex `/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/` strictly validates the W3C traceparent format, ensuring interoperability with distributed tracing systems (Jaeger, Zipkin, AWS X-Ray).
- **Hierarchical Identity Resolution:** First tries external traceparent header, falls back to body trace_id, finally generates cryptographically secure random bytes via `crypto.randomBytes(16).toString('hex')`.
- **Financial Security Gates:** Implements hard ceilings and challenge floors:

```javascript
const HARD_CEILING_USD = 50000; 
const CHALLENGE_FLOOR = 10000;
let gateStatus = "PROCEED";

if (detectedAmount > HARD_CEILING_USD) {
    gateStatus = "REJECT_IMMEDIATE";
    gateReason = "HARD_LIMIT_BREACH_AT_INGRESS";
} else if (detectedAmount >= CHALLENGE_FLOOR) {
    if (!json.biometrics || json.biometrics.status !== 'VERIFIED') {
       gateStatus = "CHALLENGE_REQUIRED"; 
       livenessChallenge = "NEON-" + Math.floor(Math.random() * 9999);
    }
}
```

---

#### **BLOCK 4 (Intelligence): Advisory Execution Controller**

**Location in JSON:** Node ID `d05b1b73-c1dd-445d-953a-871c1515ec39`

**Purpose:** The **Dynamic Kill-Switch Controller**—determines whether to invoke the LLM or use deterministic fallback based on security context.

**Critical Code Analysis:**

```javascript
// ==================== 3. DYNAMIC INSTRUCTION GENERATOR (THE BRAIN) ====================
let instructionBlock = "";

if (securityState.severity === "critical" || securityState.intent === "security_alert") {
    // 🛑 KILL SWITCH: CRITICAL THREAT DETECTED
    instructionBlock = `
    [CRITICAL SECURITY ALERT ACTIVE]
    - THREAT LEVEL: CRITICAL (Source: Fusion Engine)
    - ACTION REQUIRED: IMMEDIATE REJECTION
    - INSTRUCTION: ...`;
    
    executionDecision.use_llm = false; // BYPASS LLM
    executionDecision.strategy = "DETERMINISTIC_REJECTION";
}
```

**Why This Is Powerful:**
- **Security-First Architecture:** Critical threats bypass the LLM entirely, preventing prompt injection attacks from manipulating the AI.
- **Context-Aware Instructions:** The system dynamically constructs system prompts based on:
  - Intent classification (`security_alert`, `access_issue`, `payment_issue`)
  - Severity level (`critical`, `high`, `medium`, `low`)
  - Biometric verification status
  - Transaction amount thresholds

```javascript
const llmRequestBody = {
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: instructionBlock },
    { role: "user", content: userContext }
  ],
  response_format: { type: "json_object" },
  temperature: 0.2 // LOW temperature for deterministic outputs
};
```

---

#### **BLOCK 5 (Ledger): Approval Request Registrar**

**Location in JSON:** Node ID `82a4502a-3ef5-4169-abed-ed44907e3b79`

**Purpose:** The **Idempotency Guardian**—ensures exactly-once semantics for approval requests using deterministic ID generation.

**Critical Code Analysis:**

```javascript
// ---- 2. GENERATE DETERMINISTIC APPROVAL ID (THE FIX) ----
// 🛑 REMOVED: crypto.randomUUID()
// ✅ ADDED: Deterministic Hash of trace_id
const id_hash = crypto.createHash('sha256').update(trace_id).digest('hex');
const approval_id = `apr_${id_hash.substring(0, 24)}`;
```

**Why This Is Powerful:**
- **Idempotency by Design:** Same `trace_id` always produces same `approval_id`, enabling database-level duplicate detection via unique constraints.
- **Cryptographic Integrity Chain:** Links approval to original trace via:
  - `request_integrity_hash`: SHA-256 of the advisory package
  - `approval_request_hash`: SHA-256 of the approval metadata
  - `block_4_seal_hash`: Cryptographic seal from Block 4

```javascript
const approvalRecord = {
  approval_id,
  trace_id,
  state: "PENDING",
  consumed: false,
  expires_at: new Date(Date.now() + 3600000).toISOString(), // 1-hour TTL
  request_integrity_hash: crypto.createHash('sha256').update(JSON.stringify(advisoryPackage)).digest('hex'),
  approval_request_hash: crypto.createHash('sha256').update(JSON.stringify(approvalRequest)).digest('hex')
};
```

---

#### **BLOCK 7 (Compliance): Forensic Signer**

**Location in JSON:** Node ID `e9e58a24-3ad9-4465-9499-db2faf4a94d0`

**Purpose:** The **Cryptographic Non-Repudiation Engine**—generates tamper-evident audit logs with HMAC-SHA256 signatures.

**Critical Code Analysis:**

```javascript
// --- 🛑 SECURITY FIX: KEY MANAGEMENT ---
const ROOT_SECRET = $vars.HMAC_SECRET || process.env.HMAC_SECRET;
if (!ROOT_SECRET) throw new Error("CRITICAL: HMAC_SECRET missing for Forensic Signer.");

// 2. CONSTRUCT IMMUTABLE MANIFEST
const logManifest = {
  trace_id: trace.trace_id,
  system_version: trace.system_version || "v23.0-hardened",
  seal_version: "3.0-HMAC-SHA256",
  timestamp: new Date().toISOString(),
  decision: scrubbedData.decision,
  net_savings_uzs: economics.net_savings,
  validation_status: validation.status,
  data_payload_hash: crypto.createHash('sha256').update(JSON.stringify(scrubbedData)).digest('hex')
};

// 3. SECURE HMAC SIGNING
const manifestString = JSON.stringify(logManifest);
const forensicSignature = crypto
  .createHmac('sha256', ROOT_SECRET)
  .update(manifestString)
  .digest('hex');
```

**Why This Is Powerful:**
- **WORM Compliance:** The `governance_seal: "WORM_COMPLIANT_v3.0_PLATINUM"` flag indicates Write-Once-Read-Many compliance for audit trails.
- **Tamper Evidence:** Any modification to the log manifest would invalidate the HMAC signature, detectable during audit verification.
- **PII Protection:** Preceding node (BLOCK 7.4) scrubs sensitive data using regex patterns:
  ```javascript
  const patterns = {
    uz_card: /(8600|5614)[0-9]{12}/g,    // UzCard & Humo
    passport: /[A-Z]{2}[0-9]{7}/g,       // Uzbek Passport
    phone: /\+?998[0-9]{9}/g,            // Uzbek Phone
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  };
  ```

---

#### **BLOCK 8 (Firewall): Execution Policy Firewall**

**Location in JSON:** Node ID `3574d658-f748-404d-aaa1-9ffd39d13c2d`

**Purpose:** The **Sovereign Governance Layer**—final enforcement of financial limits with currency-aware conversion.

**Critical Code Analysis:**

```javascript
// --- 1. SETUP FINANCIALS ---
const USD_LIMIT = 50000;
const rate = parseFloat($vars.UZS_EXCHANGE_RATE) || 12850; 

// Normalize input (Atomic units -> Base units)
const baseAmount = parseFloat(intent.amount_atomic) / 100;
const currency = intent.currency || "UZS";

// --- 2. CALCULATE STANDARDIZED USD VALUE ---
let amountUSD = 0;

if (currency === "USD") {
    amountUSD = baseAmount;
} else if (currency === "UZS") {
    amountUSD = baseAmount / rate;
} else {
    // UNKNOWN CURRENCY -> BLOCK IMMEDIATELY
    return [{
       json: {
         state: "REJECTED",
         reason: `EPF_VIOLATION: Unsupported currency '${currency}'. Risk of arbitrage.`,
         forensic_flag: true
       }
     }];
}

// --- 3. HARD INVARIANT CHECK ($50k Kill Switch) ---
if (amountUSD >= USD_LIMIT) {
  return [{
    json: {
      state: "REJECTED",
      reason: `EPF_VIOLATION: Value $${amountUSD.toLocaleString()} exceeds hard ceiling`,
      forensic_flag: true
    }
  }];
}
```

**Why This Is Powerful:**
- **Currency Normalization:** Converts UZS (Uzbekistani Som) to USD using configurable exchange rate, enabling consistent policy enforcement across currencies.
- **Fail-Closed Design:** Unknown currencies are immediately rejected—no implicit trust.
- **Forensic Flagging:** All rejections set `forensic_flag: true`, ensuring security events are logged with higher retention.

---

## SECTION 2: THE TRACEABILITY INDEX (Forensic Audit)

### 2.1 trace_id Lifecycle Analysis

| Stage | Node | Action | Code Evidence |
|-------|------|--------|---------------|
| **Birth** | PROD Input Normalizer | Extract from W3C header or generate | `trace_id = crypto.randomBytes(16).toString('hex')` |
| **Validation** | Phase 0 Validation Gate | Verify non-empty, string type | `if (!ct.trace_id) errors.push('MISSING_TRACE_ID')` |
| **Propagation** | SB0 Envelope Constructor | Inject into envelope meta | `"trace_id": "{{ $json.trace_id }}"` |
| **Merge Key** | Merge Nodes | Join parallel branches | `"fieldsToMatchString": "trace_id"` |
| **Classification** | Text Feature Engineering | Attach to canonical ticket | `trace_id: ct.trace_id` |
| **Business Logic** | Business Impact Calculator | Include in metrics | `trace_id: ct.trace_id` |
| **Transition Guard** | Block 3 Validator | Validate presence | `if (!ticket.trace_id) validationErrors.push(...)` |
| **Trace Context** | Trace Context Node | Build W3C traceparent | `traceparent: 00-${trace_id}-${span_id}-01` |
| **Forensic Log** | FORENSIC LOGGING | Snapshot for audit | `trace_id: ct.trace_id` |
| **AI Advisory** | Governance Gate | Pass to LLM context | `trace_id: ct.trace_id` |
| **Block 4 Seal** | Forensic Logger & Phase Seal | Include in seal hash | `trace_id: activeTraceId` |
| **Block 5 Adapter** | Block 4→5 Adapter | Recovery from any source | `const activeTraceId = input.trace_id \|\| input.canonical_ticket?.trace_id \|\| ...` |
| **Approval Record** | Approval Request Registrar | Primary key component | `approval_id: sha256(trace_id).substring(0,24)` |
| **Dispatch Lock** | Supabase Acquire Lock | Idempotency key | `"idempotence_key": "{{ $json.trace_id }}"` |
| **Final Outcome** | Set Final Outcome | Include in dispatch | `trace_id: "{{ $node[...].json.trace_id }}"` |
| **Block 5 Seal** | Generate Block 5 Seal | Chain linkage | `trace_id: trace_id` |
| **Memory Core** | BLOCK 6.0 | Identity preservation | `identity: { trace_id: input.trace_id }` |
| **Trace Init** | BLOCK 7.1 | Aggressive recovery | `recovered_id = input.trace_id \|\| input.metadata?.trace_id \|\| ...` |
| **Forensic Sign** | BLOCK 7.6 | Sign manifest | `trace_id: trace.trace_id` |
| **Telemetry Sink** | BLOCK 7.7 | Persist to ledger | `"trace_id": "{{ $node[...].json.governance.trace_id }}"` |
| **CBU Compliance** | BLOCK 7.8 | SAR XML generation | `final_trace_id = signer_data.trace_id \|\| ...` |
| **Execution Contract** | BLOCK 8.1 | Contract binding | `trace_id: input.trace_id` |
| **Policy Firewall** | BLOCK 8.2 | Rejection logging | `trace_id: contract.trace_id` |

### 2.2 Identity Verification, Hashing & Recovery Points

**Verification Points:**
1. **Phase 0 Validation Gate:** Validates `trace_id` exists and is non-empty
2. **Trace Context Node:** Verifies continuity via `block3_passed` flag
3. **Block 4→5 Adapter:** Deep recovery searches multiple paths:
   ```javascript
   const activeTraceId = 
       input.trace_id || 
       input.canonical_ticket?.trace_id || 
       input.forensic?.advisory_log?.trace_id || 
       input._delivery_formatted?.formatted_deliveries?.WEBHOOK_DELIVERY?.payload?.trace_id ||
       "unknown";
   ```

**Hashing Points:**
1. **Block 4 Seal:** `crypto.createHash('sha256').update(deterministicStringify(sealData)).digest('hex')`
2. **Block 5 Seal:** `crypto.createHash('sha256').update(JSON.stringify(block_5_manifest)).digest('hex')`
3. **Advisory Hash:** `crypto.createHash('sha256').update(JSON.stringify({...})).digest('hex')`
4. **Forensic Signature:** `crypto.createHmac('sha256', ROOT_SECRET).update(manifestString).digest('hex')`

**Recovery Points:**
1. **BLOCK 7.1 Trace Context Initializer:** Implements 4-level fallback strategy for trace recovery
2. **Block 4→5 Adapter:** Searches 4+ possible locations for trace_id
3. **Orphan Detection:** Flags broken chains with `ORPHAN_TRACE_` prefix

### 2.3 Verdict: Bank-Grade Assessment

| Criterion | Rating | Justification |
|-----------|--------|---------------|
| **Trace Granularity** | ★★★★★ | 25+ touchpoints from ingress to execution |
| **Cryptographic Integrity** | ★★★★★ | HMAC-SHA256 at Block 7, multiple seal hashes |
| **WORM Compliance** | ★★★★☆ | Explicit `WORM_COMPLIANT_v3.0_PLATINUM` flag |
| **Recovery Resilience** | ★★★★★ | 4-level fallback with orphan detection |
| **Audit Completeness** | ★★★★★ | Telemetry sink to Supabase audit_ledger |

**Overall Verdict: BANK-GRADE**

The system implements **comprehensive traceability** that meets strict banking audit standards:

1. **Immutable Audit Trail:** Every transaction generates a `forensic_manifest` with HMAC-SHA256 signature, ensuring non-repudiation.

2. **W3C Trace Context:** Full compliance with distributed tracing standards via `traceparent: 00-{trace_id}-{span_id}-01` format.

3. **Multi-Layer Recovery:** The aggressive trace recovery in BLOCK 7.1 ensures the "Golden Thread" is preserved even through partial failures:
   ```javascript
   // Attempt 1: Direct Top Level
   if (input.trace_id) recovered_id = input.trace_id;
   // Attempt 2: Inside Metadata
   else if (input.metadata && input.metadata.trace_id) recovered_id = input.metadata.trace_id;
   // Attempt 3: Inside Stringified Content
   else if (typeof input.content === 'string' && input.content.includes('trace_id')) { ... }
   // Attempt 4: Fallback to System User
   else if (input.user_id) recovered_id = `manual_${input.user_id}_${Date.now()}`;
   ```

4. **Tamper Evidence:** The `integrity_proof` structure includes signature, algorithm, and key derivation metadata for external verification.

---

## SECTION 3: COMPUTATIONAL EFFICIENCY (Cost-Per-Token)

### 3.1 Node Type Classification

| Category | Nodes | Count | Cost Model |
|----------|-------|-------|------------|
| **LLM/API** | OpenRouter (GPT-4o-mini), Embeddings API | 4 | **PAID** - API credits per request |
| **Database** | Supabase (Insert/Update/Query) | 12 | **PAID** - Database operations + storage |
| **External Services** | Gmail, Telegram, HTTP Webhooks | 8 | **FREE/MIXED** - OAuth-based, no per-call cost |
| **Code (Local)** | JavaScript Function nodes | 45+ | **ZERO COST** - Runs on n8n server |
| **Logic/Flow** | IF, Switch, Merge, Set | 20+ | **ZERO COST** - Native n8n operations |

### 3.2 API Credit Consumption Analysis

**HIGH COST Nodes (LLM):**

| Node | API | Cost Driver | Estimated Cost/Call |
|------|-----|-------------|---------------------|
| LLM HTTP Request | OpenRouter GPT-4o-mini | Input + Output tokens | ~$0.001-0.005 |
| Generate Embedding Vector | OpenRouter text-embedding-3-small | Vector dimensions (1536) | ~$0.0001 |
| Fallback: HTTP Embeddings API | OpenRouter (direct) | Same as above | ~$0.0001 |
| Advisory Recovery & Fallback | OpenRouter (on error) | Conditional invocation | ~$0.001 (rare) |

**MEDIUM COST Nodes (Database):**

| Node | Operation | Cost Driver |
|------|-----------|-------------|
| Create a row (bank_approvals) | INSERT | Row storage + write ops |
| Update a row (bank_approvals) | UPDATE | Write ops + WAL |
| Get a row (bank_approvals) | SELECT | Read ops |
| Supabase: Acquire Dispatch Lock | INSERT with conflict | Write + index ops |
| Supabase: Update Dispatch Log | PATCH | Write ops |
| Supabase: Commit Forensic Seal | PATCH | Write ops |
| Supabase RPC Search | RPC call | Compute + read ops |
| Supabase Upsert (bank_memories) | UPSERT | Write + vector index |
| BLOCK 7.7: Telemetry Sink | INSERT | Audit table write |

**ZERO COST Nodes (Local Execution):**

The following node types run entirely on the n8n server and consume **no API credits**:

- All JavaScript Code nodes (45+ nodes)
- IF/Switch conditional logic
- Merge nodes
- Set nodes (data transformation)
- RespondToWebhook nodes
- Sticky Notes (documentation)

### 3.3 Efficiency Verdict: LEAN with Strategic Heavy Lifting

| Metric | Assessment |
|--------|------------|
| **Overall Classification** | **LEAN** |
| **Cost Per Transaction** | ~$0.002-0.01 USD |
| **API Calls Per Transaction** | 3-5 (LLM + DB + optional embed) |
| **Local Processing Ratio** | ~85% of nodes are zero-cost |

**Cost Optimization Strategies Implemented:**

1. **Deterministic Fallbacks:** The Rule-Based Classifier (Block 2) handles common intents without LLM invocation:
   ```javascript
   const rules = [
     { intent: 'access_issue', regex: /\b(403|401|login|password|access|denied)\b/, score: 0.95 },
     { intent: 'payment_issue', regex: /\b(payment|to'lov|oplat|o'tkazma)\b/, score: 0.9 }
   ];
   ```

2. **Conditional LLM Execution:** Block 4's `If` node checks `use_llm` flag before invoking API:
   ```javascript
   "leftValue": "={{$json.advisory.execution_decision.use_llm}}"
   ```

3. **Embedding Caching:** The Memory Core (Block 6) stores vector embeddings, avoiding re-computation for similar queries.

4. **Idempotency Guards:** Prevents duplicate processing via deterministic approval IDs, reducing redundant API calls.

**ROI Calculation (from Business Impact Calculator):**

```javascript
const DEFAULTS = {
  COST_CONFIG: {
    agent_hourly_rate: 50000,      // UZS
    manual_ticket_cost: 12500,     // UZS
    ai_processing_cost: 2500,      // UZS
    avg_resolution_time_mins: 15
  }
};

const grossSavings = isAutoResolved ? Math.max(0, manualCost - aiCost) : 0;
const roiPercentage = (isAutoResolved && aiCost > 0) 
    ? ((manualCost - aiCost) / aiCost) * 100 
    : 0;
// Result: 400% ROI (10,000 UZS saved per ticket)
```

---

## APPENDIX A: Security Architecture Summary

| Layer | Mechanism | Implementation |
|-------|-----------|----------------|
| **Input Sanitization** | XSS/Script filtering | `cleanText()` with HTML entity encoding |
| **Prompt Injection Defense** | Pattern matching | THREAT_PATTERNS array in Block 0 |
| **Identity Verification** | W3C Trace Context | `traceparent` header validation |
| **Anti-Replay** | HMAC-SHA256 | Time-bound tokens with constant-time comparison |
| **PII Protection** | Regex scrubbing | UzCard, passport, phone, email patterns |
| **Audit Integrity** | HMAC signing | ROOT_SECRET-based manifest signatures |
| **Financial Limits** | Hard ceilings | $50k USD kill switch |
| **Human Override** | Approval workflows | 1-hour TTL on pending approvals |

---

## APPENDIX B: Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Workflow Engine | n8n | Orchestration |
| LLM Provider | OpenRouter (GPT-4o-mini) | Advisory generation |
| Vector Database | Supabase (pgvector) | Memory storage/similarity search |
| Audit Database | Supabase | Immutable ledger |
| Messaging | Telegram Bot API | Alerts & approvals |
| Email | Gmail API | Customer notifications |
| Cryptography | Node.js crypto | HMAC, SHA-256, random bytes |

---

*Document Generated: 2026-02-10*
*Classification: Tier-1 Enterprise Banking Software*
*Version: Revenant AI Core v26*
