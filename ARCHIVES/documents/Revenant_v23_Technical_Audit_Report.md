# REVENANT v23 SB7 — FORMAL TECHNICAL AUDIT REPORT

**Classification:** BANK-GRADE CONFIDENTIAL  
**Audit Date:** 2026-02-07  
**Auditor:** Senior Solutions Architect & Cyber-Security Auditor  
**System Version:** Revenant_v23_SB7 (Phase 4 Enterprise)  
**Target Market:** Republic of Uzbekistan Banking Sector  

---

## EXECUTIVE SUMMARY

This audit evaluates the **Revenant v23 SB7** banking workflow architecture—a 101-node n8n enterprise system designed for automated ticket processing, AI advisory generation, and transaction execution within the Uzbekistan financial ecosystem. The system integrates **Voice Biometric Authentication** (Module 9) and a **Transaction Execution Engine** (Module 8) under a strict Governance Layer.

### System Health Score: **72/100** (MODERATE RISK)

| Category | Score | Status |
|----------|-------|--------|
| Data Lineage Integrity | 78/100 | ⚠️ ACCEPTABLE |
| Dependency Resilience | 58/100 | 🔴 HIGH RISK |
| Security & Governance | 71/100 | ⚠️ ACCEPTABLE |
| Cryptographic Implementation | 65/100 | 🔴 MODERATE RISK |
| Audit Trail Completeness | 88/100 | ✅ GOOD |

---

## TASK 1: SYSTEM ANATOMY & DATA LINEAGE

### 1.1 The Golden Thread: trace_id Propagation Map

The **trace_id** serves as the canonical correlation identifier throughout the pipeline. Its journey follows this path:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        GOLDEN THREAD (trace_id) DATA LINEAGE                     │
└─────────────────────────────────────────────────────────────────────────────────┘

[BLOCK 1: INPUT & SECURITY]
    │
    ├──► Webhook Ingestion ────────┐
    │                               │
    ├──► Send 200 OK ──────────────┤
    │                               │
    ├──► Voice Processor ──────────┤ Generates biometrics object
    │   • Creates: biometrics {     │ (has_voice, status, spoof_score)
    │       has_voice,              │
    │       status,                 │
    │       spoof_score             │
    │     }                         │
    │                               │
    └──► PROD Input Normalizer ────┘ ←── Generates canonical trace_id (16-byte hex)
            │
            ▼
[BLOCK 2: CLASSIFICATION & CONTEXT]
    │
    ├──► Configuration Loader ←─── Merges with trace_id
    │
    ├──► SB0 – Envelope Constructor
    │       • Embeds: trace_id in meta.trace_id
    │       • Creates: canonical_ticket.trace_id
    │
    ├──► Input Validator & Cleaner
    │       • Preserves: trace_id through validation
    │       • Adds: __validation_attempted flag
    │
    ├──► Phase 0 Validation Gate
    │       • Validates: trace_id existence and format
    │       • Propagates: trace_id → canonical_ticket
    │
    └──► [Classification Pipeline]
            • Language Detection
            • Text Feature Engineering
            • Rule-Based Classifier
            • Rule-Based Severity Classifier
            • Pre-Fusion Normalizer
            • All preserve trace_id in canonical_ticket

[BLOCK 3: BUSINESS LOGIC]
    │
    ├──► Uzbekistan SLA Calculator
    ├──► Business Impact Calculator (UZS)
    ├──► Transition Guard & Schema Validator
    │       • Validates: trace_id continuity
    │       • Sets: block3_passed flag
    └──► [Guard Filter → Metrics Emitter → Trace Context]
            • All propagate trace_id through trace_context.uid.trace_id

[BLOCK 4: AI ADVISORY & GOVERNANCE]
    │
    ├──► Phase 3.7 – Final Execution Seal
    │       • Creates: block_4_authorization with trace_id
    │       • Sets: phase_3_complete = true
    │
    ├──► Governance Gate & Context Assembler
    │       • Validates: Phase 3.7 seal exists
    │       • Creates: advisory.__governance with seal_id
    │
    ├──► Advisory Execution Controller
    │       • Generates: LLM request with trace context
    │
    ├──► LLM HTTP Request → Advisory Recovery & Fallback
    │
    ├──► LLM Output Sanitizer & Enterprise Validator
    │       • Parses: advisory_output with transaction_proposal
    │       • Creates: transaction_execution context
    │
    ├──► Advisory Confidence Labeler
    │       • Calculates: deterministic confidence score
    │
    ├──► Delivery Formatter & Channel Router
    │       • Constructs: transaction_context for UI
    │       • Creates: uiSections with alert_box_critical
    │
    └──► Forensic Logger & Phase Seal
            • Generates: block_4_seal_hash (SHA-256)
            • Creates: forensic audit log with trace_id

[BLOCK 5: APPROVAL & DISPATCH]
    │
    ├──► Block 4 → Block 5 Adapter2
    │       • Extracts: block_4_seal_hash
    │       • Recovers: trace_id from multiple sources
    │       • Generates: advisory_hash (SHA-256)
    │       ⚠️ CRITICAL: transaction_context may be STRIPPED here
    │
    ├──► Approval Eligibility Gate1
    │       • Validates: block_4_seal_hash exists
    │       • Sets: __approval_eligible flag
    │
    ├──► Channel Arbitration Engine1
    │       • Selects: delivery channel based on confidence
    │
    ├──► Approval Request Registrar – Authority1
    │       • Creates: approval_record with trace_id
    │       • Stores: transaction_context in approval_request
    │       • Generates: approval_request_hash (SHA-256)
    │
    ├──► [Supabase: Create bank_approvals row]
    │
    ├──► Approval Logic
    │       • Generates: approval_hmac (HMAC-SHA256)
    │       • Decision: APPROVED/REJECTED
    │
    ├──► [Webhook Approval Flow]
    │       • Get a row1 → Merge → HMAC Verifier
    │       • Validates: approval_hmac integrity
    │       • Checks: expiry, consumed status
    │
    ├──► Approval Envelope Validator1
    │       • Deep diagnostic security checks
    │       • Distinguishes: Hacking vs Expiry vs Replay
    │
    ├──► Gate: Is Valid → Update a row
    │
    ├──► Logic: Prepare Dispatch Guard
    │       • Generates: idempotence_key
    │
    ├──► Supabase: Acquire Dispatch Lock
    │
    ├──► Gate: Is Lock Valid?
    │       • TRUE path → Tool Execution Engine
    │
    ├──► Tool Execution Engine [MODULE 8]
    │       • Retrieves: transaction_execution from DB via parent_data
    │       • Executes: FREEZE_ACCOUNT, UNBLOCK_CARD, etc.
    │       • Returns: tool_execution result with CBS reference
    │
    ├──► Set: Rebuild Dispatch Guard
    │
    ├──► Switch → [INTERNAL_UI | EMAIL | WEBHOOK] Dispatch
    │
    ├──► Logic: Prepare Finalizer
    │
    ├──► Supabase: Update Dispatch Log + Approval State
    │
    ├──► Set: Final Outcome
    │
    ├──► Supabase: Fetch Final Approval
    │
    ├──► Logic: Generate Block 5 Seal
    │       • Generates: block_5_seal_hash
    │       • Deep reach recovery from upstream validator
    │
    └──► Supabase: Commit Forensic Seal

[BLOCK 6: MEMORY CORE]
    │
    ├──► BLOCK 6.0: Memory Core Logic
    ├──► Generate Embedding Vector1 → Supabase RPC Search
    ├──► Memory Context Formatter
    ├──► STORAGE PREP & CONTRACT LOCK
    └──► Supabase Upsert (bank_memories)

[BLOCK 7: AUDIT & TELEMETRY]
    │
    ├──► BLOCK 7.1: Trace Context Initializer
    │       • Generates: W3C-compliant traceparent header
    │
    ├──► BLOCK 7.2: Unit Economics Engine
    ├──► BLOCK 7.3: Invariant Validator
    ├──► BLOCK 7.4: PII Forensic Scrubber
    ├──► BLOCK 7.6: Forensic Signer
    │       • Creates: forensic_signature (SHA-256 + trace_id salt)
    │
    └──► BLOCK 7.7: Telemetry Sink → Supabase audit_ledger
            • FINAL DESTINATION: trace_id committed to immutable ledger
```

### 1.2 Biometrics Object Flow Analysis

The **biometrics object** is generated in the **Voice Processor** node (Module 9):

```javascript
// Generated Structure:
{
  biometrics: {
    has_voice: true/false,
    status: "VERIFIED|NOT_ENROLLED|SPOOF_DETECTED|TEXT_ONLY",
    spoof_score: 0.05,           // Synthetic marker probability
    action_required: "...",      // For cold-start users
    audit_log: "..."             // Security audit trail
  }
}
```

**Flow Analysis:**

| Stage | Node | Biometrics Status |
|-------|------|-------------------|
| Generation | Voice Processor | ✅ CREATED |
| Propagation | PROD Input Normalizer | ✅ PRESERVED in `meta.biometrics_audit` |
| SB0 Envelope | SB0 – Envelope Constructor | ⚠️ **NOT EXPLICITLY CARRIED** |
| Validation | Input Validator & Cleaner | ❌ **STRIPPED** - Only canonical_ticket fields preserved |
| Classification | All Block 2 nodes | ❌ **NOT PRESENT** |
| Business Logic | Block 3 nodes | ❌ **NOT PRESENT** |
| Advisory | Governance Gate | ❌ **NOT PRESENT** |

**FINDING:** The biometrics object is **LOST** after the Input Normalizer. It does NOT survive the Sanitize/Adapter nodes. The system lacks biometric-aware routing logic in downstream blocks.

**Risk Rating:** 🔴 **HIGH** - Voice authentication data is discarded, preventing biometric-aware fraud detection for high-value transactions.

### 1.3 Transaction Execution Object Flow Analysis

The **transaction_execution** object originates in Block 4:

```javascript
// Generated in: Delivery Formatter & Channel Router
{
  transaction_context: {
    proposal: "FREEZE_ACCOUNT|UNBLOCK_CARD|NONE",
    rationale: "...",
    parameters: { target_id: "..." },
    requires_approval: true
  }
}
```

**Flow Analysis:**

| Stage | Node | Transaction Context Status |
|-------|------|---------------------------|
| Generation | Delivery Formatter & Channel Router | ✅ CREATED in `advisory_package.transaction_context` |
| Phase Seal | Forensic Logger & Phase Seal | ✅ PRESERVED in `_delivery_formatted` |
| Block 4→5 Adapter | Block 4 → Block 5 Adapter2 | ⚠️ **PARTIALLY STRIPPED** - Only `transaction_ready` flag checked |
| Registrar | Approval Request Registrar | ✅ RECOVERED from `advisory_package` and stored in `approval_request.transaction_execution` |
| Supabase | Create a row1 | ✅ STORED in `bank_approvals` table |
| Approval Logic | Approval Logic | ✅ ACCESSED via `dbRecord.approval_request` |
| Tool Execution | Tool Execution Engine | ✅ RETRIEVED from `parent_data.approval_request.transaction_execution` |

**FINDING:** The transaction_execution object **SURVIVES** but requires careful recovery at multiple points. The Block 4→5 Adapter has a fallback mechanism that parses UI sections to recover transaction data if structured data is stripped.

**Risk Rating:** ⚠️ **MEDIUM** - Recovery logic exists but is fragile; relies on UI parsing as fallback.

### 1.4 Biometric Controller Logic (Module 9.5) Deep Dive

The **Voice Processor** node implements the Biometric Controller with the following decision logic:

```
┌─────────────────────────────────────────────────────────────────┐
│                 BIOMETRIC CONTROLLER FLOW                        │
└─────────────────────────────────────────────────────────────────┘

INPUT: Audio payload (voice note)
    │
    ▼
[1. NON-AUDIO BYPASS]
    │ Is message_type === 'voice' or mime_type contains 'audio'?
    ├── NO → Return: { has_voice: false, status: "TEXT_ONLY" }
    │
    └── YES → Continue
                │
                ▼
[2. IDENTITY LOOKUP]
    │ Query: SELECT * FROM voice_profiles WHERE user_id = $1
    │
    ├── SIMULATION MODE:
    │   Only "vip_voice_user@bank.uz" is considered enrolled
    │   All others → NOT_ENROLLED
    │
    ▼
[3. ENROLLMENT GATE (Cold Start Handler)]
    │ Is user enrolled?
    │
    ├── NO → Return:
    │   {
    │     status: "NOT_ENROLLED",
    │     action_required: "TRIGGER_ENROLLMENT_FLOW",
    │     system_response: {
    │       text: "⚠️ Voice ID not set up..."
    │     }
    │   }
    │
    └── YES → Continue to Verification
                │
                ▼
[4. SPOOFING DETECTION (Deepfake Defense)]
    │ Azure/Pindrop API Simulation:
    │   • noise_floor: -45 dB (quality check)
    │   • synthetic_markers: 0.05 (5% AI-generation probability)
    │   • replay_attack_detected: false
    │
    ├── IF synthetic_markers > 0.3:
    │   Return: { status: "SPOOF_DETECTED", action: "BLOCK" }
    │
    └── IF all checks pass:
        Return: { status: "VERIFIED", confidence: 0.95 }
```

**Cold Start User Handling:**
- Unenrolled users are redirected to an enrollment flow
- System provides explicit instructions: "Reply with: 'Enroll Voice' to start"
- No transaction processing occurs until enrollment completes

**High-Value Fraud Risk Handling:**
- The system has a **placeholder** for Deepfake Protocol (> $10k transactions)
- Current implementation uses simulated synthetic markers (0.05 probability)
- **CRITICAL GAP:** No actual integration with Azure Liveness or Pindrop APIs
- **CRITICAL GAP:** No transaction amount threshold check in biometric logic

---

## TASK 2: CRITICAL DEPENDENCY & FRAGILITY AUDIT

### 2.1 Hard-Coded Dependency Map

The following nodes contain **fragile links** using `$('Node Name')` syntax that will cause system crashes if node names are renamed:

| Node | Hard-Coded Dependencies | Risk Level |
|------|------------------------|------------|
| **Logic: Prepare Finalizer** | `$('Set: Rebuild Dispatch Guard').item.json` | 🔴 CRITICAL |
| **Logic: Generate Block 5 Seal** | `$('Approval Envelope Validator1').first().json` | 🔴 CRITICAL |
| **STORAGE PREP & CONTRACT LOCK** | `$('Logic: Generate Block 5 Seal').first().json`<br>`$('Generate Embedding Vector1').first().json` | 🔴 CRITICAL |

**Impact Analysis:**
- Renaming any of the referenced nodes will cause immediate `REFERENCE_ERROR`
- Workflow execution will halt at the dependent node
- No fallback mechanism exists for these dependencies

**Remediation:** Replace `$('Node Name')` syntax with explicit data flow through Merge nodes or parameter passing.

### 2.2 Additional Fragility Patterns

| Pattern | Location | Risk |
|---------|----------|------|
| `$node["Node Name"].json` | BLOCK 7.3, 7.4, 7.6 | 🔴 HIGH |
| `$('Node Name').item.json.parent_data` | Tool Execution Engine | 🔴 HIGH |
| `$$('Node Name')` | Multiple locations | 🟡 MEDIUM |

### 2.3 Block 4 → Block 5 Adapter Data Integrity Evaluation

**Adapter Logic Analysis:**

```javascript
// NODE: Block 4 → Block 5 Adapter2 (Deep Search Fix)

// 1. SEAL VERIFICATION
const phaseSeal = input.forensic?.phase_seal || input.block_4_seal_hash;
// ⚠️ WEAK: Only warns if seal missing, doesn't halt

// 2. ADVISORY PACKAGE EXTRACTION
const advisory_package = input._delivery_formatted?.formatted_deliveries?.AGENT_UI_CONSOLE?.payload || 
                         input.advisory_output || 
                         {};
// ✅ ROBUST: Multiple fallback sources

// 3. TRACE ID RECOVERY (THE FIX)
const activeTraceId = 
    input.trace_id || 
    input.canonical_ticket?.trace_id || 
    input.forensic?.advisory_log?.trace_id || 
    input._delivery_formatted?.formatted_deliveries?.WEBHOOK_DELIVERY?.payload?.trace_id ||
    "unknown";
// ✅ ROBUST: Deep recursive search across multiple paths

// 4. TRANSACTION CONTEXT
// ⚠️ NOT EXPLICITLY EXTRACTED - Relies on advisory_package preservation
```

**Data Integrity Verdict:**

| Data Element | Survival Status | Notes |
|--------------|-----------------|-------|
| trace_id | ✅ PRESERVED | Deep recovery logic exists |
| block_4_seal_hash | ✅ PRESERVED | Primary integrity check |
| advisory_package | ✅ PRESERVED | Multiple fallback sources |
| transaction_context | ⚠️ CONDITIONAL | Depends on advisory_package structure |
| biometrics | ❌ LOST | Not carried through Block 4 |
| canonical_ticket | ⚠️ PARTIAL | Only trace_id reliably recovered |

### 2.4 Canonical Ticket Schema Validation

**Schema Evolution Through Pipeline:**

```
PHASE 0 (Initial):
├── trace_id: string (REQUIRED)
├── subject: string (REQUIRED)
├── body: string (REQUIRED)
├── customer_email: string (REQUIRED)
├── severity: enum [critical, high, medium, low]
├── priority: enum [critical, high, medium, low]
├── category: enum [security, technical, billing]
├── webhook_received_at: ISO8601
├── client_ip: string
├── user_agent: string
└── __validation_attempted: boolean

PHASE 1-2 (Enrichment):
├── text_features: { subject_length, body_length, word_count, has_critical, ... }
├── rule_engine: { intent, severity, confidence, detected_at }
├── rule_based_severity: { severity, confidence, score_breakdown }
├── classification: { intent, severity, confidence, source, provenance }
└── language_analysis: { detected, confidence, scores, requires_translation }

PHASE 3 (Business Logic):
├── performance_metrics: { deadline_utc, total_processing_ms, meets_sla, is_breached }
├── business_impact: { ai_cost_uzs, manual_cost_uzs, cost_saved_uzs, roi_percent }
└── workflow_metadata: { config, workflow_start_time, workflow_version }

PHASE 4 (Advisory):
├── advisory: {
│   ├── llm_output: { explanation, suggested_next_steps, draft_customer_response, transaction_proposal }
│   ├── llm_status: { status, sanitized, pii_handled }
│   ├── advisory_confidence: { score, category }
│   └── restrictions: string[]
│}
└── _delivery_formatted: { formatted_deliveries, suggested_channel, ui_sections }

PHASE 5 (Approval):
├── approval_record: { approval_id, trace_id, advisory_hash, state, ... }
├── dispatch_result: { status, channel, dispatch_id }
└── tool_execution: { executed, tool, timestamp, result }
```

**Schema Integrity Findings:**

| Issue | Severity | Description |
|-------|----------|-------------|
| **biometrics** | 🔴 HIGH | Never integrated into canonical_ticket schema |
| **transaction_proposal** | 🟡 MEDIUM | Stored in advisory.llm_output, not top-level |
| **data_integrity.modification_count** | ✅ GOOD | Properly incremented at each phase |
| **workflow_error** | ✅ GOOD | Consistent error handling pattern |

---

## TASK 3: SECURITY & GOVERNANCE EVALUATION

### 3.1 The Governance Seal Audit

**block_4_seal_hash Generation:**

```javascript
// In: Forensic Logger & Phase Seal
const sealComponents = {
  trace_id: activeTraceId,
  advisory_id: delivery.formatted_deliveries?.WEBHOOK_DELIVERY?.payload?.advisory_id,
  llm_status: advisory.llm_status?.status,
  advisory_confidence: advisory.advisory_confidence?.score,
  suggested_channel: delivery.suggested_channel,
  compliance_check: { ... },
  safety_flags: { audit_complete, production_lockable, seal_verified }
};

const block_4_seal_hash = crypto.createHash('sha256')
  .update(deterministicStringify(sealComponents))
  .digest('hex');
```

**Immutability Assessment:**

| Property | Status | Analysis |
|----------|--------|----------|
| Cryptographic Strength | ✅ SHA-256 | Industry standard |
| Deterministic Serialization | ✅ Custom implementation | Keys sorted alphabetically |
| Tamper Evidence | ✅ Present | Any change invalidates seal |
| Replay Protection | ⚠️ PARTIAL | No nonce or timestamp in seal |
| Binding to Execution | ❌ WEAK | No $executionId in seal components |

**HMAC Verifier Bypass Potential:**

```javascript
// In: HMAC Verifier
const BANK_HMAC_SECRET = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";
// ⚠️ HARDCODED SECRET - Same key used for generation and verification

const hmacData = [
  webhook.approval_id,
  data.advisory_hash,
  webhook.trace_id,
  webhook.approver_id,
  webhook.approval_timestamp,
  webhook.decision
].join(':');

const calculatedHmac = crypto.createHmac('sha256', BANK_HMAC_SECRET).update(hmacData).digest('hex');
const hmacMatches = (calculatedHmac === webhook.approval_hmac);
```

**Bypass Vulnerabilities:**

| Vulnerability | Severity | Description |
|---------------|----------|-------------|
| **Hardcoded Secret** | 🔴 CRITICAL | `BANK_HMAC_SECRET` is embedded in code; any developer with code access can forge HMACs |
| **No Secret Rotation** | 🔴 CRITICAL | No mechanism to rotate compromised keys |
| **Timing Attack Risk** | 🟡 MEDIUM | String comparison `===` may be vulnerable to timing analysis |
| **Missing Key Version** | 🟡 MEDIUM | No key versioning in HMAC payload |

**Can a Developer Bypass the HMAC Verifier?**

**YES** - A developer with:
1. Access to the workflow JSON (which contains the hardcoded secret)
2. Knowledge of the HMAC data format (`approval_id:advisory_hash:trace_id:approver_id:timestamp:decision`)

Can forge a valid HMAC for any approval payload.

**Proof-of-Concept:**
```javascript
const crypto = require('crypto');
const BANK_HMAC_SECRET = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";

const forgedHmac = crypto.createHmac('sha256', BANK_HMAC_SECRET)
  .update("approval_123:hash_abc:trace_xyz:attacker:2026-01-01T00:00:00Z:APPROVED")
  .digest('hex');
// This HMAC will pass verification
```

### 3.2 Deepfake Defense Analysis

**Voice Gatekeeper Implementation:**

```javascript
// In: Voice Processor (Biometric Controller)

// 4. SPOOFING DETECTION (The Deepfake Defense)
const audioQuality = {
    noise_floor: -45,        // dB (Good)
    synthetic_markers: 0.05, // 5% chance of AI generation (Low)
    replay_attack_detected: false
};

// If synthetic markers > 30%, trigger deepfake protocol
if (audioQuality.synthetic_markers > 0.3) {
    return {
        biometrics: {
            status: "SPOOF_DETECTED",
            action: "BLOCK",
            audit_log: "Deepfake protocol triggered: synthetic markers exceeded threshold"
        }
    };
}
```

**Security Assessment:**

| Requirement | Implementation Status | Finding |
|-------------|----------------------|---------|
| **Real API Integration** | ❌ ABSENT | No actual Azure/Pindrop API calls |
| **Synthetic Marker Detection** | ⚠️ SIMULATED | Hardcoded 0.05 value, not computed |
| **Transaction Amount Threshold** | ❌ ABSENT | No check for >$10k transactions |
| **Liveness Detection** | ❌ ABSENT | No challenge-response mechanism |
| **Anti-Replay Protection** | ⚠️ PARTIAL | Flag exists but not enforced |

**Verdict:** The "Deepfake Protocol" is a **PLACEHOLDER**. It does not provide actual protection against sophisticated voice synthesis attacks.

**Recommendations for Production:**
1. Integrate with Azure Speaker Recognition API or Pindrop
2. Implement challenge-response (random phrase generation)
3. Add transaction amount threshold checks
4. Use real-time audio analysis for synthetic marker detection

### 3.3 Additional Security Findings

| Finding | Severity | Description |
|---------|----------|-------------|
| **PII Scrubbing** | ✅ GOOD | BLOCK 7.4 implements regex-based scrubbing for UZB market (UzCard, passport, phone) |
| **Invariant Validation** | ✅ GOOD | BLOCK 7.3 enforces hard business rules (never approve UNKNOWN actions) |
| **Idempotence Keys** | ✅ GOOD | Dispatch lock mechanism prevents duplicate processing |
| **Telegram Alerts** | ⚠️ MEDIUM | Security alerts sent to hardcoded chat ID (5375706608) |
| **Email Recipients** | ⚠️ MEDIUM | Hardcoded email addresses in dispatch nodes |

---

## APPENDIX A: COMPLETE NODE INVENTORY

| Block | Node Count | Primary Function |
|-------|------------|------------------|
| Block 1: Input & Security | 8 nodes | Webhook ingestion, voice processing, input normalization |
| Block 2: Classification | 12 nodes | Language detection, text analysis, rule-based classification |
| Block 3: Business Logic | 10 nodes | SLA calculation, business impact, transition guards |
| Block 4: AI Advisory | 14 nodes | LLM orchestration, advisory generation, governance |
| Block 5: Approval & Dispatch | 28 nodes | HMAC verification, approval logic, tool execution, dispatch |
| Block 6: Memory Core | 9 nodes | Embedding generation, memory storage, context retrieval |
| Block 7: Audit & Telemetry | 9 nodes | Forensic signing, PII scrubbing, audit ledger |
| Sticky Notes | 7 nodes | Documentation |
| **TOTAL** | **101 nodes** | |

---

## APPENDIX B: SUPABASE TABLE DEPENDENCIES

| Table | Purpose | Critical Fields |
|-------|---------|-----------------|
| `bank_approvals` | Approval request storage | approval_id, trace_id, advisory_hash, state, consumed |
| `bank_dispatch_logs` | Dispatch tracking | idempotence_key, trace_id, status, channel |
| `bank_memories` | Vector memory storage | memory_id_hash, user_id, embedding, content |
| `audit_ledger` | Immutable audit trail | traceparent, trace_id, forensic_manifest, integrity_proof |

---

## RECOMMENDATIONS SUMMARY

### Immediate Actions (Critical)

1. **Remove Hardcoded HMAC Secret** - Move to n8n environment variables or external vault
2. **Fix Fragile Node Dependencies** - Replace `$('Node Name')` with explicit data flows
3. **Implement Real Biometric API** - Integrate Azure/Pindrop for production

### Short-term (High Priority)

4. **Add Transaction Amount Checks** - Link biometric verification to transaction values
5. **Implement Key Rotation** - Add versioning to HMAC secrets
6. **Preserve Biometrics Through Pipeline** - Add biometrics to canonical_ticket schema

### Long-term (Medium Priority)

7. **Add Timing Attack Protection** - Use constant-time comparison for HMAC verification
8. **Implement Challenge-Response** - Add liveness detection for voice authentication
9. **Enhance Seal Binding** - Include $executionId in seal components

---

**Report End**

*This audit was conducted in accordance with enterprise banking security standards and n8n workflow orchestration best practices.*
