# REVENANT v26.5 — THE GREEN BOOK
## Production API Documentation & DevOps Handbook

**Classification:** TBC BANK INTERNAL — PRODUCTION DEPLOYMENT  
**Version:** v26.5.0-PROD  
**Audience:** Senior DevOps Engineers, Platform Architects  
**Last Updated:** 2026-02-12

---

## 1. SYSTEM OVERVIEW

Revenant v26.5 is a **sovereign-grade AI decision engine** that processes banking support tickets through a deterministic 8-block pipeline, from ingress sanitization to cryptographically-sealed advisory dispatch. The system operates entirely within Uzbekistan's jurisdiction, using local n8n orchestration, Supabase PostgreSQL for audit persistence, and Redis for distributed locking—ensuring zero external dependencies for core transaction processing while maintaining CBU Article 14 compliance through immutable, HMAC-signed audit trails.

---

## 2. INFRASTRUCTURE SETUP

### 2.1 Docker Compose Configuration

```yaml
# docker-compose.yml — Revenant v26.5 Production Stack
version: '3.8'

services:
  # ============================================
  # PRIMARY: n8n Workflow Orchestrator
  # ============================================
  n8n:
    image: n8nio/n8n:1.64.0
    container_name: revenant-n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_BASIC_AUTH_USER}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_BASIC_AUTH_PASSWORD}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=n8n
      - DB_POSTGRESDB_USER=${POSTGRES_USER}
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      - EXECUTIONS_MODE=queue
      - QUEUE_BULL_REDIS_HOST=redis
      - QUEUE_BULL_REDIS_PORT=6379
      - QUEUE_BULL_REDIS_DB=0
      - WEBHOOK_URL=https://api.revenant.tbcbank.uz
    volumes:
      - n8n_data:/home/node/.n8n
      - ./workflows:/backup/workflows:ro
    depends_on:
      - postgres
      - redis
    networks:
      - revenant-net
    deploy:
      resources:
        limits:
          cpus: '4.0'
          memory: 8G
        reservations:
          cpus: '2.0'
          memory: 4G

  # ============================================
  # DATABASE: PostgreSQL (n8n internal + Supabase)
  # ============================================
  postgres:
    image: supabase/postgres:15.1.1.78
    container_name: revenant-postgres
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=n8n
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./sql/init:/docker-entrypoint-initdb.d:ro
    networks:
      - revenant-net
    command: >
      postgres
      -c shared_preload_libraries='pg_stat_statements,pgcrypto'
      -c max_connections=200
      -c shared_buffers=2GB
      -c effective_cache_size=6GB

  # ============================================
  # CACHE & LOCK: Redis (Distributed Locking)
  # ============================================
  redis:
    image: redis:7.2-alpine
    container_name: revenant-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    command: >
      redis-server
      --appendonly yes
      --appendfsync everysec
      --maxmemory 2gb
      --maxmemory-policy allkeys-lru
      --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    networks:
      - revenant-net

  # ============================================
  # REVERSE PROXY: Nginx (SSL Termination)
  # ============================================
  nginx:
    image: nginx:1.25-alpine
    container_name: revenant-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    depends_on:
      - n8n
    networks:
      - revenant-net

  # ============================================
  # MONITORING: Prometheus + Grafana (Optional)
  # ============================================
  prometheus:
    image: prom/prometheus:v2.48.0
    container_name: revenant-prometheus
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    networks:
      - revenant-net

  grafana:
    image: grafana/grafana:10.2.0
    container_name: revenant-grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER}
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/dashboards:/etc/grafana/provisioning/dashboards:ro
    networks:
      - revenant-net

volumes:
  n8n_data:
  postgres_data:
  redis_data:
  prometheus_data:
  grafana_data:

networks:
  revenant-net:
    driver: bridge
```

---

### 2.2 Environment Variables (.env)

```bash
# ============================================
# REVENANT v26.5 — PRODUCTION ENVIRONMENT
# ============================================
# CRITICAL: Never commit this file to Git.
# Store in HashiCorp Vault or AWS Secrets Manager.
# ============================================

# --------------------------------------------
# SECTION 1: n8n Core Configuration
# --------------------------------------------
N8N_BASIC_AUTH_USER=revenant_admin
N8N_BASIC_AUTH_PASSWORD=<32-char-random-string>
N8N_ENCRYPTION_KEY=<64-char-hex-encryption-key>
WEBHOOK_URL=https://api.revenant.tbcbank.uz

# --------------------------------------------
# SECTION 2: Database Configuration
# --------------------------------------------
POSTGRES_USER=revenant_prod
POSTGRES_PASSWORD=<32-char-database-password>
SUPABASE_URL=https://db.revenant.tbcbank.uz
SUPABASE_SERVICE_KEY=<supabase-service-role-key>

# --------------------------------------------
# SECTION 3: Redis (Distributed Locking)
# --------------------------------------------
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<redis-strong-password>
REDIS_DB=0

# --------------------------------------------
# SECTION 4: Cryptographic Secrets
# --------------------------------------------
HMAC_SECRET=<64-char-hex-hmac-secret>
HMAC_SECRET_ROTATION_DATE=2026-06-01
ENCRYPTION_KEY_V1=<legacy-encryption-key>
ENCRYPTION_KEY_V2=<current-encryption-key>

# --------------------------------------------
# SECTION 5: External API Credentials
# --------------------------------------------
OPENROUTER_API_KEY=<openrouter-api-key>
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_TIMEOUT_MS=15000

TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_CHAT_ID=5375706608

GMAIL_CLIENT_ID=<google-oauth-client-id>
GMAIL_CLIENT_SECRET=<google-oauth-client-secret>
GMAIL_REFRESH_TOKEN=<google-refresh-token>

# --------------------------------------------
# SECTION 6: CBU Compliance Configuration
# --------------------------------------------
CBU_COMPLIANCE_MODE=true
CBU_ARTICLE_14_ENABLED=true
CBU_REPORTING_ENDPOINT=https://reporting.cbu.uz/api/v1
CBU_REPORTING_INTERVAL_HOURS=24
CBU_INSTITUTION_CODE=TBC001
CBU_LICENSE_NUMBER=UZB-TBC-2024-001

# --------------------------------------------
# SECTION 7: Financial Limits (Block 8.2)
# --------------------------------------------
HARD_CEILING_USD=50000
CHALLENGE_FLOOR_USD=10000
HUMAN_REVIEW_THRESHOLD_USD=10000
UZS_EXCHANGE_RATE=12850

# --------------------------------------------
# SECTION 8: Rate Limiting
# --------------------------------------------
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_REDIS_KEY_PREFIX=revenant:ratelimit

# --------------------------------------------
# SECTION 9: Audit & Logging
# --------------------------------------------
AUDIT_LOG_LEVEL=info
AUDIT_LOG_RETENTION_DAYS=2555  # 7 years (CBU requirement)
FORENSIC_SEAL_ENABLED=true
TRACE_CONTEXT_VERSION=00

# --------------------------------------------
# SECTION 10: Monitoring
# --------------------------------------------
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<grafana-password>
PROMETHEUS_RETENTION_DAYS=30
SENTRY_DSN=<sentry-error-tracking-dsn>

# --------------------------------------------
# SECTION 11: Feature Flags
# --------------------------------------------
FEATURE_DISTRIBUTED_LOCK=true
FEATURE_UNICODE_NORMALIZATION=false  # Enable in v26.6
FEATURE_HOMOGLYPH_DETECTION=false    # Enable in v26.6
FEATURE_PREDICTIVE_INSOLVENCY=false  # Enable in v27
FEATURE_FRAUD_MESH=false             # Enable in v27
```

---

## 3. DATABASE SCHEMA

### 3.1 bank_approvals (Distributed Locking Table)

```sql
-- ============================================
-- TABLE: bank_approvals
-- PURPOSE: Atomic approval tracking with distributed locking
-- CRITICAL: This table implements the Redis-backed distributed lock
-- ============================================

CREATE TABLE bank_approvals (
    -- Primary Identity
    approval_id VARCHAR(128) PRIMARY KEY,
    trace_id VARCHAR(128) NOT NULL,
    
    -- Foreign References
    advisory_hash VARCHAR(64) NOT NULL,
    block_4_seal_hash VARCHAR(64) NOT NULL,
    
    -- Channel & Routing
    selected_channel VARCHAR(32) NOT NULL CHECK (selected_channel IN ('INTERNAL_UI', 'EMAIL_TEMPLATE', 'WEBHOOK_DELIVERY')),
    
    -- Cryptographic Integrity
    approval_request_hash VARCHAR(64) NOT NULL,
    request_integrity_hash VARCHAR(64) NOT NULL,
    
    -- State Machine
    state VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    
    -- Human Approval Metadata (when applicable)
    approver_id VARCHAR(64),
    approver_role VARCHAR(32),
    approval_timestamp TIMESTAMPTZ,
    decision VARCHAR(16) CHECK (decision IN ('APPROVE', 'REJECT')),
    
    -- Serialized Request Payload
    approval_request JSONB NOT NULL,
    validated_approval JSONB,
    
    -- Security Flags
    security JSONB DEFAULT '{}',
    hmac_check JSONB DEFAULT '{}',
    
    -- Distributed Lock Columns (NEW in v26.5)
    lock_token VARCHAR(64),           -- Redis lock token
    lock_acquired_at TIMESTAMPTZ,     -- When lock was acquired
    lock_expires_at TIMESTAMPTZ,      -- Lock TTL (30 seconds)
    
    -- Optimistic Locking
    version INTEGER NOT NULL DEFAULT 1,
    
    -- Indexes for Performance
    CONSTRAINT fk_trace FOREIGN KEY (trace_id) REFERENCES audit_ledger(trace_id)
);

-- ============================================
-- INDEXES for bank_approvals
-- ============================================
CREATE INDEX idx_bank_approvals_trace_id ON bank_approvals(trace_id);
CREATE INDEX idx_bank_approvals_state ON bank_approvals(state) WHERE state = 'PENDING';
CREATE INDEX idx_bank_approvals_expires ON bank_approvals(expires_at) WHERE state = 'PENDING';
CREATE INDEX idx_bank_approvals_consumed ON bank_approvals(consumed, consumed_at);
CREATE INDEX idx_bank_approvals_lock ON bank_approvals(lock_token) WHERE lock_token IS NOT NULL;

-- ============================================
-- ATOMIC UPSERT FUNCTION (Distributed Lock)
-- ============================================
CREATE OR REPLACE FUNCTION acquire_approval_lock(
    p_approval_id VARCHAR(128),
    p_lock_token VARCHAR(64),
    p_lock_ttl_seconds INTEGER DEFAULT 30
)
RETURNS TABLE (success BOOLEAN, existing_token VARCHAR(64)) AS $$
BEGIN
    -- Attempt atomic insert with ON CONFLICT
    INSERT INTO bank_approvals (approval_id, lock_token, lock_acquired_at, lock_expires_at)
    VALUES (p_approval_id, p_lock_token, NOW(), NOW() + INTERVAL '1 second' * p_lock_ttl_seconds)
    ON CONFLICT (approval_id) DO UPDATE
    SET 
        lock_token = EXCLUDED.lock_token,
        lock_acquired_at = EXCLUDED.lock_acquired_at,
        lock_expires_at = EXCLUDED.lock_expires_at,
        version = bank_approvals.version + 1
    WHERE 
        bank_approvals.lock_token IS NULL 
        OR bank_approvals.lock_expires_at < NOW();
    
    -- Return success status
    IF FOUND THEN
        RETURN QUERY SELECT TRUE, NULL::VARCHAR(64);
    ELSE
        RETURN QUERY SELECT FALSE, bank_approvals.lock_token 
        FROM bank_approvals 
        WHERE bank_approvals.approval_id = p_approval_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- CLEANUP EXPIRED LOCKS (Cron Job)
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS INTEGER AS $$
DECLARE
    cleaned_count INTEGER;
BEGIN
    UPDATE bank_approvals
    SET lock_token = NULL, lock_acquired_at = NULL, lock_expires_at = NULL
    WHERE lock_expires_at < NOW() AND lock_token IS NOT NULL;
    
    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    RETURN cleaned_count;
END;
$$ LANGUAGE plpgsql;
```

---

### 3.2 audit_ledger (Immutable Logs)

```sql
-- ============================================
-- TABLE: audit_ledger
-- PURPOSE: WORM-compliant immutable audit trail
-- CRITICAL: Append-only, hash-chained, regulator-exportable
-- ============================================

CREATE TABLE audit_ledger (
    -- Primary Identity
    id BIGSERIAL PRIMARY KEY,
    trace_id VARCHAR(128) NOT NULL UNIQUE,
    traceparent VARCHAR(55) NOT NULL,  -- W3C Trace Context format
    
    -- Temporal Anchors
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unix_timestamp_ms BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
    
    -- System Metadata
    workflow_version VARCHAR(32) NOT NULL DEFAULT 'Revenant_v26.5',
    system_version VARCHAR(32) NOT NULL DEFAULT 'v26.5.0-PROD',
    environment VARCHAR(16) NOT NULL DEFAULT 'production',
    
    -- Execution Context
    execution_id VARCHAR(64) NOT NULL,
    node_version VARCHAR(16) NOT NULL,
    
    -- Decision Outcome
    decision VARCHAR(32) NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'BLOCKED', 'ESCALATED', 'ERROR')),
    decision_reason TEXT,
    
    -- Financial Context
    amount_uzs NUMERIC(18, 2),
    amount_usd NUMERIC(18, 2),
    currency VARCHAR(3),
    
    -- Performance Metrics
    duration_ms INTEGER NOT NULL,
    meets_sla BOOLEAN NOT NULL,
    sla_threshold_ms INTEGER,
    
    -- Cryptographic Proofs
    forensic_manifest JSONB NOT NULL,
    integrity_proof JSONB NOT NULL,
    data_payload_hash VARCHAR(64) NOT NULL,
    
    -- Hash Chaining (Tamper Evidence)
    previous_hash VARCHAR(64),
    block_hash VARCHAR(64) NOT NULL,
    
    -- Economics
    net_savings_uzs NUMERIC(18, 2),
    roi_multiplier NUMERIC(5, 2),
    
    -- Compliance
    cbu_article_14_compliant BOOLEAN NOT NULL DEFAULT FALSE,
    regulator_exported BOOLEAN NOT NULL DEFAULT FALSE,
    regulator_exported_at TIMESTAMPTZ,
    
    -- Raw Telemetry (for replay)
    ops_stream JSONB,
    audit_stream JSONB,
    economics JSONB,
    
    -- PII-Scrubbed Context
    scrubbed_data JSONB,
    forensics JSONB
);

-- ============================================
-- INDEXES for audit_ledger
-- ============================================
CREATE INDEX idx_audit_ledger_timestamp ON audit_ledger(timestamp);
CREATE INDEX idx_audit_ledger_decision ON audit_ledger(decision);
CREATE INDEX idx_audit_ledger_traceparent ON audit_ledger(traceparent);
CREATE INDEX idx_audit_ledger_cbu_compliance ON audit_ledger(cbu_article_14_compliant, regulator_exported);
CREATE INDEX idx_audit_ledger_hash_chain ON audit_ledger(previous_hash, block_hash);

-- ============================================
-- WORM ENFORCEMENT (Append-Only Trigger)
-- ============================================
CREATE OR REPLACE FUNCTION enforce_worm()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'AUDIT_LEDGER is WORM-compliant. Updates and deletes are prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_ledger_worm_update
    BEFORE UPDATE ON audit_ledger
    FOR EACH ROW
    EXECUTE FUNCTION enforce_worm();

CREATE TRIGGER audit_ledger_worm_delete
    BEFORE DELETE ON audit_ledger
    FOR EACH ROW
    EXECUTE FUNCTION enforce_worm();

-- ============================================
-- HASH CHAIN VERIFICATION FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION verify_hash_chain(
    p_start_id BIGINT DEFAULT NULL,
    p_end_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    trace_id VARCHAR(128),
    hash_valid BOOLEAN,
    computed_hash VARCHAR(64),
    stored_hash VARCHAR(64)
) AS $$
DECLARE
    rec RECORD;
    computed VARCHAR(64);
BEGIN
    FOR rec IN 
        SELECT * FROM audit_ledger 
        WHERE (p_start_id IS NULL OR id >= p_start_id)
          AND (p_end_id IS NULL OR id <= p_end_id)
        ORDER BY id
    LOOP
        computed := encode(
            digest(
                rec.trace_id || 
                rec.timestamp::text || 
                rec.decision || 
                COALESCE(rec.previous_hash, ''),
                'sha256'
            ),
            'hex'
        );
        
        RETURN QUERY SELECT 
            rec.id,
            rec.trace_id,
            computed = rec.block_hash,
            computed,
            rec.block_hash;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- CBU ARTICLE 14 EXPORT FUNCTION
-- ============================================
CREATE OR REPLACE FUNCTION export_cbu_article14(
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ
)
RETURNS XML AS $$
DECLARE
    result XML;
BEGIN
    SELECT XMLELEMENT(
        NAME "CBUReport",
        XMLATTRIBUTES(
            p_start_date AS "from",
            p_end_date AS "to",
            NOW() AS "generatedAt"
        ),
        XMLAGG(
            XMLELEMENT(
                NAME "Decision",
                XMLATTRIBUTES(
                    trace_id AS "traceId",
                    timestamp AS "timestamp",
                    decision AS "outcome"
                ),
                XMLELEMENT(NAME "Amount", XMLATTRIBUTES(currency), amount_uzs),
                XMLELEMENT(NAME "IntegrityProof", integrity_proof->>'manifest_hash'),
                XMLELEMENT(NAME "SLA", XMLATTRIBUTES(meets_sla), duration_ms)
            )
        )
    )
    INTO result
    FROM audit_ledger
    WHERE timestamp BETWEEN p_start_date AND p_end_date
      AND cbu_article_14_compliant = TRUE;
    
    -- Mark as exported
    UPDATE audit_ledger
    SET regulator_exported = TRUE, regulator_exported_at = NOW()
    WHERE timestamp BETWEEN p_start_date AND p_end_date
      AND cbu_article_14_compliant = TRUE
      AND regulator_exported = FALSE;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;
```

---

## 4. API REFERENCE

### 4.1 Endpoint: POST /webhook/v1/decision

**Base URL:** `https://api.revenant.tbcbank.uz`

#### Request Headers

| Header | Required | Description | Example |
|--------|----------|-------------|---------|
| `Content-Type` | Yes | Must be `application/json` | `application/json` |
| `X-Trace-ID` | No | W3C Trace Context (auto-generated if absent) | `00-abc123...-def456...-01` |
| `X-Auth-Signature` | Yes | HMAC-SHA256 of request body | `sha256=abc123...` |
| `X-Real-IP` | No | Client IP for rate limiting | `185.12.45.78` |
| `User-Agent` | No | Client identifier | `TBC-Mobile/3.2.1` |

#### Request Body Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["subject", "customer_email"],
  "properties": {
    "subject": {
      "type": "string",
      "maxLength": 200,
      "description": "Ticket subject line"
    },
    "body": {
      "type": "string",
      "maxLength": 2000,
      "description": "Detailed ticket content"
    },
    "customer_email": {
      "type": "string",
      "format": "email",
      "description": "Customer email address"
    },
    "amount": {
      "type": "number",
      "description": "Transaction amount (if applicable)"
    },
    "currency": {
      "type": "string",
      "enum": ["UZS", "USD", "EUR"],
      "default": "UZS"
    },
    "severity": {
      "type": "string",
      "enum": ["low", "medium", "high", "critical"],
      "default": "medium"
    },
    "trace_id": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_-]{1,64}$",
      "description": "Optional external trace ID"
    }
  }
}
```

#### Example Request

```bash
curl -X POST https://api.revenant.tbcbank.uz/webhook/v1/decision \
  -H "Content-Type: application/json" \
  -H "X-Auth-Signature: sha256=7d8c8c7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5" \
  -H "X-Real-IP: 185.12.45.78" \
  -d '{
    "subject": "Payment failed",
    "body": "My transfer of 500000 UZS did not complete",
    "customer_email": "customer@example.uz",
    "amount": 500000,
    "currency": "UZS",
    "severity": "high"
  }'
```

#### Response Codes

##### Success Codes (2xx)

| Code | Description | Scenario |
|------|-------------|----------|
| `200 OK` | Request queued successfully | Ticket accepted for processing |
| `202 Accepted` | Advisory dispatched | Response delivered to customer |

##### Client Error Codes (4xx)

| Code | Error Code | Description | Remediation |
|------|------------|-------------|-------------|
| `400` | `ERR_VALIDATION` | Invalid request schema | Check JSON structure against schema |
| `400` | `ERR_MISSING_FIELD` | Required field missing | Include `subject` and `customer_email` |
| `401` | `ERR_AUTH_INVALID` | HMAC signature mismatch | Regenerate signature with correct secret |
| `403` | `ERR_RATE_LIMIT` | Rate limit exceeded | Wait 60 seconds before retry |
| `403` | `ERR_POLICY_BLOCK_8_2` | **BLOCK 8.2 HARD REJECT** | Amount exceeds $50K hard ceiling |
| `403` | `ERR_MATH_INTEGRITY` | **NaN/Infinity detected** | Verify amount is a valid finite number |
| `403` | `ERR_UNSUPPORTED_CURRENCY` | Currency not in whitelist | Use UZS, USD, or EUR only |
| `413` | `ERR_PAYLOAD_TOO_LARGE` | Request body exceeds 10KB | Reduce payload size |

##### Server Error Codes (5xx)

| Code | Error Code | Description | Remediation |
|------|------------|-------------|-------------|
| `500` | `ERR_INTERNAL` | Unhandled exception | Contact DevOps, check logs |
| `502` | `ERR_SUPABASE_DOWN` | Database unavailable | System in fail-safe mode |
| `503` | `ERR_SERVICE_UNAVAILABLE` | n8n queue full | Retry with exponential backoff |
| `504` | `ERR_LLM_TIMEOUT` | OpenRouter timeout | Request queued for retry |

#### Block 8.2 Specific Error Codes

```json
{
  "ERR_POLICY_BLOCK_8_2": {
    "description": "Execution Policy Firewall hard rejection",
    "subcodes": {
      "EPF_HARD_LIMIT_BREACH": "Amount exceeds $50,000 USD hard ceiling",
      "EPF_UNSUPPORTED_CURRENCY": "Currency not in approved list (UZS/USD/EUR)",
      "EPF_MATH_ANOMALY": "Amount resulted in NaN or Infinity",
      "EPF_TOOL_NOT_WHITELISTED": "Requested tool not in allowed_tools list",
      "EPF_EXPIRED_CONTRACT": "Execution contract has expired",
      "EPF_IDENTITY_MISMATCH": "User identity changed since approval"
    }
  },
  "ERR_MATH_INTEGRITY": {
    "description": "JavaScript Number type violation",
    "details": "Input amount produced non-finite value (NaN, Infinity, -Infinity)",
    "security_flag": true
  }
}
```

#### Example Error Response

```json
{
  "status": "error",
  "error_code": "ERR_POLICY_BLOCK_8_2",
  "subcode": "EPF_HARD_LIMIT_BREACH",
  "message": "Transaction value $75,000.00 exceeds hard ceiling of $50,000.00",
  "trace_id": "gen-1770-abc123",
  "forensic_flag": true,
  "timestamp": "2026-02-12T10:23:45.123Z",
  "remediation": "Request human approval for amounts exceeding $50,000"
}
```

---

## 5. OPERATIONAL RUNBOOKS

### 5.1 Redis Lock Diagnostics

```bash
# Check distributed lock status
redis-cli -h redis -a $REDIS_PASSWORD <<EOF
EVAL "
    local locks = redis.call('KEYS', 'revenant:lock:*')
    for _, lock in ipairs(locks) do
        local ttl = redis.call('TTL', lock)
        local value = redis.call('GET', lock)
        print(lock .. ' => ' .. value .. ' (TTL: ' .. ttl .. ')')
    end
    return #locks
" 0
EOF

# Force-release a stuck lock (EMERGENCY ONLY)
redis-cli -h redis -a $REDIS_PASSWORD DEL "revenant:lock:approval_gen-1770"
```

### 5.2 Database Health Checks

```bash
# Verify hash chain integrity
psql -h postgres -U revenant_prod -d n8n -c "
    SELECT * FROM verify_hash_chain();
"

# Check for unexported CBU reports
psql -h postgres -U revenant_prod -d n8n -c "
    SELECT COUNT(*) as pending_exports
    FROM audit_ledger
    WHERE cbu_article_14_compliant = TRUE
      AND regulator_exported = FALSE
      AND timestamp < NOW() - INTERVAL '24 hours';
"
```

### 5.3 Emergency Procedures

```bash
# Trigger Kill-Switch (Level 4: SOVEREIGN HALT)
curl -X POST https://api.revenant.tbcbank.uz/admin/kill-switch \
  -H "Authorization: Bearer $EMERGENCY_TOKEN" \
  -d '{
    "level": 4,
    "reason": "Manual emergency halt",
    "authority": "DevOps-OnCall",
    "duration_minutes": 60
  }'

# Resume from SAFE MODE
curl -X POST https://api.revenant.tbcbank.uz/admin/resume \
  -H "Authorization: Bearer $EMERGENCY_TOKEN" \
  -d '{
    "verification_hash": "<multi-party-signature>",
    "integrity_check": true
  }'
```

---

**Document Version:** v26.5.0-PROD  
**Next Review:** 2026-03-12  
**Owner:** TBC Bank DevOps Team

---

*End of Green Book*
