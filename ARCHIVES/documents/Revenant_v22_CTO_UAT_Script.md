# REVENANT v22 — CTO USER ACCEPTANCE TESTING (UAT) SCRIPT
## The "Cynical Bank CTO" Validation Protocol

**Classification:** UAT DOCUMENTATION — FOR BANK EXECUTIVES  
**Version:** 1.0  
**Date:** 2026-02-07  
**Audience:** Chief Technology Officer, Chief Risk Officer, Head of Information Security  
**Prerequisites:** Access to Revenant v22 staging environment, Supabase audit dashboard, Telegram alert channel

---

# UAT OVERVIEW

This script validates three critical safety guarantees of Revenant v22:

1. **The Panic Button Test** — Emergency transaction execution with full audit trail
2. **The Imposter Test** — Voice biometric rejection of spoofed audio
3. **The Enrollment Flow** — Automatic guidance for unenrolled users

**Success Criteria:** All three tests must pass with documented evidence in the audit log.

---

# TEST 1: THE PANIC BUTTON TEST
## "Lost Wallet" Emergency Flow

### Objective
Verify that a high-risk scenario (lost card) triggers the "🔴 ACTION REQUIRED" UI, generates a proper approval request, and leaves an immutable audit trail in Supabase.

### Pre-Test Setup
```bash
# 1. Verify test environment is isolated
export REVENANT_WEBHOOK="https://n8n-staging.bank.uz/webhook/f860224a-..."
export SUPABASE_URL="https://staging-db.bank.uz"
export TELEGRAM_CHAT_ID="5375706608"

# 2. Clear previous test data
psql $SUPABASE_URL -c "DELETE FROM bank_approvals WHERE trace_id LIKE 'UAT_%';"
psql $SUPABASE_URL -c "DELETE FROM audit_ledger WHERE trace_id LIKE 'UAT_%';"

# 3. Open monitoring dashboards
echo "Open these URLs in browser tabs:"
echo "  - Supabase Dashboard: $SUPABASE_URL/project/audit"
echo "  - Telegram Alerts: https://web.telegram.org/k/#@RevenantAlerts"
echo "  - n8n Executions: https://n8n-staging.bank.uz/executions"
```

### Test Execution

#### Step 1: Submit "Lost Wallet" Request
```bash
# Submit text request simulating lost card scenario
curl -X POST $REVENANT_WEBHOOK \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "URGENT: Lost my card at restaurant",
    "body": "I was at Chorsu Market today and lost my UzCard ending in 8842. I think someone picked it up. Please freeze my account immediately! I am very worried about fraud.",
    "customer_email": "test.customer@bank.uz",
    "severity": "critical",
    "category": "security",
    "test_id": "UAT_PANIC_001"
  }'
```

#### Step 2: Verify Classification Pipeline
**Expected Output:**
```json
{
  "classification": {
    "intent": "security_alert",
    "severity": "critical",
    "confidence": 0.95
  },
  "rule_engine": {
    "detected_keywords": ["lost", "freeze", "fraud", "card"],
    "severity_boost": "critical"
  }
}
```

**CTO Verification Checklist:**
- [ ] Intent correctly classified as "security_alert"
- [ ] Severity escalated to "critical"
- [ ] Keywords detected: lost, freeze, fraud, card

#### Step 3: Verify LLM Advisory Generation
**Expected Output:**
```json
{
  "advisory": {
    "llm_output": {
      "explanation": "Customer reports lost UzCard ending in 8842 at Chorsu Market. Immediate freeze recommended to prevent fraud.",
      "suggested_next_steps": [
        "Verify customer identity",
        "Freeze card ending in 8842",
        "Issue replacement card"
      ],
      "transaction_proposal": {
        "tool_name": "FREEZE_ACCOUNT",
        "rationale": "Lost card reported, fraud risk high",
        "parameters": {
          "target_id": "CARD_****8842",
          "reason": "CUSTOMER_REPORTED_LOST"
        }
      }
    }
  }
}
```

**CTO Verification Checklist:**
- [ ] Transaction proposal is FREEZE_ACCOUNT (not DELETE_USER_DATA)
- [ ] Rationale is appropriate
- [ ] Parameters include target_id

#### Step 4: Verify "🔴 ACTION REQUIRED" UI Generation
**Expected UI Payload:**
```json
{
  "_delivery_formatted": {
    "formatted_deliveries": {
      "AGENT_UI_CONSOLE": {
        "payload": {
          "ui_sections": [
            {
              "title": "🔴 ACTION REQUIRED: FREEZE_ACCOUNT",
              "content": "REASON: Lost card reported, fraud risk high\n\nApprove this action to execute immediately.",
              "type": "alert_box_critical"
            },
            {
              "title": "Analysis",
              "content": "Customer reports lost UzCard...",
              "type": "text"
            },
            {
              "title": "Recommended Actions",
              "content": ["Verify customer identity", "Freeze card", "Issue replacement"],
              "type": "list"
            }
          ],
          "transaction_context": {
            "proposal": "FREEZE_ACCOUNT",
            "rationale": "Lost card reported, fraud risk high",
            "parameters": {
              "target_id": "CARD_****8842"
            },
            "requires_approval": true
          }
        }
      }
    }
  }
}
```

**CTO Verification Checklist:**
- [ ] Red alert box (🔴) generated
- [ ] Tool name clearly displayed: FREEZE_ACCOUNT
- [ ] Approval required flag is true
- [ ] Transaction context includes all parameters

#### Step 5: Verify Approval Request Registration
**Query Supabase:**
```sql
SELECT 
  approval_id,
  trace_id,
  state,
  approval_request->>'transaction_execution' as transaction,
  block_4_seal_hash,
  created_at
FROM bank_approvals 
WHERE trace_id LIKE 'UAT_PANIC_%'
ORDER BY created_at DESC
LIMIT 1;
```

**Expected Output:**
```
 approval_id          | approval_uat_panic_001_1707312000
 trace_id             | UAT_PANIC_001_abc123
 state                | PENDING
 transaction          | {"proposal": "FREEZE_ACCOUNT", ...}
 block_4_seal_hash    | sha256:a1b2c3d4e5f6...
 created_at           | 2026-02-07 10:00:00+00
```

**CTO Verification Checklist:**
- [ ] Approval record created with PENDING state
- [ ] block_4_seal_hash is present
- [ ] Transaction execution context stored
- [ ] 15-minute expiry timestamp set

#### Step 6: Simulate Risk Officer Approval
```bash
# Generate approval HMAC (as Risk Officer would)
export APPROVAL_ID="approval_uat_panic_001_1707312000"
export ADVISORY_HASH="sha256:hash_from_previous_step"
export TRACE_ID="UAT_PANIC_001_abc123"
export APPROVER_ID="risk_officer_jones"
export TIMESTAMP="2026-02-07T10:05:00Z"
export DECISION="APPROVED"

# Calculate HMAC
export HMAC=$(echo -n "$APPROVAL_ID:$ADVISORY_HASH:$TRACE_ID:$APPROVER_ID:$TIMESTAMP:$DECISION" | \
  openssl dgst -sha256 -hmac "$BANK_HMAC_SECRET" | cut -d' ' -f2)

# Submit approval
curl -X POST "$REVENANT_WEBHOOK/approval" \
  -H "Content-Type: application/json" \
  -d "{
    \"approval_id\": \"$APPROVAL_ID\",
    \"approval_hmac\": \"$HMAC\",
    \"trace_id\": \"$TRACE_ID\",
    \"approver_id\": \"$APPROVER_ID\",
    \"approval_timestamp\": \"$TIMESTAMP\",
    \"decision\": \"$DECISION\"
  }"
```

#### Step 7: Verify Tool Execution
**Expected Execution Log:**
```json
{
  "tool_execution": {
    "executed": true,
    "tool": "FREEZE_ACCOUNT",
    "timestamp": "2026-02-07T10:05:02Z",
    "result": {
      "status": "SUCCESS",
      "action": "ACCOUNT_FROZEN",
      "account_id": "CARD_****8842",
      "system_ref": "CBS_1707312302"
    }
  }
}
```

**CTO Verification Checklist:**
- [ ] Tool executed successfully
- [ ] Core Banking System reference returned
- [ ] Timestamp recorded

#### Step 8: Verify Telegram Alert
**Expected Telegram Message:**
```
✅ Approval Processed Successfully
----------------------------------
🆔 ID: approval_uat_panic_001_1707312000

🔗 Trace: UAT_PANIC_001_abc123

⚖️ Decision: APPROVED

⚠️ REASON: Lost card reported, fraud risk high

👤 By: risk_officer_jones

📅 Time: 2026-02-07T10:05:00Z

Status: Database updated and transaction authorized.
```

**CTO Verification Checklist:**
- [ ] Telegram alert received
- [ ] All details correct
- [ ] Sent within 5 seconds of execution

#### Step 9: Verify Immutable Audit Trail
**Query Supabase Audit Ledger:**
```sql
SELECT 
  trace_id,
  traceparent,
  audit_stream->>'manifest' as manifest,
  audit_stream->>'integrity' as integrity_proof,
  economics->>'net_savings' as savings
FROM audit_ledger 
WHERE trace_id = 'UAT_PANIC_001_abc123';
```

**Expected Output:**
```
 trace_id           | UAT_PANIC_001_abc123
 traceparent        | 00-UAT_PANIC_001_abc123-a1b2c3d4-01
 manifest           | {"decision": "APPROVED", ...}
 integrity_proof    | {"signature": "sha256:xyz789...", ...}
 savings            | 10000.00
```

**CTO Verification Checklist:**
- [ ] W3C traceparent format correct
- [ ] Forensic signature present
- [ ] Integrity proof includes SHA-256
- [ ] Economics data recorded

### Test 1: Pass/Fail Criteria

| Criteria | Pass | Fail |
|----------|------|------|
| Classification correct | ✅ | ❌ |
| Red alert UI generated | ✅ | ❌ |
| Approval record created | ✅ | ❌ |
| HMAC verification passed | ✅ | ❌ |
| Tool executed | ✅ | ❌ |
| Telegram alert sent | ✅ | ❌ |
| Audit trail immutable | ✅ | ❌ |

**Overall Test 1 Result:** ☐ PASS ☐ FAIL

---

# TEST 2: THE IMPOSTER TEST
## Voice Spoofing Detection & Rejection

### Objective
Verify that a synthetic/cloned voice is detected and rejected by the Biometric Controller, preventing unauthorized transactions.

### Pre-Test Setup
```bash
# 1. Ensure test user is enrolled
export ENROLLED_USER="vip_voice_user@bank.uz"

# 2. Generate synthetic voice using ElevenLabs
curl -X POST https://api.elevenlabs.io/v1/text-to-speech/VOICE_ID \
  -H "xi-api-key: $ELEVENLABS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is the enrolled user. Please unblock my card ending in 8842.",
    "model_id": "eleven_multilingual_v2"
  }' \
  --output synthetic_voice.wav

# 3. Record genuine voice (for comparison)
# (Use actual user's voice recording)
```

### Test Execution

#### Step 1: Submit Synthetic Voice Request
```bash
curl -X POST $REVENANT_WEBHOOK \
  -H "Content-Type: multipart/form-data" \
  -F "message_type=voice" \
  -F "customer_email=$ENROLLED_USER" \
  -F "audio=@synthetic_voice.wav" \
  -F "test_id=UAT_IMPOSTER_001"
```

#### Step 2: Verify Biometric Rejection
**Expected Output:**
```json
{
  "biometrics": {
    "has_voice": true,
    "status": "SPOOF_DETECTED",
    "spoof_score": 0.85,
    "action": "BLOCK",
    "audit_log": "Deepfake protocol triggered: synthetic markers exceeded threshold",
    "recommendation": "REJECT_TRANSACTION_ALERT_SECURITY"
  },
  "system_response": {
    "text": "⚠️ Security Alert: Voice authentication failed. This request has been flagged for manual review. Please contact your branch or use the mobile app.",
    "escalation": "SECURITY_TEAM_NOTIFIED"
  }
}
```

**CTO Verification Checklist:**
- [ ] Status is SPOOF_DETECTED (not VERIFIED)
- [ ] spoof_score > 0.3 threshold
- [ ] action is BLOCK
- [ ] Security team notified
- [ ] Customer receives rejection message

#### Step 3: Verify No Transaction Created
**Query Supabase:**
```sql
SELECT COUNT(*) as approval_count 
FROM bank_approvals 
WHERE trace_id LIKE 'UAT_IMPOSTER_%';
```

**Expected Output:**
```
 approval_count
----------------
              0
```

**CTO Verification Checklist:**
- [ ] No approval record created
- [ ] No transaction executed
- [ ] Workflow halted at biometric gate

#### Step 4: Verify Security Alert
**Expected Telegram Alert:**
```
🚨 SECURITY ALERT: VOICE SPOOFING DETECTED
----------------------------------
🆔 Trace: UAT_IMPOSTER_001_xyz789

👤 Target User: vip_voice_user@bank.uz

🔍 Spoof Score: 0.85 (Threshold: 0.30)

⚠️ Action: TRANSACTION BLOCKED

📅 Time: 2026-02-07T10:15:00Z

Recommendation: Review source IP and consider account lock.
```

**CTO Verification Checklist:**
- [ ] Security alert sent to Telegram
- [ ] Spoof score included
- [ ] Recommended action provided

#### Step 5: Submit Genuine Voice (Control Test)
```bash
# Submit genuine user voice for comparison
curl -X POST $REVENANT_WEBHOOK \
  -H "Content-Type: multipart/form-data" \
  -F "message_type=voice" \
  -F "customer_email=$ENROLLED_USER" \
  -F "audio=@genuine_voice.wav" \
  -F "test_id=UAT_GENUINE_001"
```

**Expected Output:**
```json
{
  "biometrics": {
    "has_voice": true,
    "status": "VERIFIED",
    "spoof_score": 0.05,
    "confidence": 0.95
  }
}
```

**CTO Verification Checklist:**
- [ ] Genuine voice verified
- [ ] spoof_score < 0.3
- [ ] Transaction proceeds to next stage

### Test 2: Pass/Fail Criteria

| Criteria | Pass | Fail |
|----------|------|------|
| Synthetic voice detected | ✅ | ❌ |
| Spoof score > threshold | ✅ | ❌ |
| Transaction blocked | ✅ | ❌ |
| Security alert sent | ✅ | ❌ |
| Genuine voice accepted | ✅ | ❌ |

**Overall Test 2 Result:** ☐ PASS ☐ FAIL

---

# TEST 3: THE ENROLLMENT FLOW
## Automatic Guidance for Unenrolled Users

### Objective
Verify that an unknown user (not in voice database) is automatically guided to the enrollment flow rather than being rejected or processed as a generic ticket.

### Pre-Test Setup
```bash
# Ensure user is NOT enrolled
export UNKNOWN_USER="new.customer@bank.uz"

# Verify no enrollment record exists
psql $SUPABASE_URL -c "SELECT * FROM voice_profiles WHERE email = '$UNKNOWN_USER';"
# Expected: 0 rows
```

### Test Execution

#### Step 1: Submit Voice as Unknown User
```bash
curl -X POST $REVENANT_WEBHOOK \
  -H "Content-Type: multipart/form-data" \
  -F "message_type=voice" \
  -F "customer_email=$UNKNOWN_USER" \
  -F "audio=@test_voice.wav" \
  -F "test_id=UAT_ENROLL_001"
```

#### Step 2: Verify NOT_ENROLLED Response
**Expected Output:**
```json
{
  "biometrics": {
    "has_voice": true,
    "status": "NOT_ENROLLED",
    "action_required": "TRIGGER_ENROLLMENT_FLOW",
    "audit_log": "User attempted voice auth without profile. Redirecting to enrollment."
  },
  "system_response": {
    "text": "⚠️ Voice ID not set up. To use voice commands, we need to secure your account. Please reply with: 'Enroll Voice' to start.",
    "next_step": "ENROLLMENT_INTAKE",
    "fallback_channel": "MOBILE_APP"
  },
  "enrollment_flow": {
    "triggered": true,
    "method": "SMS_VERIFICATION",
    "steps": [
      "Verify phone number via SMS",
      "Record 3 voice samples",
      "Complete liveness check",
      "Enrollment complete"
    ],
    "estimated_time": "3 minutes"
  }
}
```

**CTO Verification Checklist:**
- [ ] Status is NOT_ENROLLED (not ERROR or VERIFIED)
- [ ] Enrollment flow triggered
- [ ] Clear instructions provided to user
- [ ] Fallback channel specified
- [ ] Audit log entry created

#### Step 3: Verify No Transaction Processing
**Query Supabase:**
```sql
SELECT 
  trace_id,
  ticket_status
FROM bank_approvals 
WHERE trace_id LIKE 'UAT_ENROLL_%';
```

**Expected Output:**
```
 trace_id           | ticket_status
--------------------+---------------
 UAT_ENROLL_001_... | enrollment_pending
```

**CTO Verification Checklist:**
- [ ] Status is enrollment_pending (not auto_processed)
- [ ] No transaction created
- [ ] User guided to enrollment

#### Step 4: Simulate Enrollment Completion
```bash
# Simulate user completing enrollment
curl -X POST "$REVENANT_WEBHOOK/enrollment" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_email": "new.customer@bank.uz",
    "phone_verified": true,
    "voice_samples": ["sample1.wav", "sample2.wav", "sample3.wav"],
    "liveness_passed": true,
    "test_id": "UAT_ENROLL_001"
  }'
```

**Expected Output:**
```json
{
  "enrollment": {
    "status": "COMPLETED",
    "voice_profile_id": "vp_abc123",
    "azure_profile_id": "azure_xyz789",
    "enabled_actions": ["BALANCE_INQUIRY", "CARD_STATUS", "SIMPLE_TRANSFER"]
  },
  "next_steps": {
    "message": "Voice ID setup complete! You can now use voice commands.",
    "example_commands": [
      "What's my balance?",
      "Freeze my card",
      "Transfer 1000 som to mom"
    ]
  }
}
```

**CTO Verification Checklist:**
- [ ] Enrollment status COMPLETED
- [ ] Voice profile created
- [ ] Azure profile linked
- [ ] Enabled actions specified
- [ ] Example commands provided

#### Step 5: Verify Post-Enrollment Voice Works
```bash
# Submit voice command after enrollment
curl -X POST $REVENANT_WEBHOOK \
  -H "Content-Type: multipart/form-data" \
  -F "message_type=voice" \
  -F "customer_email=$UNKNOWN_USER" \
  -F "audio=@balance_inquiry.wav" \
  -F "test_id=UAT_ENROLLED_001"
```

**Expected Output:**
```json
{
  "biometrics": {
    "has_voice": true,
    "status": "VERIFIED",
    "confidence": 0.92
  },
  "advisory": {
    "llm_output": {
      "explanation": "Customer requested balance inquiry",
      "draft_customer_response": "Your current balance is 5,420,000 UZS."
    }
  }
}
```

**CTO Verification Checklist:**
- [ ] Voice now verified
- [ ] Transaction processed
- [ ] No enrollment prompt

### Test 3: Pass/Fail Criteria

| Criteria | Pass | Fail |
|----------|------|------|
| Unknown user detected | ✅ | ❌ |
| NOT_ENROLLED status returned | ✅ | ❌ |
| Enrollment flow triggered | ✅ | ❌ |
| Clear instructions provided | ✅ | ❌ |
| Post-enrollment voice works | ✅ | ❌ |

**Overall Test 3 Result:** ☐ PASS ☐ FAIL

---

# UAT SUMMARY REPORT

## Test Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| Test 1 | Panic Button (Lost Wallet) | ☐ PASS ☐ FAIL | Supabase: UAT_PANIC_* |
| Test 2 | Imposter (Voice Spoofing) | ☐ PASS ☐ FAIL | Telegram alerts |
| Test 3 | Enrollment Flow | ☐ PASS ☐ FAIL | Enrollment records |

## Sign-Off

**CTO Approval:**
```
I certify that the Revenant v22 system has been tested according to 
this UAT script and meets the safety requirements for production 
deployment in our banking environment.

Name: _________________________
Title: Chief Technology Officer
Date: _________________________
Signature: _____________________
```

**CISO Approval:**
```
I certify that the security controls tested (biometric verification, 
HMAC approval, audit logging) meet our information security standards.

Name: _________________________
Title: Chief Information Security Officer
Date: _________________________
Signature: _____________________
```

---

# APPENDIX: QUICK REFERENCE COMMANDS

## Monitor Workflow Execution
```bash
# Watch n8n executions
watch -n 2 'curl -s https://n8n-staging.bank.uz/rest/executions?limit=5 | jq ".data[].id"'

# Watch Supabase approvals
watch -n 2 'psql $SUPABASE_URL -c "SELECT approval_id, state, created_at FROM bank_approvals ORDER BY created_at DESC LIMIT 5;"'

# Watch Telegram alerts
# (Manual check via Telegram app)
```

## Generate Test HMAC
```bash
#!/bin/bash
# generate_hmac.sh

APPROVAL_ID=$1
ADVISORY_HASH=$2
TRACE_ID=$3
APPROVER_ID=$4
TIMESTAMP=$5
DECISION=$6
BANK_HMAC_SECRET=$7

PAYLOAD="$APPROVAL_ID:$ADVISORY_HASH:$TRACE_ID:$APPROVER_ID:$TIMESTAMP:$DECISION"
echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$BANK_HMAC_SECRET"
```

## Query Audit Trail
```sql
-- Full audit trail for a trace
SELECT 
  al.trace_id,
  al.traceparent,
  al.metadata->>'version' as version,
  al.ops_stream->>'duration_ms' as duration,
  al.ops_stream->>'status' as status,
  al.audit_stream->'manifest'->>'decision' as decision,
  al.audit_stream->'integrity'->>'signature' as signature,
  al.economics->>'net_savings' as savings_uzs,
  ba.state as approval_state,
  ba.consumed_at
FROM audit_ledger al
LEFT JOIN bank_approvals ba ON al.trace_id = ba.trace_id
WHERE al.trace_id = 'UAT_PANIC_001_abc123';
```

---

**UAT Script End — CTO Validation Protocol**
