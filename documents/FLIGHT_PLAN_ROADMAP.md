# REVENANT v26.5 — THE FLIGHT PLAN
## Enterprise Implementation Roadmap for TBC Bank

**Classification:** TBC BANK CONFIDENTIAL — STRATEGIC PLANNING  
**Version:** v1.0-ENTERPRISE  
**Audience:** CTO, Project Managers, Engineering Leads  
**Timeline:** 6 Months (Weeks 1-24)  
**Last Updated:** 2026-02-12

---

## EXECUTIVE SUMMARY

This roadmap transforms Revenant v26.5 from a **proof-of-concept workflow** into a **production-grade sovereign banking system** capable of processing 10,000+ tickets/day with 99.99% uptime. The plan addresses critical vulnerabilities identified in the security audit (race conditions, Unicode attacks, memory exhaustion) while building toward Horizon 2/3 capabilities (Fraud Mesh, Predictive Insolvency).

**Investment:** $2.4M over 6 months  
**ROI:** $8.2M annually (automation savings + fraud reduction)  
**Risk Reduction:** Eliminates 3 CVSS 7.5+ vulnerabilities

---

## PHASE 1: HARDENING (Weeks 1-4)

### Objective
Close critical security gaps and establish production-grade infrastructure before any customer-facing deployment.

---

### Week 1: Infrastructure Foundation

#### Milestone 1.1: Docker Production Stack
**Owner:** DevOps Lead  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 1.1.1 | Deploy n8n in queue mode with Redis | DevOps |
| 1.1.2 | Configure PostgreSQL with pgcrypto extension | DBA |
| 1.1.3 | Set up Nginx with SSL termination and rate limiting | DevOps |
| 1.1.4 | Deploy Prometheus + Grafana monitoring | DevOps |
| 1.1.5 | Configure log aggregation (Loki or ELK) | DevOps |

**Definition of Done:**
- [ ] All containers start with `docker-compose up -d` without errors
- [ ] Health checks pass for all services (`curl localhost:5678/healthz`)
- [ ] SSL certificate valid and auto-renewing (Let's Encrypt)
- [ ] Monitoring dashboards display n8n execution metrics
- [ ] **Latency < 50ms** for internal service communication (verified by k6 load test)

---

#### Milestone 1.2: Secrets Management
**Owner:** Security Architect  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 1.2.1 | Deploy HashiCorp Vault or AWS Secrets Manager | Security |
| 1.2.2 | Migrate HMAC_SECRET from $vars to Vault | Security |
| 1.2.3 | Implement secret rotation policy (90-day cycle) | Security |
| 1.2.4 | Configure audit logging for all secret access | Security |

**Definition of Done:**
- [ ] No secrets in environment variables (verified by `grep -r`)
- [ ] Vault audit log shows all HMAC_SECRET access with timestamp + identity
- [ ] Secret rotation completes without service interruption (< 5s downtime)
- [ ] **Security scan passes** (Trivy or Snyk) with zero CRITICAL findings

---

### Week 2: Distributed Locking (Critical Patch)

#### Milestone 2.1: Redis Distributed Lock Implementation
**Owner:** Backend Lead  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 2.1.1 | Implement Redlock algorithm in n8n Code node | Backend |
| 2.1.2 | Add `acquire_approval_lock()` PostgreSQL function | DBA |
| 2.1.3 | Modify Block 5 nodes to use Redis lock before DB write | Backend |
| 2.1.4 | Add lock TTL (30s) with automatic renewal during execution | Backend |
| 2.1.5 | Implement lock cleanup cron job (every 60s) | Backend |

**Code Implementation:**
```javascript
// Redis Distributed Lock (Redlock Algorithm)
const Redlock = require('redlock');
const redis = require('redis');

const redlock = new Redlock([redis.createClient({ host: process.env.REDIS_HOST })], {
    driftFactor: 0.01,
    retryCount: 10,
    retryDelay: 200,
    retryJitter: 200
});

async function acquireDistributedLock(resource, ttl = 30000) {
    try {
        const lock = await redlock.lock(`revenant:lock:${resource}`, ttl);
        return { success: true, lock };
    } catch (err) {
        return { success: false, error: 'LOCK_ACQUISITION_FAILED' };
    }
}
```

**Definition of Done:**
- [ ] Race condition test passes: 1,000 concurrent requests with same `trace_id` → exactly 1 approval created
- [ ] Lock TTL test passes: Lock expires after 30s without renewal
- [ ] **Load test confirms:** 500 req/sec with < 1% lock contention
- [ ] Redis memory usage stable (< 100MB for 10K concurrent locks)

---

#### Milestone 2.2: Atomic Database Operations
**Owner:** DBA  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 2.2.1 | Add `ON CONFLICT DO NOTHING` to all INSERT statements | DBA |
| 2.2.2 | Implement optimistic locking with `version` column | DBA |
| 2.2.3 | Add `SELECT FOR UPDATE` in approval verification flow | DBA |
| 2.2.4 | Create database transaction wrapper for multi-table ops | DBA |

**Definition of Done:**
- [ ] All INSERT operations use atomic upsert (verified by SQL review)
- [ ] Concurrent update test: 100 threads updating same row → no lost updates
- [ ] **Database deadlock rate < 0.01%** under 1,000 concurrent transactions

---

### Week 3: Input Sanitization Hardening

#### Milestone 3.1: Unicode Normalization & Homoglyph Detection
**Owner:** Security Engineer  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
 3.1.1 | Implement NFKC Unicode normalization in Block 0 | Security |
| 3.1.2 | Integrate homoglyph detection library (e.g., `confusables`) | Security |
| 3.1.3 | Add split-token detection (e.g., "S-Y-S-T-E-M") | Security |
| 3.1.4 | Create allowlist for CEO/executive names with fuzzy matching | Security |
| 3.1.5 | Add warning banner in UI for suspicious character patterns | Frontend |

**Code Implementation:**
```javascript
// Block 0 Enhanced Sanitizer (v26.6)
const confusables = require('confusables');
const unorm = require('unorm');

function normalizeAndDetectHomoglyphs(input) {
    // Step 1: NFKC normalization
    const normalized = unorm.nfkc(input);
    
    // Step 2: Detect confusable characters
    const confusableMatches = confusables.isConfusable(normalized, {
        threshold: 0.8,
        checkAgainst: ['admin', 'nika.kurdiani', 'ceo', 'system']
    });
    
    // Step 3: Split-token detection
    const splitTokenPattern = /(\w-){3,}\w/;
    const hasSplitTokens = splitTokenPattern.test(input);
    
    return {
        normalized,
        homoglyphRisk: confusableMatches.length > 0 ? 'HIGH' : 'LOW',
        splitTokenDetected: hasSplitTokens,
        requiresHumanReview: confusableMatches.length > 0 || hasSplitTokens
    };
}
```

**Definition of Done:**
- [ ] Homoglyph test passes: "Frоm Nika Kurdiani" (Cyrillic 'о') → flagged as HIGH risk
- [ ] Split-token test passes: "S-Y-S-T-E-M O-V-E-R-R-I-D-E" → detected and blocked
- [ ] Zero-width joiner test passes: "admin" + U+200D → normalized to "admin"
- [ ] **False positive rate < 2%** on legitimate Uzbek customer names

---

#### Milestone 3.2: Prompt Injection Defense
**Owner:** ML Engineer  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 3.2.1 | Implement prompt injection classifier (Rebuff.ai or similar) | ML |
| 3.2.2 | Add system prompt hardening (delimiter enforcement) | ML |
| 3.2.3 | Create LLM output validation layer | ML |
| 3.2.4 | Add canary tokens in prompts for leak detection | ML |

**Definition of Done:**
- [ ] OWASP LLM Top 10 test suite passes (prompt injection, jailbreak attempts)
- [ ] **Canary token detection:** 100% of leaked prompts identified within 5 minutes
- [ ] LLM output validation rejects 99%+ of policy violations

---

### Week 4: Resource Management & Timeouts

#### Milestone 4.1: Zombie Execution Prevention
**Owner:** Backend Lead  
**Effort:** 4 days

| Task | Description | Owner |
|------|-------------|-------|
| 4.1.1 | Implement n8n Wait node for human-in-the-loop gates | Backend |
| 4.1.2 | Add execution TTL (15 minutes) with auto-cleanup | Backend |
| 4.1.3 | Configure n8n execution pruning (retain 7 days) | DevOps |
| 4.1.4 | Add memory monitoring alerts (> 80% heap = alert) | DevOps |
| 4.1.5 | Implement graceful degradation under load | Backend |

**Definition of Done:**
- [ ] 10,000 "PAUSE" state executions → system remains stable (no OOM)
- [ ] Executions auto-expire after 15 minutes of inactivity
- [ ] **Memory usage < 4GB** under 5,000 concurrent executions
- [ ] n8n queue depth alert triggers at > 1,000 pending executions

---

#### Milestone 4.2: Fail-Safe Configuration
**Owner:** Platform Engineer  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 4.2.1 | Implement circuit breaker for Supabase connection | Platform |
| 4.2.2 | Add local fallback mode (queue transactions locally) | Platform |
| 4.2.3 | Configure graceful degradation (advisory-only mode) | Platform |
| 4.2.4 | Add health check endpoint with dependency status | Platform |

**Definition of Done:**
- [ ] Supabase outage simulation → system enters "advisory-only" mode within 5s
- [ ] No transaction execution during dependency outage (FAILS CLOSED)
- [ ] **Recovery time < 30s** after dependency restoration
- [ ] Health endpoint returns 503 when critical dependencies down

---

### Phase 1 Exit Criteria

| Criterion | Target | Verification Method |
|-----------|--------|---------------------|
| Security scan | Zero CRITICAL findings | Trivy/Snyk report |
| Load test | 500 req/sec, < 200ms p95 | k6 load test |
| Race condition test | 0 double-spends in 10K concurrent | Custom test harness |
| Memory stability | No OOM at 5K concurrent | 24-hour stress test |
| Fail-safe test | Fails closed on dependency loss | Chaos engineering |

---

## PHASE 2: INTEGRATION (Month 2 — Weeks 5-8)

### Objective
Connect Revenant to TBC Bank's core systems and establish regulatory compliance automation.

---

### Week 5: Core Banking API Integration

#### Milestone 5.1: TBC Core Banking Connector
**Owner:** Integration Lead  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 5.1.1 | Implement ISO 20022 message formatter | Integration |
| 5.1.2 | Create TBC API client with mutual TLS | Integration |
| 5.1.3 | Add transaction execution endpoint wrapper | Integration |
| 5.1.4 | Implement idempotency key propagation | Integration |
| 5.1.5 | Add transaction status polling | Integration |

**ISO 20022 Message Template:**
```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>{{trace_id}}</MsgId>
      <CreDtTm>{{timestamp}}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>INDA</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>{{approval_id}}</InstrId>
        <EndToEndId>{{trace_id}}</EndToEndId>
      </PmtId>
      <IntrBkSttlmAmt Ccy="{{currency}}">{{amount}}</IntrBkSttlmAmt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr>
        <Nm>{{debtor_name}}</Nm>
      </Dbtr>
      <Cdtr>
        <Nm>{{creditor_name}}</Nm>
      </Cdtr>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>
```

**Definition of Done:**
- [ ] End-to-end transfer test: Revenant → TBC Core → Settlement in < 3s
- [ ] Idempotency test: Same approval_id sent 10x → exactly 1 transfer executed
- [ ] **Transaction success rate > 99.9%** under normal conditions
- [ ] Failed transactions auto-retry with exponential backoff (max 3 retries)

---

#### Milestone 5.2: Card Operations Integration
**Owner:** Integration Lead  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 5.2.1 | Implement card unblock API | Integration |
| 5.2.2 | Add PIN reset workflow | Integration |
| 5.2.3 | Create card replacement request handler | Integration |
| 5.2.4 | Add card status query endpoint | Integration |

**Definition of Done:**
- [ ] Card unblock completes in < 2s from approval
- [ ] PIN reset workflow includes SMS OTP verification
- [ ] **Card operation audit log** 100% complete with trace_id linkage

---

### Week 6: CBU Article 14 Compliance

#### Milestone 6.1: Regulatory Reporting Pipeline
**Owner:** Compliance Engineer  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 6.1.1 | Implement XML report generator (CBU schema) | Compliance |
| 6.1.2 | Create daily automated export job | Compliance |
| 6.1.3 | Add digital signature (XAdES) to reports | Compliance |
| 6.1.4 | Implement secure SFTP upload to CBU | Compliance |
| 6.1.5 | Create compliance dashboard for auditors | Compliance |

**CBU Article 14 XML Schema:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CBUReport xmlns="http://cbu.uz/article14/2024"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:schemaLocation="http://cbu.uz/article14/2024 CBU-Article14-v1.xsd"
           institutionCode="TBC001"
           reportDate="2026-02-12"
           reportType="AI_DECISION_LOG">
  
  <ReportHeader>
    <InstitutionName>TBC Bank Uzbekistan</InstitutionName>
    <LicenseNumber>UZB-TBC-2024-001</LicenseNumber>
    <ReportingPeriod start="2026-02-11T00:00:00Z" end="2026-02-11T23:59:59Z"/>
    <TotalRecords>15420</TotalRecords>
  </ReportHeader>
  
  <Decisions>
    <Decision traceId="gen-1770-abc123" timestamp="2026-02-11T10:23:45Z">
      <CustomerType>INDIVIDUAL</CustomerType>
      <DecisionType>ADVISORY</DecisionType>
      <Outcome>APPROVED</Outcome>
      <Amount currency="UZS">500000.00</Amount>
      <AIConfidence>0.85</AIConfidence>
      <HumanOverride>false</HumanOverride>
      <IntegrityHash>sha256:abc123...</IntegrityHash>
      <SLACompliance>true</SLACompliance>
      <ProcessingTimeMs>245</ProcessingTimeMs>
    </Decision>
    <!-- ... more decisions ... -->
  </Decisions>
  
  <DigitalSignature>
    <SignatureValue>...</SignatureValue>
    <SigningCertificate>...</SigningCertificate>
    <Timestamp>2026-02-12T00:00:00Z</Timestamp>
  </DigitalSignature>
</CBUReport>
```

**Definition of Done:**
- [ ] XML validates against CBU schema (XSD validation passes)
- [ ] Digital signature verifies with CBU public key
- [ ] **Daily report auto-submitted** at 00:00 UTC without manual intervention
- [ ] Compliance dashboard shows real-time CBU readiness status

---

#### Milestone 6.2: Audit Trail Immutability
**Owner:** Security Architect  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 6.2.1 | Implement Merkle tree for daily audit batches | Security |
| 6.2.2 | Add blockchain anchoring (optional, Bitcoin/Ethereum) | Security |
| 6.2.3 | Create tamper-detection alert system | Security |
| 6.2.4 | Add regulator read-only access portal | Security |

**Definition of Done:**
- [ ] Merkle root published daily to public blockchain (testnet)
- [ ] Tamper detection: Any hash mismatch triggers CRITICAL alert within 1 minute
- [ ] **Regulator portal** allows read-only query by trace_id, date range
- [ ] Audit trail replay: Can reconstruct any decision from raw logs

---

### Week 7: Testing & Validation

#### Milestone 7.1: End-to-End Test Suite
**Owner:** QA Lead  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 7.1.1 | Create API integration test suite (Postman/Newman) | QA |
| 7.1.2 | Implement chaos engineering tests (dependency failures) | QA |
| 7.1.3 | Add performance regression tests | QA |
| 7.1.4 | Create security penetration test suite | QA |
| 7.1.5 | Document test coverage report | QA |

**Definition of Done:**
- [ ] Test coverage > 85% of all API endpoints
- [ ] Chaos test: Random Supabase disconnections → 0 data loss
- [ ] **Performance regression:** p95 latency increase < 10% vs baseline
- [ ] Security test: All OWASP Top 10 vectors tested

---

#### Milestone 7.2: User Acceptance Testing
**Owner:** Product Owner  
**Effort:** 3 days

| Task | Description | Owner |
|------|-------------|-------|
| 7.2.1 | Deploy to UAT environment | DevOps |
| 7.2.2 | Conduct UAT sessions with TBC operations team | Product |
| 7.2.3 | Gather feedback and prioritize fixes | Product |
| 7.2.4 | Obtain UAT sign-off from business stakeholders | Product |

**Definition of Done:**
- [ ] UAT sign-off from TBC Head of Operations
- [ ] Zero P1/P2 defects remaining
- [ ] **User satisfaction score > 4.0/5.0** from operations team

---

### Week 8: Production Deployment Preparation

#### Milestone 8.1: Production Cutover Plan
**Owner:** DevOps Lead  
**Effort:** 5 days

| Task | Description | Owner |
|------|-------------|-------|
| 8.1.1 | Create blue-green deployment configuration | DevOps |
| 8.1.2 | Implement database migration scripts (backward compatible) | DBA |
| 8.1.3 | Configure production monitoring and alerting | DevOps |
| 8.1.4 | Create runbook for common incidents | DevOps |
| 8.1.5 | Conduct disaster recovery drill | DevOps |

**Definition of Done:**
- [ ] Blue-green deployment completes in < 5 minutes with zero downtime
- [ ] Database migration rollback tested and documented (< 10 min rollback)
- [ ] **MTTR (Mean Time To Recovery) < 15 minutes** for P1 incidents
- [ ] DR drill: Full system restore from backup in < 2 hours

---

### Phase 2 Exit Criteria

| Criterion | Target | Verification Method |
|-----------|--------|---------------------|
| Core banking integration | 99.9% success rate | 7-day production metrics |
| CBU compliance | 100% on-time submission | CBU acknowledgment receipt |
| Test coverage | > 85% | Coverage report |
| UAT sign-off | Approved | Signed document |
| DR readiness | < 2h recovery | DR drill results |

---

## PHASE 3: HORIZON FEATURES (Months 3-6 — Weeks 9-24)

### Objective
Deploy advanced AI capabilities (Predictive Insolvency, Fraud Mesh) that differentiate TBC Bank in the market.

---

### Month 3: Predictive Insolvency Engine (Weeks 9-12)

#### Milestone 9.1: Behavioral Data Pipeline
**Owner:** Data Engineer  
**Effort:** 10 days (Weeks 9-10)

| Task | Description | Owner |
|------|-------------|-------|
| 9.1.1 | Create Payme transaction stream connector | Data Eng |
| 9.1.2 | Implement real-time feature engineering | Data Eng |
| 9.1.3 | Build customer behavioral profile store | Data Eng |
| 9.1.4 | Add velocity metrics (gambling, micro-loans) | Data Eng |
| 9.1.5 | Create data quality monitoring | Data Eng |

**Behavioral Features:**
```javascript
const behavioralFeatures = {
    // Velocity Metrics
    micro_loan_frequency_30d: countMicroLoans(paymeHistory, 30),
    gambling_spend_ratio: calculateGamblingRatio(transactions),
    asset_liquidation_velocity: detectCryptoSales(transactions, 30),
    
    // Financial Health
    income_to_expense_ratio: monthlyIncome / monthlyExpenses,
    balance_trend_slope: calculateBalanceTrend(accountHistory, 90),
    credit_utilization: creditUsed / creditLimit,
    
    // Risk Signals
    late_payment_trend: detectSlippage(paymentHistory, 90),
    overdraft_frequency: countOverdrafts(accountHistory, 30),
    bounced_payment_count: countBouncedPayments(transactionHistory, 30),
    
    // Social Graph
    peer_default_correlation: checkFriendDefaults(socialGraph, 180)
};
```

**Definition of Done:**
- [ ] Payme data ingested with < 5 minute latency
- [ ] Feature store serves queries in < 50ms
- [ ] **Data quality score > 98%** (completeness + accuracy)

---

#### Milestone 9.2: ML Model Development
**Owner:** ML Lead  
**Effort:** 10 days (Weeks 11-12)

| Task | Description | Owner |
|------|-------------|-------|
| 9.2.1 | Train insolvency prediction model (XGBoost/TensorFlow) | ML |
| 9.2.2 | Implement model versioning and A/B testing | ML |
| 9.2.3 | Create model explainability layer (SHAP values) | ML |
| 9.2.4 | Add model drift detection | ML |
| 9.2.5 | Deploy model to production inference endpoint | ML |

**Model Architecture:**
```python
# Insolvency Prediction Model
import xgboost as xgb
from sklearn.model_selection import train_test_split

# Feature engineering
features = [
    'micro_loan_frequency_30d',
    'gambling_spend_ratio', 
    'income_to_expense_ratio',
    'balance_trend_slope',
    'credit_utilization',
    'late_payment_trend',
    'peer_default_correlation'
]

# Model training
model = xgb.XGBClassifier(
    n_estimators=500,
    max_depth=6,
    learning_rate=0.05,
    objective='binary:logistic',
    eval_metric='auc'
)

model.fit(X_train, y_train)

# Threshold calibration (precision-recall tradeoff)
# Target: 80% precision, 60% recall for pre-default alerts
```

**Definition of Done:**
- [ ] Model AUC > 0.85 on holdout test set
- [ ] **Precision @ 80% recall:** > 70% (7 in 10 alerts are true positives)
- [ ] Model inference latency < 100ms p99
- [ ] SHAP explanations generated for every prediction

---

#### Milestone 9.3: Intervention Workflow
**Owner:** Product Owner  
**Effort:** 5 days (Week 12)

| Task | Description | Owner |
|------|-------------|-------|
| 9.3.1 | Design customer intervention strategies | Product |
| 9.3.2 | Implement automated outreach (SMS/app notification) | Backend |
| 9.3.3 | Create financial counseling referral workflow | Product |
| 9.3.4 | Add intervention effectiveness tracking | Data Eng |
| 9.3.5 | Build intervention dashboard for relationship managers | Frontend |

**Definition of Done:**
- [ ] Intervention triggered within 24h of risk score > 0.7
- [ ] Customer outreach delivered with > 95% success rate
- [ ] **Intervention acceptance rate > 30%** (customer engages with offer)
- [ ] Dashboard shows real-time risk portfolio view

---

### Month 4: Fraud Mesh Foundation (Weeks 13-16)

#### Milestone 10.1: Bank Identity & Attestation System
**Owner:** Security Architect  
**Effort:** 10 days (Weeks 13-14)

| Task | Description | Owner |
|------|-------------|-------|
| 10.1.1 | Implement ECDSA key generation for bank identity | Security |
| 10.1.2 | Create attestation certificate format | Security |
| 10.1.3 | Build attestation registry smart contract (optional) | Security |
| 10.1.4 | Add attestation verification endpoint | Security |
| 10.1.5 | Create attestation revocation mechanism | Security |

**Bank Attestation Format:**
```json
{
  "bank_id": "TBC_UZ_001",
  "legal_name": "TBC Bank Uzbekistan",
  "jurisdiction": "UZ",
  "capabilities": ["fraud_detect", "card_unblock", "transaction_monitor"],
  "risk_class": "TIER_1",
  "public_key": "04a1b2c3d4e5f6...",
  "issued_at": "2026-01-01T00:00:00Z",
  "expires_at": "2027-01-01T00:00:00Z",
  "signature": "3045022100...",
  "issuer": "UZB_CENTRAL_BANK"
}
```

**Definition of Done:**
- [ ] Attestation generates in < 100ms
- [ ] Verification passes for valid attestations, rejects expired/revoked
- [ ] **Key rotation** completes without service interruption

---

#### Milestone 10.2: Signal Exchange Protocol
**Owner:** Backend Lead  
**Effort:** 10 days (Weeks 15-16)

| Task | Description | Owner |
|------|-------------|-------|
| 10.2.1 | Design signal schema (hashed, anonymized) | Backend |
| 10.2.2 | Implement Bloom filter for efficient membership tests | Backend |
| 10.2.3 | Create signal broadcast mechanism (WebSocket/MQTT) | Backend |
| 10.2.4 | Add signal verification (signature + attestation) | Backend |
| 10.2.5 | Implement signal TTL and auto-expiry | Backend |

**Signal Format:**
```json
{
  "signal_type": "FRAUD_PATTERN",
  "signal_hash": "sha256:abc123...",
  "pattern_fingerprint": "e91a...",
  "origin_bank": "TBC_UZ_001",
  "origin_jurisdiction": "UZ",
  "confidence": 0.92,
  "ttl_seconds": 86400,
  "timestamp": "2026-02-12T10:23:45Z",
  "attestation_signature": "3045022100..."
}
```

**Definition of Done:**
- [ ] Signal propagation to 5 peer banks in < 500ms
- [ ] Bloom filter false positive rate < 1%
- [ ] **Signal verification:** 100% of invalid signatures rejected

---

### Month 5: Fraud Mesh Integration (Weeks 17-20)

#### Milestone 11.1: Trust Scoring Engine
**Owner:** ML Engineer  
**Effort:** 10 days (Weeks 17-18)

| Task | Description | Owner |
|------|-------------|-------|
| 11.1.1 | Design trust scoring algorithm | ML |
| 11.1.2 | Implement reputation decay (exponential) | ML |
| 11.1.3 | Add false positive penalty mechanism | ML |
| 11.1.4 | Create trust score API | ML |
| 11.1.5 | Build trust dashboard for mesh participants | Frontend |

**Trust Scoring Formula:**
```javascript
function calculateTrustScore(bankId) {
    const metrics = {
        accuracy: getSignalAccuracy(bankId, 90),      // % correct alerts
        latency: getAverageLatency(bankId, 90),        // response time
        volume: getSignalVolume(bankId, 90),           // signals sent
        transparency: getIncidentTransparency(bankId)  // disclosure rate
    };
    
    // Weighted score
    const score = (
        metrics.accuracy * 0.4 +
        (1 / metrics.latency) * 0.2 +
        Math.min(metrics.volume / 100, 1) * 0.2 +
        metrics.transparency * 0.2
    );
    
    // Exponential decay for inactivity
    const daysSinceLastSignal = getDaysSinceLastSignal(bankId);
    const decayFactor = Math.exp(-daysSinceLastSignal / 30);
    
    return score * decayFactor;
}
```

**Definition of Done:**
- [ ] Trust score updates within 1 hour of new signal
- [ ] **Reputation decay:** 50% reduction after 30 days inactivity
- [ ] False positive penalty: -10 points per false alert

---

#### Milestone 11.2: Federated Decision Protocol
**Owner:** Backend Lead  
**Effort:** 10 days (Weeks 19-20)

| Task | Description | Owner |
|------|-------------|-------|
| 11.2.1 | Implement quorum-based voting | Backend |
| 11.2.2 | Add multi-signature decision verification | Backend |
| 11.2.3 | Create decision timeout handling | Backend |
| 11.2.4 | Implement decision audit trail | Backend |
| 11.2.5 | Add emergency override (regulator) | Backend |

**Federated Decision Flow:**
```
1. Local bank detects high-risk transaction
2. Request federated opinion (broadcast to mesh)
3. Peer banks respond with signed votes (30s timeout)
4. Quorum reached (3 of 5 banks agree)
5. Multi-sig decision recorded on-chain
6. Local bank executes based on consensus
```

**Definition of Done:**
- [ ] Quorum decision in < 5 seconds
- [ ] **Multi-sig verification:** All decisions cryptographically provable
- [ ] Emergency override: Regulator can force decision in < 1 minute

---

### Month 6: Production Hardening & Launch (Weeks 21-24)

#### Milestone 12.1: Zero-Knowledge Proof Integration
**Owner:** Cryptography Lead  
**Effort:** 10 days (Weeks 21-22)

| Task | Description | Owner |
|------|-------------|-------|
| 12.1.1 | Implement ZK-SNARK circuit for policy proofs | Crypto |
| 12.1.2 | Create proof generation service | Crypto |
| 12.1.3 | Add proof verification endpoint | Crypto |
| 12.1.4 | Integrate with regulator portal | Crypto |
| 12.1.5 | Performance optimization (< 2s proof generation) | Crypto |

**ZK Policy Proof Example:**
```javascript
// Prove: "We ran AML checks AND risk score < threshold"
// Without revealing: The actual risk score or check details

const circuit = `
    template PolicyProof() {
        signal private input riskScore;
        signal private input amlCheckPassed;
        signal input threshold;
        signal output valid;
        
        // Constraints
        valid <== amlCheckPassed * (riskScore < threshold);
    }
`;

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { riskScore: 42, amlCheckPassed: 1, threshold: 70 },
    'policy_proof.wasm',
    'circuit_final.zkey'
);

// Regulator verifies without seeing private inputs
const isValid = await snarkjs.groth16.verify(
    verificationKey,
    publicSignals,  // Only threshold and validity visible
    proof
);
```

**Definition of Done:**
- [ ] Proof generation < 2 seconds
- [ ] Proof verification < 100ms
- [ ] **Regulator can verify compliance** without accessing sensitive data

---

#### Milestone 12.2: Production Launch
**Owner:** Program Manager  
**Effort:** 10 days (Weeks 23-24)

| Task | Description | Owner |
|------|-------------|-------|
| 12.2.1 | Final security audit (external firm) | Security |
| 12.2.2 | Performance benchmarking (10K req/sec) | QA |
| 12.2.3 | Disaster recovery validation | DevOps |
| 12.2.4 | Go-live approval from CBU | Compliance |
| 12.2.5 | Production deployment with monitoring | DevOps |

**Definition of Done:**
- [ ] External security audit: Zero CRITICAL findings
- [ ] **Load test:** 10,000 req/sec sustained for 1 hour
- [ ] CBU approval letter received
- [ ] Production deployment with zero downtime
- [ ] 99.99% uptime SLA achieved in first 30 days

---

### Phase 3 Exit Criteria

| Criterion | Target | Verification Method |
|-----------|--------|---------------------|
| Predictive Insolvency | AUC > 0.85 | Model evaluation report |
| Fraud Mesh | 5 banks connected | Integration test |
| ZK Proofs | < 2s generation | Performance benchmark |
| Production readiness | Zero CRITICAL findings | External audit |
| Uptime SLA | 99.99% | Monitoring dashboard |

---

## APPENDIX A: RISK MITIGATION MATRIX

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Redis lock fails under load | Medium | High | Implement PostgreSQL advisory locks as fallback |
| ML model bias | Medium | High | Regular bias audits, diverse training data |
| Partner bank drops out | Low | Medium | Minimum 3 banks required for mesh consensus |
| CBU regulation changes | Medium | High | Modular compliance layer, 2-week update SLA |
| Quantum computer breakthrough | Low | Critical | Post-quantum crypto migration plan (v29) |

---

## APPENDIX B: SUCCESS METRICS DASHBOARD

### Operational Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Ticket processing volume | 10,000/day | n8n execution count |
| Average processing time | < 500ms | End-to-end latency |
| p99 latency | < 2,000ms | Prometheus metrics |
| Error rate | < 0.1% | Sentry + n8n logs |
| System uptime | 99.99% | Uptime monitor |

### Business Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cost per ticket | < 2,500 UZS | Business impact calculator |
| Automation rate | > 80% | Ticket status distribution |
| Customer satisfaction | > 4.5/5 | Post-interaction survey |
| Fraud detection rate | > 95% | Confirmed fraud / total alerts |
| NPL reduction | 15% | Loan portfolio analysis |

---

## APPENDIX C: GOVERNANCE STRUCTURE

### Steering Committee
- **Chair:** TBC Bank CTO
- **Members:** Head of Operations, CISO, Compliance Officer, Product Lead
- **Cadence:** Bi-weekly during Phase 1-2, Monthly during Phase 3

### Technical Review Board
- **Chair:** Revenant Chief Architect
- **Members:** DevOps Lead, Security Architect, ML Lead
- **Cadence:** Weekly architecture reviews

### Escalation Path
1. **P1 (System Down):** Immediate call to DevOps Lead + CTO
2. **P2 (Feature Blocked):** 4-hour SLA to Technical Review Board
3. **P3 (Technical Debt):** Next sprint planning discussion

---

**Document Version:** v1.0-ENTERPRISE  
**Next Review:** 2026-03-01  
**Approved By:** [Pending CTO Sign-off]

---

*End of Flight Plan*
