# REVENANT ENTERPRISE WORKFLOW ARCHITECTURAL DOCTRINE
## Compliance Extraction from REVENANT_V26_5.json & Revenant_Roadmap.md
### Version: v26.5 Baseline | Roadmap Coverage: v24–v40
### Classification: PRODUCTION-GRADE ENTERPRISE STANDARD

---

# SECTION 1: WORKFLOW STRUCTURAL STANDARDS

## 1.1 Block-Based Architecture

The REVENANT system enforces a **strict block-based modular architecture** where functionality is segmented into logical blocks:

| Block ID | Name | Purpose | Color Code |
|----------|------|---------|------------|
| BLOCK 0 | Input Normalizer & Security | Ingestion, sanitization, rate limiting, prompt injection defense | Color 6 (Orange) |
| BLOCK 1 | Enhanced Input & Security | Biometric processing, enrollment, voice verification | Color 6 (Orange) |
| BLOCK 2 | Classification & Context | Intent detection, severity classification, language analysis | Color 3 (Blue) |
| BLOCK 3 | Business Logic | SLA calculation, ROI metrics, validation, transition guarding | Color 5 (Purple) |
| BLOCK 4 | AI & Memory Context | LLM advisory, confidence labeling, governance gating | Color 6 (Orange) |
| BLOCK 5 | Approval & Dispatch | HMAC verification, channel routing, idempotency locking | Color 4 (Green) |
| BLOCK 6 | Memory Core | Vector storage, embedding, recall, integrity guarding | Color 3 (Blue) |
| BLOCK 7 | Forensic & Audit | Telemetry, compliance, PII scrubbing, HMAC signing | Color 6 (Orange) |
| BLOCK 8 | Execution Engine | Contract building, policy firewall, human-in-the-loop | Color 4 (Green) |
| BLOCK 9 | Logic Distribution | Switch routing, human approval, core banking API | Color 4 (Green) |

## 1.2 Node Positioning Standard

- **X-axis spacing**: 224 pixels between sequential nodes (standard n8n grid)
- **Y-axis alignment**: Nodes within same block share consistent Y-coordinate
- **Block vertical separation**: 448 pixels between block boundaries
- **Sticky notes**: Positioned at `y = block_y - 384` with `height = 704`, `width = variable`

## 1.3 Connection Topology Rules

```json
{
  "connection_rules": {
    "main_flow": "sequential_with_merge_points",
    "merge_strategy": "combineByPosition OR fieldsToMatchString: trace_id",
    "error_handling": "dedicated_error_exit_nodes",
    "branching": "if_nodes_for_binary_decisions",
    "multi_routing": "switch_nodes_for_channel_selection"
  }
}
```

## 1.4 Required Node Sequence Per Block

Every block MUST follow this internal structure:
1. **Ingress Node** (Code/Set/HTTP Request) - Data ingestion
2. **Processing Node(s)** (Code) - Business logic
3. **Validation Node** (If/Switch) - Decision gates
4. **Egress Node** (Code/HTTP Request) - Output preparation
5. **Seal Node** (Code) - Cryptographic sealing

---

# SECTION 2: NODE NAMING CONVENTION RULES

## 2.1 Naming Pattern Hierarchy

```
[BLOCK_ID]: [Function] - [Version] ([Qualifier])
```

### Standard Formats:

| Node Type | Naming Pattern | Example |
|-----------|---------------|---------|
| Code Node (Primary) | `BLOCK X.Y: [Function] - [Version]` | `BLOCK 7.6: Forensic Signer` |
| Code Node (Hardened) | `BLOCK X.Y: [Function] (Hardened v[Version])` | `BLOCK 8.2: Execution Policy Firewall (Hardened v26.3)` |
| HTTP Request | `BLOCK X.Y: [Function]` | `BLOCK 7.7: Telemetry Sink` |
| Set Node | `Set: [Function]` | `Set: Rebuild Dispatch Guard` |
| If Node | `BLOCK X: [Function]` or `[Condition]` | `BLOCK 0: Security Gate` |
| Switch Node | `BLOCK X.Y: [Function]` | `BLOCK 9.0: Logic Distributor` |
| Merge Node | `Merge: [Description]` | `Merge: Phase 0 Output + SB0 Config` |
| Sticky Note | `[BLOCK X]: [Description]` | `BLOCK 6: Memory Core` |

## 2.2 Version Numbering Convention

- **Major version**: Block-level changes (e.g., v26)
- **Minor version**: Node-level enhancements (e.g., v26.3)
- **Patch version**: Bug fixes, hardening (e.g., v26.5)
- **Version MUST** be reflected in:
  - Node name
  - Code comments (`@version` JSDoc tag)
  - Output metadata (`system_version`, `node_version`)

## 2.3 Special Node Prefixes

| Prefix | Meaning | Usage |
|--------|---------|-------|
| `⚠️` | Error/Warning Path | Error handler nodes |
| `If` | Binary Decision | If node without custom name |
| `Switch:` | Multi-way Routing | Switch node |
| `Logic:` | Data Transformation | Intermediate processing |
| `Stop:` | Terminal Node | Workflow termination |
| `Get a row` / `Create a row` | Database Operations | Supabase nodes |

## 2.4 Prohibited Naming Patterns

- ❌ Generic names: "Code", "Function", "Process"
- ❌ No version numbers
- ❌ Special characters outside `:` `-` `(` `)` `.`
- ❌ Emoji in functional node names (except ⚠️ for errors)
- ❌ Abbreviations without context

---

# SECTION 3: STICKY NODE SEGMENTATION PATTERN

## 3.1 Sticky Note Structure

```json
{
  "type": "n8n-nodes-base.stickyNote",
  "parameters": {
    "content": "# [BLOCK X]: [Block Name]",
    "height": 704,
    "width": [adaptive],
    "color": [1-6]
  },
  "position": [x, y]
}
```

## 3.2 Color Coding Standard

| Color Value | Meaning | Block Assignment |
|-------------|---------|------------------|
| 1 (Yellow) | General/Info | Reserved |
| 2 (Orange) | Warning/Caution | Reserved |
| 3 (Blue) | Processing/Logic | BLOCK 2, BLOCK 6 |
| 4 (Green) | Success/Execution | BLOCK 5, BLOCK 8, BLOCK 9 |
| 5 (Purple) | Business Logic | BLOCK 3 |
| 6 (Orange) | Security/Input | BLOCK 0, BLOCK 1, BLOCK 4, BLOCK 7 |

## 3.3 Sticky Note Positioning Formula

```
position[0] = (leftmost_node_x + rightmost_node_x) / 2 - (width / 2)
position[1] = block_base_y - 384
```

## 3.4 Mandatory Sticky Note Content

Every sticky note MUST contain:
1. Block number with `#` prefix
2. Block name
3. Brief description (optional for sub-blocks)

Example:
```
# BLOCK 6: Memory Core
```

---

# SECTION 4: EXPRESSION FORMATTING RULES

## 4.1 n8n Expression Syntax Standards

### 4.1.1 Basic Field Access
```javascript
// CORRECT
{{ $json.trace_id }}
{{ $json.canonical_ticket.subject }}
{{ $json.meta.stage }}

// INCORRECT
{{$json.trace_id}}  // Missing spaces
{{ $json["trace_id"] }}  // Bracket notation (avoid)
```

### 4.1.2 JSON Stringify for Nested Objects
```javascript
// REQUIRED for nested objects in HTTP bodies
{{ JSON.stringify($json.config) }}
{{ JSON.stringify($json.canonical_ticket) }}
```

### 4.1.3 Conditional Expressions
```javascript
// Boolean checks
{{ $json.block3_passed === true }}
{{ $json.__security_stop === true }}

// Null/undefined checks  
{{ !!$json.payload?.customer_email }}
{{ $json.body?.amount || 0 }}
```

### 4.1.4 Date Expressions
```javascript
{{ new Date().toISOString() }}
{{ $json.__eligibility_checked_at }}
```

### 4.1.5 Node Reference Expressions
```javascript
// Referencing specific node output
{{ $('Node Name').item.json.field }}
{{ $('Is Eligible for Dispatch?').item.json.trace_id }}

// Referencing pinned data
{{ $node["Node Name"].json.field }}
```

## 4.2 Expression Usage by Node Type

| Node Type | Expression Context | Example |
|-----------|-------------------|---------|
| Set Node (raw) | `jsonOutput` field | `={"key": "{{ $json.value }}"}` |
| HTTP Request | URL, headers, body | `={{ $json.webhook_endpoint }}` |
| If Node | `leftValue` | `={{ $json.block3_passed }}` |
| Gmail | Subject, message | `={{ 'Bank Advisory: ' + $json.trace_id }}` |
| Telegram | Text | `={{ $json.status }}` |

## 4.3 Expression Escaping Rules

```javascript
// In JSON strings, escape quotes
"responseBody": "={\"status\": \"{{ $json.status }}\"}"

// For raw JSON output in Set nodes
"jsonOutput": "={\n  \"trace_id\": \"{{ $json.trace_id }}\"\n}"
```

---

# SECTION 5: ID / CREDENTIAL HANDLING RULES

## 5.1 UUID Generation Standards

### 5.1.1 Node IDs
- Format: Standard UUID v4
- Example: `"8f9d7ca5-7dc1-4fe4-a7de-0fa222d500ea"`
- Must be unique across entire workflow

### 5.1.2 Trace ID Generation
```javascript
// Standard pattern
trace_id: `${timestamp}-${randomHex}`

// Examples from codebase:
"gen-1770802147-2m13ranCCxXGKzrk7sw6"
"exec_${Math.floor(Math.random() * 100000)}"
`seal_${Date.now()}_${$executionId.substring(0, 8)}`
```

## 5.2 Credential Reference Pattern

```json
{
  "credentials": {
    "supabaseApi": {
      "id": "0fqPMb0O72FlSmre",
      "name": "Supabase account"
    },
    "openRouterApi": {
      "id": "i9IwzVtUXwozo1a1",
      "name": "OpenRouter account"
    },
    "telegramApi": {
      "id": "yjwDuV3yJLyJKyeh",
      "name": "Telegram account"
    },
    "gmailOAuth2": {
      "id": "DJ64JmJOpMVqx2VB",
      "name": "Gmail account"
    }
  }
}
```

## 5.3 Secret Management Hierarchy

```javascript
// Priority order for secret retrieval:
1. $vars.SECRET_NAME          // n8n Variables (preferred)
2. process.env.SECRET_NAME    // Environment variables
3. Static fallback (DEV ONLY) // Never in production

// Example:
const BANK_HMAC_SECRET = $vars.HMAC_SECRET || process.env.HMAC_SECRET;
if (!BANK_HMAC_SECRET) {
    throw new Error("CRITICAL: HMAC_SECRET is missing");
}
```

## 5.4 Webhook ID Pattern

```json
{
  "webhookId": "f860224a-492d-454b-b3dc-0970fa48ad3a"
}
```

---

# SECTION 6: ERROR HANDLING DOCTRINE

## 6.1 Error Classification System

| Error Code | Pattern | Severity | Action |
|------------|---------|----------|--------|
| `MISSING_*` | Required field absent | HIGH | Terminal exit |
| `INVALID_*` | Format/schema violation | HIGH | Validation error |
| `SECURITY_*` | Threat detected | CRITICAL | Immediate block + alert |
| `INTEGRITY_*` | Data corruption | CRITICAL | Halt workflow |
| `RATE_LIMIT_*` | Throttling triggered | MEDIUM | 429 response |
| `DB_*` | Database failure | HIGH | Circuit breaker |

## 6.2 Terminal Error Node Structure

```javascript
// ⚠️ SB1 ERROR EXIT pattern
return [{
  json: {
    __terminal_error: true,
    error_type: 'SB1_VALIDATION_TERMINAL',
    trace_id: item.json.meta?.trace_id || 'unknown',
    stage: 'SB1',
    http_code: 400,
    reason: 'Validation failed – terminal exit',
    timestamp: new Date().toISOString(),
    original_envelope: {
      meta: item.json.meta,
      config: item.json.config,
      payload: item.json.payload
    }
  }
}];
```

## 6.3 Error Response Format

```json
{
  "status": "error",
  "message": "{{ $json.reason }}",
  "error_code": "{{ $json.error_type }}",
  "trace_id": "{{ $json.trace_id }}",
  "stage": "{{ $json.stage }}",
  "timestamp": "{{ $json.timestamp }}"
}
```

## 6.4 Circuit Breaker Pattern

```javascript
// Memory Integrity Guard example
if (upstreamError) {
    return [{
        json: {
            memory_status: "CIRCUIT_OPEN",
            error_type: "DATABASE_UNAVAILABLE",
            circuit_breaker_triggered: true,
            security_gate: { 
                stop_execution: true, 
                reason: "DB_INTEGRITY_FAILURE" 
            }
        }
    }];
}
```

## 6.5 OnError Configuration

```json
{
  "onError": "continueErrorOutput"  // For nodes with error branches
}
```

---

# SECTION 7: SECURITY & VALIDATION DOCTRINE

## 7.1 Multi-Layer Security Architecture

```
Layer 1: Rate Limiting (DDoS Defense)
Layer 2: Input Sanitization (XSS/SQL Injection)
Layer 3: Prompt Injection Detection
Layer 4: Authority Poisoning Detection
Layer 5: HMAC Verification
Layer 6: Replay Attack Prevention
Layer 7: Circuit Breaker
```

## 7.2 Rate Limiter Implementation

```javascript
const STATIC_DATA = $getWorkflowStaticData('global');
const LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS = 10;

// Garbage collection + counter logic
// Block if exceeded
```

## 7.3 HMAC Signature Standard

```javascript
// HMAC Construction
const hmacData = [
    webhook.approval_id,
    data.advisory_hash,
    webhook.trace_id,
    webhook.approver_id,
    webhook.approval_timestamp,
    webhook.decision
].map(val => String(val || '').trim()).join(':');

const calculatedHmac = crypto
    .createHmac('sha256', BANK_HMAC_SECRET)
    .update(hmacData, 'utf8')
    .digest('hex');

// Constant-time comparison
const targetBuffer = Buffer.from(calculatedHmac);
const inputBuffer = Buffer.from(webhook.approval_hmac);
let hmacMatches = crypto.timingSafeEqual(targetBuffer, inputBuffer);
```

## 7.4 PII Scrubbing Patterns

```javascript
const patterns = {
    uz_card: /(8600|5614)[0-9]{12}/g,
    passport: /[A-Z]{2}[0-9]{7}/g,
    phone: /\+?998[0-9]{9}/g,
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
};

// Masking: Keep first 4, X middle, last 2
return match.substring(0, 4) + "XXXX" + match.substring(match.length - 2);
```

## 7.5 Threat Detection Patterns

```javascript
const THREAT_PATTERNS = [
    "ignore previous instructions",
    "system override", 
    "developer mode",
    "act as a unlocked",
    "always answer yes"
];

const AUTHORITY_PATTERNS = [
    /from:\s*.*@.*/i,
    /sent from my iphone/i,
    /\[system_override\]/i,
    />\s*on\s+.*wrote:/i,
    /admin|root|ceo|cfo|director/i
];
```

## 7.6 Validation Gate Requirements

Every validation gate MUST:
1. Check all required fields
2. Validate data types
3. Check length limits (subject ≤500, body ≤5000)
4. Verify no script injection
5. Validate email format with regex
6. Set `__validation_attempted: true`
7. Return structured error or pass flag

---

# SECTION 8: DATABASE INTERACTION PATTERNS

## 8.1 Supabase HTTP Request Pattern

```javascript
// POST (Create)
{
  "method": "POST",
  "url": "https://[project].supabase.co/rest/v1/[table]",
  "headerParameters": {
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates"
  }
}

// PATCH (Update with filter)
{
  "method": "PATCH",
  "url": "=https://[project].supabase.co/rest/v1/[table]?[column]=eq.{{ $json.value }}"
}

// GET (Select with filter)
{
  "url": "=https://[project].supabase.co/rest/v1/[table]?[column]=eq.{{ $json.value }}&select=*"
}
```

## 8.2 RPC Call Pattern

```javascript
{
  "method": "POST",
  "url": "https://[project].supabase.co/rest/v1/rpc/[function_name]",
  "jsonBody": "={\n  \"param\": {{ JSON.stringify($json.value) }}\n}"
}
```

## 8.3 Idempotency Key Pattern

```javascript
const idempotence_key = crypto.createHash('sha256')
    .update(`${validated.approval_id}:${approved_channel}:${validated.trace_id}:${input.advisory_hash}`)
    .digest('hex');
```

## 8.4 Required Database Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `bank_approvals` | Approval state tracking | approval_id, trace_id, state, consumed |
| `bank_dispatch_logs` | Delivery tracking | idempotence_key, trace_id, status |
| `bank_memories` | Vector memory storage | memory_id_hash, embedding, content |
| `audit_ledger` | Forensic audit trail | traceparent, metadata, ops_stream |
| `ai_training_datasets` | Training data | dataset_name, input_vector, outcome |

---

# SECTION 9: TRACEABILITY, HASHING & VALIDATION

## 9.1 Trace ID Propagation

```javascript
// Golden Thread Pattern
trace_id: ct.trace_id || root.trace_id || input.trace_id || `ORPHAN_TRACE_${crypto.randomBytes(8).toString('hex')}`

// W3C Trace Context
traceparent: `00-${trace_id}-${span_id}-01`
```

## 9.2 Hashing Standards

```javascript
// SHA-256 for all seals
const seal_hash = crypto.createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex');

// Deterministic JSON stringify
function deterministicStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(item => deterministicStringify(item)).join(',') + ']';
    const sortedKeys = Object.keys(obj).sort();
    const keyValuePairs = sortedKeys.map(key => 
        JSON.stringify(key) + ':' + deterministicStringify(obj[key])
    );
    return '{' + keyValuePairs.join(',') + '}';
}
```

## 9.3 Seal Structure

```javascript
const executionSeal = {
    seal_id: `seal_${Date.now()}_${$executionId.substring(0, 8)}`,
    seal_type: 'COMPLIANT_EXECUTION',
    sealed_at: new Date().toISOString(),
    phase_3_complete: true,
    phase_3_status: 'FROZEN',
    compliance_summary: {
        invariant_score: validation.compliance_score || 0,
        contract_locked: contract.lock_status || 'UNKNOWN',
        overall_compliant: isCompliant
    },
    block_4_authorization: {
        authorized: true,
        entry_timestamp: new Date().toISOString()
    }
};
```

## 9.4 Data Integrity Tracking

```javascript
data_integrity: {
    last_modified: Date.now(),
    modification_count: (ct.data_integrity?.modification_count || 0) + 1,
    classification_normalized: true
}
```

---

# SECTION 10: VERSIONING PHILOSOPHY

## 10.1 Semantic Versioning for Workflows

```
REVENANT_v[MAJOR].[MINOR]

Examples:
- REVENANT_v26_5 (Major: 26, Minor: 5)
- REVENANT_v23 (Major: 23, Minor: 0)
```

## 10.2 Version Evolution Principles (from Roadmap)

| Version | Codename | Core Addition |
|---------|----------|---------------|
| v24 | IRON HAND | Execution Engine |
| v25 | AUTONOMOUS CONTROL PLANE | Self-governance |
| v26 | INTERBANK BRAIN | Federated Trust Layer |
| v27 | SOVEREIGN INTELLIGENCE PROTOCOL | AI-to-AI Treaties |
| v28 | BLACKBOX PROTOCOL | Crisis Mode & Kill-Switch |
| v29 | TIMELOCK SHIELD | Post-Quantum Cryptography |
| v30 | LEX MACHINA | AI Constitution |
| v31 | ARGUS | Ombudsman & Review API |
| v32 | LIGHTHOUSE | Public Transparency Ledger |
| v33 | EQUILIBRIUM | Bias Monitor |
| v34 | EQUILIBRIUM CORE | Self-Calibration |
| v35 | EVOLUTION CHAMBER | Autonomous Retraining |
| v36 | INTERNAL WAR MACHINE | Autonomous Red Team |
| v37 | GLASS WALL | Regulator Mirror Node |
| v38 | PRUDENCE CORE | Capital Risk Buffer |

## 10.3 Cross-Version Dependencies

```
v32 (Transparency Ledger) depends on:
  ├── v29 (PQ Signatures)
  ├── v30 (Constitution)
  └── v31 (Ombudsman)

v28 (Crisis Mode) can override:
  ├── v26-27 (Mesh operations)
  ├── v24-25 (Execution)
  └── All downstream blocks
```

## 10.4 Version Constraints

1. **Never decrease block numbers** in future versions
2. **Preserve all sticky notes** - no removal
3. **Maintain trace_id continuity** across all versions
4. **Hash algorithms must remain backward-compatible**
5. **Database schemas must support migration paths**

---

# SECTION 11: JSON SCHEMA COMPLIANCE REQUIREMENTS

## 11.1 Required Top-Level Fields

```json
{
  "name": "REVENANT_v[MAJOR]_[MINOR]",
  "nodes": [...],
  "pinData": {...},
  "connections": {...},
  "settings": {
    "executionOrder": "v1"
  }
}
```

## 11.2 Node Schema Requirements

Every node MUST include:
```json
{
  "parameters": {...},
  "type": "n8n-nodes-base.[type]",
  "typeVersion": "[version]",
  "position": [x, y],
  "id": "[uuid]",
  "name": "[formatted name]"
}
```

## 11.3 Code Node Requirements

```json
{
  "parameters": {
    "jsCode": "// [File header comment]\n// @version [version]\n// [JSDoc description]\n\nconst item = $input.first();\n..."
  },
  "type": "n8n-nodes-base.code",
  "typeVersion": 2
}
```

## 11.4 Connection Schema

```json
{
  "connections": {
    "Source Node Name": {
      "main": [
        [
          {
            "node": "Target Node Name",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```

---

# SECTION 12: STRICT RULES FOR FUTURE VERSIONS

## 12.1 Structural Invariants (MUST NOT VIOLATE)

| Rule | Constraint | Violation Consequence |
|------|------------|----------------------|
| R1 | Block-based architecture must persist | System becomes unmaintainable |
| R2 | Sticky notes must exist for every block | Loss of visual segmentation |
| R3 | trace_id must propagate through all nodes | Audit trail breaks |
| R4 | All database writes must be idempotent | Duplicate records |
| R5 | HMAC must use constant-time comparison | Timing attack vulnerability |
| R6 | PII must be scrubbed before logging | Data breach |
| R7 | Circuit breaker must halt on DB failure | Data corruption |
| R8 | All errors must include trace_id | Un traceable incidents |

## 12.2 Code Style Invariants

```javascript
// MUST: Use defensive programming
const ct = item.json.canonical_ticket || {};
const trace_id = ct.trace_id || 'unknown';

// MUST: Include version in code comments
/**
 * @file [Function Name]
 * @version [X.Y.Z]
 * @description [What it does]
 */

// MUST: Use crypto for all hashing
const crypto = require('crypto');

// MUST: Validate before processing
if (!input.trace_id) {
    throw new Error('MISSING_TRACE_ID');
}

// MUST: Include timestamps
timestamp: new Date().toISOString()
```

## 12.3 Naming Invariants

- Node names MUST include version numbers
- Block numbers MUST be sequential
- Error nodes MUST use ⚠️ prefix
- Seal nodes MUST include "Seal" in name
- Validator nodes MUST include "Validator" or "Gate" in name

## 12.4 Security Invariants

1. **Never** store secrets in code
2. **Never** log raw PII
3. **Never** allow silent failures
4. **Never** skip HMAC verification
5. **Never** auto-approve without validation
6. **Never** remove circuit breakers
7. **Never** disable rate limiting
8. **Never** skip prompt injection checks

## 12.5 Generation Constraints

When generating future versions, you MUST:

1. ✅ Read existing workflow structure first
2. ✅ Preserve all existing node IDs
3. ✅ Maintain connection topology
4. ✅ Keep sticky note positioning
5. ✅ Follow color coding standards
6. ✅ Use existing credential references
7. ✅ Preserve pinData structure
8. ✅ Maintain expression formatting

You MUST NOT:

1. ❌ Invent new structural styles
2. ❌ Simplify architecture
3. ❌ Remove sticky notes
4. ❌ Change formatting philosophy
5. ❌ Break JSON validity
6. ❌ Add commentary inside JSON structures
7. ❌ Remove version numbers from names
8. ❌ Change block color assignments

---

# APPENDIX A: Quick Reference Card

## A.1 Node Type Version Matrix

| Node Type | Current Version | Upgrade Path |
|-----------|-----------------|--------------|
| code | 2 | Check n8n release notes |
| set | 3.4 | Maintain backward compat |
| if | 2.3 | Use for binary decisions |
| switch | 3.4 | Use for multi-route |
| httpRequest | 4.3 | Latest stable |
| webhook | 2 | Fixed |
| respondToWebhook | 1.5 | Fixed |
| merge | 3.2 | Use combineByPosition |
| telegram | 1.2 | Fixed |
| gmail | 2.2 | Fixed |
| supabase | 1 | Fixed |
| stickyNote | 1 | Fixed |

## A.2 Color Assignment Quick Lookup

```
BLOCK 0, 1, 4, 7 → Color 6 (Orange/Security)
BLOCK 2, 6       → Color 3 (Blue/Processing)
BLOCK 3          → Color 5 (Purple/Business)
BLOCK 5, 8, 9    → Color 4 (Green/Execution)
```

## A.3 Expression Template Library

```javascript
// Basic field access
{{ $json.field }}

// Nested access
{{ $json.object.nested_field }}

// With default
{{ $json.field || 'default' }}

// JSON stringify
{{ JSON.stringify($json.object) }}

// Date
{{ new Date().toISOString() }}

// Node reference
{{ $('Node Name').item.json.field }}

// Conditional in expression
{{ $json.flag === true ? 'yes' : 'no' }}
```

---

**Document Classification**: ARCHITECTURAL DOCTRINE  
**Version**: 1.0  
**Extracted From**: REVENANT_V26_5.json, Revenant_Roadmap.md  
**Compliance Level**: ENTERPRISE PRODUCTION  
**Valid For**: All REVENANT versions v24–v40+
