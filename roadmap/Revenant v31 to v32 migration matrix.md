**Revenant v31 to v32 Migration Matrix**  
   
    
   
  **From n8n Visual Orchestration to a Pure Code-First Microservices Architecture**  
   
    
   
  ***A note on scope before you start reading:*** * this document is a different migration than the earlier "Node-to-VLAN" matrix. That one moved logic *  *within* * n8n, from one monolithic canvas into isolated n8n sub-workflows (VLANs/Trunks, still inside n8n). *  ***This document is the next step after that one*** * — it takes those same VLAN/*  *Tr*  *un* *k boundaries (which are now proven, working concepts) and rebuilds them as real, independently-deployable services with no n8n underneath them at all. If you've read the earlier document, the VLAN names will feel familiar; almost everything else about * * * *how they run* * * * changes here.*  
   
    
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OUQmAABBAsSfYxKJXxl5GEAOIFfwTYUuwZWa2ag8AgL841uquzq8nAAC8dj05XAYObl1xbgAAAABJRU5ErkJggg==)  
   
    
   
  **1. Executive Summary & Tech Stack Recommendations**  
   
    
   
  **Why move off n8n at all?**  
   
    
   
  n8n earned its place getting Revenant from zero to a working, secure, auditable banking automation engine — that's not a small thing, and the V31 VLAN/Trunk split inside it was genuinely good engineering. But three specific limits show up the moment a system like this needs to scale past a single team's prototype phase, and all three are visible in Revenant's own history:

1.  **Visual canvases don't catch the bugs type systems catch for free.** The $('Start') reference that broke the rate limiter, and the $node[] back-references that silently coupled non-adjacent nodes — both of those are bugs that simply *cannot exist* in a properly-typed codebase, because the compiler refuses to build code that references something undefined. n8n's expression language has no compiler standing between you and a typo.
2.  **n8n's "Wait for Webhook" pattern is a workaround, not a primitive.** It works, but it was built to make a tool designed for short request/response flows also handle multi-hour human-approval waits. There's a purpose-built technology for exactly this problem (durable execution), and using it directly removes an entire category of "did the wait node actually resume correctly" risk.
3.  **One canvas, one blast radius.** Even with VLAN isolation via Execute Workflow, every VLAN still ultimately runs inside the same n8n instance, sharing the same worker pool, the same outage risk, the same deploy cycle. Real independent scaling and independent deployment need real independent services.


**The Replacement, in One Sentence**  

**Temporal.io becomes the new "Trunk 4 Wait-node," done properly** — and everything else follows from designing around it.  

**Recommended Tech Stack**  


| | | |  

|-|-|-|  
 
| **Layer** | **Recommendation** | **Why** |  
| **Primary language** | **TypeScript / Node.js** | Your team already thinks in JavaScript from years of n8n Code nodes — this is the lowest-friction landing spot, and TypeScript adds the compile-time safety n8n's expression language never had. |  
 **Performance-critical pieces** |**Go** | Specifically for the API Gateway's hot path (rate limiting, routing) and the Core Banking execution worker, where raw throughput and predictable low latency matter more than developer convenience. |  
 **Durable execution / async callbacks** |**Temporal.io** | Replaces the Wait-node, the polling loop, and the "second Telegram trigger that never got built" problem all at once. Detailed below. |  

| Primary database |   PostgreSQL | Already proven in V31 for the dispatch lock and approval tables — keep it, just talk to it directly (via pgx/sqlc in Go or Prisma/raw pg in Node) instead of through Supabase's REST wrapper. |
| Cache & rate limiting |   Redis | Same tool, narrower job — once Temporal owns "waiting," Redis goes back to what it's best at: rate-limit counters and short-lived caching. |
| AI / LLM Engine | OpenAI (Azure) or Self-Hosted Open Weights (Llama 3 / Mistral) | Strictly prohibits routing Western-backed bank data through Chinese-hosted APIs (e.g., DeepSeek). Core conversational logic defaults to localized Microsoft Azure tenants or self-hosted GPU clusters on the bank's own perimeter for absolute data sovereignty. |
| Security & Compliance | SOC 2 Type II (In-Progress) | Official SOC 2 Type II audit readiness program initiated in July 2026. A non-negotiable prerequisite for Tier-1 bank procurement. |
| **Event/audit backbone** | **Kafka** | For the forensic/compliance event stream (SIEM, WORM storage, training-data pipeline) — built for durable, replayable, high-volume logs, which is exactly what a banking audit trail is. |  
| **Secrets** |**HashiCorp Vault** | Unchanged. It was already the right choice in V31; nothing about going code-first makes a different secrets manager better. |  
| **Schema validation** | **Zod** (TypeScript) | Replaces 9-condition n8n IF-chains with one declarative, testable schema. |  
| **Internal service-to-service calls** |

**How n8n's two hardest-to-replace ideas map onto the new stack**

-   **n8n's ** ** ** **Execute Workflow** ** ** ** node** → a synchronous   **gRPC call** between services for fast, deterministic logic, or a   **Temporal Workflow start** for anything with a wait in it.
-   **n8n's Webhook + "Wait for Webhook Call" resume pattern** → a   **Temporal Signal**. A Telegram bot handler, on receiving a button press, calls Temporal's signalWorkflow() against the specific suspended workflow (addressed by trace_id/contract_id). The workflow wakes up *instantly*, with zero polling, and — critically — there's no "second trigger node that someone forgot to build," because the signal delivery mechanism   *is* the trigger. This single change closes the exact gap that left Block 5.0/Block 5.2 dangling with no incoming connection in the n8n version.

```mermaid
graph TD  
Client((Customer / Telegram)) --> GW[API Gateway]  
 GW -->|gRPC, sync| FAQ[FAQ Service]  
GW -->|gRPC, sync| BillPay[Bill-Pay Service]  
GW -->|gRPC, starts workflow| P2P[P2P Service]  
GW -->|gRPC, starts workflow| Credit[Credit Service]  
GW -->|gRPC, starts workflow| Merchant[Merchant Service]  
P2P -->|Workflow| T1[(Temporal: P2P Worker)]  
Credit -->|Workflow| T2[(Temporal: Credit Worker)]  
 Merchant -->|Workflow| T3[(Temporal: Merchant Worker)]  
BillPay -->|Workflow| T4[(Temporal: Bill-Pay Worker)]  
TG((Telegram Button Press)) -->|Signal: CONFIRM_P2P| T1  
TG -->|Signal: SIGN_LOAN| T2  
T1 & T2 & T3 & T4 --> Shared[(Temporal: Shared HITL/Advisory Worker — Trunk 5a/5b)]  
Shared --> AI[AI Cognition Service]  
hared --> Compliance[Compliance/AML Service]  
Shared --> Ledger[Compliance Ledger Service]  
Ledger --> Kafka[(Kafka: audit topic)]  
Kafka --> SIEM[(Splunk)]  
Kafka --> WORM[(S3 Object Lock)]  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCkLfDqrYGNDAgAU2QtIq6DIzW7UHAMBfHGt1V+fXEwAAXrseHDgF/kf1C20AAAAASUVORK5CYII=)  
```

**2. API Gateway & Edge Routing**  
**Description**  
   
    
   
  The single front door for every request — webhook ingestion, identity/region checks, rate limiting, input sanitization, PII redaction, and the deterministic routing decision that used to live in n8n's Is P2P Transfer? node, now expanded into a real 5-way router.  
   
  **Current n8n Pain Points**

-   **One node, one point of failure.**Webhook Ingestion was the *only* entry point in the entire 158-node canvas — there was no way to scale ingress independently of everything downstream of it.
-   **The rate limiter's bug is a symptom of the tool, not just a typo.**$('Start') referencing a node that doesn't exist is a class of error a visual canvas makes easy to write and easy to miss — there's no compiler refusing to save the workflow.
-   **Validation-by-IF-chain doesn't scale.**Validate Input Fields1 alone carried 9 separate conditions in one node. Each new field needing validation meant editing a giant condition list by hand, with no reusable schema and no way to unit-test the validation logic in isolation from the rest of the canvas.
-   **PII redaction lived in an 8,180-character Code node.** The single largest node in the entire workflow — impossible to meaningfully code-review, version, or test as an isolated unit.
-   **Circuit-breaker logic was hand-rolled per node**, reading a Redis heartbeat key with no standard library backing the failure-detection logic.

   
  **Target Architecture**  
   
    
   
  A standalone **API Gateway service**, deployed and scaled independently of every domain service behind it:

-   **TLS termination + auth** at the edge.
-   **Schema validation** via a single Zod (or ajv/JSON Schema) definition per request type — one source of truth instead of a 9-condition IF chain.
-   **Rate limiting** via rate-limiter-flexible backed by the same Redis instance V31 already uses — same infrastructure investment, just driven by a maintained library instead of a hand-written INCR expression.
-   **PII redaction** as a dedicated, unit-tested middleware function (or its own tiny internal service if redaction logic grows complex enough to need independent scaling) — broken into named, testable functions instead of one giant Code node.
-   **Deterministic routing** implemented as actual TypeScript code — a switch statement or lookup table mapping intent → service — calling downstream services over gRPC.
-   **Regional failover** via standard infrastructure tooling (a load balancer health check + DNS failover, or a service mesh like Istio/Linkerd) instead of a Redis-key-reading Code node — this is a solved problem in cloud-native infrastructure and doesn't need custom logic at all.

   
  **Edge-Level Circuit Breaking & Regional Health (Former SYS_VLAN_0):** > In v31, regional health checks required a full n8n execution: an incoming webhook triggered a Redis lookup, followed by an evaluation node, taking ~100-300ms per request. In v32, this is moved directly into the Gateway middleware (Fastify/Go). The Gateway maintains a persistent connection to Redis (revenant:region:status). If a region trips, the Go/Fastify router rejects or reroutes traffic in under <5ms, completely eliminating the orchestrator overhead for critical health checks.  
   
  **Recommended Tools**

-   **Fastify** (Node.js/TypeScript) or   **Go + Chi/Gin** for the gateway runtime itself.
-   **Zod** for request schema validation.
-   **rate-limiter-flexible** + Redis for rate limiting.
-   **OpenTelemetry SDK** for distributed tracing — this single addition replaces the manual trace_id/W3C-traceparent stamping that used to be scattered across multiple n8n nodes (Trace Context Node, BLOCK 7.1, the Configuration Loader's defensive trace_id recovery). OpenTelemetry generates and propagates trace context automatically and correctly; an entire category of "did we lose the trace_id across this hop" node disappears.
-   **gRPC + Protocol Buffers** for all calls from the Gateway into domain services.

   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhYMECGpD4Mz7xgQU2QtIq6DIzR3UFAMBf3Gu1VefXEwAAXtsfSq4DWCYmzf4AAAAASUVORK5CYII=)  
   
  **3. Domain Microservices (VLANs 10–50)**  
   
    
   
  **3.1 VLAN 10 — P2P Service ***(High Risk)*  
   
  **Description:** Validates and executes phone-number-based peer-to-peer transfers, resolving the recipient via the Central Bank's Open API and handling the asynchronous "confirm before we send your money" customer interaction.  
   
  **Current n8n Pain Points:**

-   CBU TTT: Resolve Phone-to-Account ran with no intent gate in front of it for a period of the project's history — a real, previously-found bug where every ticket type, not just P2P transfers, could trigger an unrelated external API call.
-   The CONFIRM_P2P callback had nowhere to land — Block 5.2: P2P Execution Trigger was written to handle a Telegram button press, but no second trigger node existed anywhere in the canvas to actually deliver that press into a running execution.
-   Field-name mismatches between the validator's output and the idempotency guard's expected input were a real, found defect — exactly the kind of error that a typed language turns into a compile failure instead of a silent undefined at runtime.

   
  **Target Architecture:**

-   A **P2P Service** exposing a POST /transfers (or gRPC InitiateTransfer) endpoint. The synchronous part — deterministic phone/amount validation — runs as plain, unit-tested TypeScript functions (the same logic that lived in Block 3.5, now with a compiler checking its inputs).
-   On a valid request, the service **starts a Temporal Workflow**: P2PTransferWorkflow(traceId, phone, amount).
-   Inside the workflow:
    1.  resolveCbuPhoneToAccount Activity — calls the CBU Open API, with Temporal's built-in retry policy handling transient failures (no hand-rolled circuit breaker needed for this call).
    2.  sanitizeRecipientName Activity — the prompt-injection-stripping logic from Block 4.3, ported as-is; the sanitization rules don't need to change, only their container.
    3.  The workflow then calls await Workflow.condition(() => confirmed) — **this is the suspend point.** It costs nothing while waiting; there is no worker thread blocked, no execution slot held hostage.
    4.  The Telegram bot's webhook handler, on a button press, calls client.signalWorkflow(workflowId, 'confirmP2P', payload). The workflow wakes up immediately.
    5.  checkIdempotency Activity — the same Postgres unique-constraint pattern from Block 8.0.5, now operating against real, compiler-checked field names.
    6.  executeTransfer Activity — calls into the shared Core Banking client.

   
  **Asynchronous state handling:** Temporal's execution history *is* the durable state. If the worker process crashes mid-wait, a new worker picks up the workflow exactly where it left off — there is no separate "did the n8n Wait node actually persist correctly" question to ask, because Temporal's entire reason to exist is answering that question correctly by design.  
   
  **Recommended Tools:** Temporal TypeScript SDK, PostgreSQL, a typed internal CbuClient library, Zod schemas shared with the Gateway.  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBADPy8MD+NpGACyywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AL/CBEl9BWi3AAAAAElFTkSuQmCC)  
   
    
   
  **3.2 VLAN 20 — FAQ Service ***(Low Risk)*  
   
  **Description:** Handles general inquiries, balance questions, and anything that doesn't move money — routes straight to the AI Cognition service for an LLM-generated, RAG-grounded answer.  
   
  **Current n8n Pain Points:** Mostly architectural rather than functional — even a trivial FAQ ticket had to flow through the *entire* shared ingress and classification chain because n8n had no clean way to short-circuit early without restructuring the canvas.  
   
  **Target Architecture:** The simplest service in the whole system, deliberately. A thin handler that receives the already-classified intent from the Gateway, calls the shared   **AI Cognition Service** synchronously over gRPC, and returns the formatted response.   **No Temporal workflow needed here at all** — there's no human-approval wait, so a workflow engine would be pure overhead. This is a good candidate to migrate *first*: low risk, fast to prove the new Gateway and service-to-service plumbing actually work end-to-end before touching anything that moves money.  
   
  **Recommended Tools:** Plain Node.js/TypeScript or Go service, gRPC client to the AI Cognition Service. No database of its own required.  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCkJfD6ZYGBDBgAU2QtIq6DIzW7UHAMBfHGt1V+fXEwAAXrseHD4F+xxq2PcAAAAASUVORK5CYII=)  
   
    
   
  **3.3 VLAN 30 — Bill-Pay Service ***(Low Risk)*  
   
  **Description:** Aggregates utility, tax, and mobile top-up payments across multiple external providers behind one conversational interface.  
   
  **Current n8n Pain Points:**

-   Provider credentials (auth_secret values for UZBEKENERGO/YHXBB_FINES) were hardcoded directly inside a Code node — a real security smell already flagged independently of this migration.
-   The provider registry itself was a hand-maintained JavaScript object inside that same Code node, meaning adding a new provider (TAX_INN, MOBILE_TOPUP) meant editing and redeploying workflow logic rather than adding a row of configuration.

   
  **Target Architecture:** A   **Provider Registry** becomes real configuration data — rows in a Postgres table (provider_code, endpoint, auth_method, field_mapping_schema), not code. The service logic becomes generic: look up the provider by code, build the request from the stored mapping, execute via a typed HTTP client. Each provider call runs as its own Temporal Activity with a *per-provider* retry policy and timeout — utility-provider APIs are exactly the flaky, slow, third-party dependency that benefits most from durable, automatic retry instead of hand-written retry loops.  
   
  **Asynchronous state handling:** No human-approval wait here, but Temporal is still worth using for the provider call itself, purely for its retry/timeout guarantees against unreliable third-party APIs — this is "durable execution as a better HTTP client," not "durable execution for human waits."  
   
  **Recommended Tools:** Temporal (for the provider-call Activity, not for any human wait), PostgreSQL-backed provider registry, HashiCorp Vault for the actual secrets (unchanged from V31 — it was already correct).  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAOUlEQVR4nO3OQQmAQAAAwRVMY8rLYSMzXAI/RhAr+BNhJsEsY4ytOgIA4A/uaq7VVe0fZwAAeO98ACTMBsM5vAJyAAAAAElFTkSuQmCC)  
   
    
   
  **3.4 VLAN 40 — Credit Service ***(Critical Risk)*  
   
  **Description:** Runs loan-origination eligibility scoring, the auto-approve/auto-reject/human-review decision, e-signature issuance, and disbursement.  
   
  **Current n8n Pain Points:**

-   An earlier audit pass found REQUIRES_HITL decisions being silently dropped by Block 4.7 — no e-signature, no routing to human review, just a no-op. This is precisely the kind of defect that's most expensive in a credit product, and most likely to recur in *any* system, code-first or not, if the "what happens to every possible decision outcome" question isn't asked explicitly during the rebuild.
-   The SIGN_LOAN callback had the identical "nowhere to land" problem as CONFIRM_P2P.
-   The e-signature token used a hand-rolled FNV-1a hash and manual Base64 encoding — not because that's good cryptographic practice, but specifically because the n8n Code node sandbox made the standard crypto module unreliable to use for this particular node. That constraint doesn't exist in a real Node.js service.

   
  **Target Architecture:** The same Temporal pattern as P2P, with three credit-specific points worth calling out:

1.  **CreditDecisionWorkflow** is structured so all three outcomes (AUTO_APPROVE / AUTO_REJECT / REQUIRES_HITL) are exhaustively handled in the workflow's own control flow — in TypeScript, this is naturally enforced by making the decision a discriminated union type the compiler can check for exhaustiveness, making the old "silent drop" bug structurally much harder to write.
2.  **Real signed tokens.** Replace the FNV-1a/Base64 scheme with a properly signed JWT via the jose library — there's no sandbox restriction stopping you now, so there's no reason to keep the workaround.
3.  **Re-validation on signal reuses the same Activity.** When the signLoan signal arrives, the workflow calls the *exact same*checkEligibility Activity it called earlier — not a copy of the logic, the same function — guaranteeing the live re-check can never silently drift out of sync with the original check. This is a direct, structural answer to the "re-run eligibility fresh, don't trust the stale token" rule from the earlier n8n-era roadmap.
4.  **Disbursement gets its own conservative retry policy.** Unlike most Activities, the final disbursement call should use maximumAttempts: 1–2, not Temporal's more liberal defaults — a financial disbursement should never auto-retry blindly; a failed attempt should escalate to manual reconciliation, not silently retry into a possible double-disbursement.

   
  **Recommended Tools:** Temporal, PostgreSQL, jose for JWT-based e-signature tokens, exhaustive unit tests on the decision-engine function specifically (100% branch coverage is a reasonable bar here given what it gates).  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSNBADPaEML4NpGACyywEZJWQZeZ2aszAAD+4l6rrTq+ngAA8Nr1AL/aBEY05P6JAAAAAElFTkSuQmCC)  
   
    
   
  **3.5 VLAN 50 — Merchant Service ***(Moderate Risk)*  
   
  **Description:** Handles merchant checkout — verifying the merchant, generating a payment QR code, and firing a signed webhook to the merchant's point-of-sale terminal.  
   
  **Current n8n Pain Points:**

-   QR code generation depended on a third-party public API (api.qrserver.com) — an external dependency and outbound network call for something that doesn't need to leave your own infrastructure.
-   The merchant registry existed as **two independently hand-maintained copies** inside two different Code nodes, a known drift risk flagged in the earlier audit.

   
  **Target Architecture:**

-   **Self-hosted QR generation** using the qrcode npm package — QR codes are generated locally, in-process, with no external API call and no third-party outage risk at all. This is a clean, concrete improvement with no real tradeoff.
-   **One Merchant Registry**, period — a single Postgres table (or a small internal Merchant Registry Service if other domains end up needing merchant data too), eliminating the duplicate-copy problem structurally rather than by discipline.
-   POS webhook signing uses Node's native crypto.createHmac directly — same as the Credit Service's token fix, the sandbox constraint that justified a workaround in n8n simply isn't present here.

   
  **Recommended Tools:** qrcode (npm), PostgreSQL merchant registry, native crypto for webhook signing, Temporal for the POS webhook-fire Activity (same "durable execution as a better HTTP client" rationale as Bill-Pay).  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AUBBAsUfyNTAj9UygEA3sWGAjJK2CbjNzVGcAAPzFtapV7V9PAAB47X4AEXYELcG8+qIAAAAASUVORK5CYII=)  
   
    
   
     
 **3.6 VLAN 60 (F5) — Proactive Nudge & Engagement Service (Batch AI)**  
 **Description:** A daily outbound engagement engine that evaluates customer balances, loan histories, and idle cash to send personalized, LLM-generated Telegram nudges with interactive inline keyboards.   **Current n8n Pain Points:**

-   **Memory Limits (OOM):** n8n processes array loops in memory. Hydrating thousands of customer records and running them through a sequential LangChain node will inevitably cause worker crashes at scale.
-   **Rate Limiting:** Looping through OpenAI API calls without a robust queuing system will result in 429 Too Many Requests errors, dropping nudges silently.
-   **Code Complexity:** The mock DB hydrator and Consent/Frequency gate are complex JavaScript nodes that cannot be easily unit-tested for edge cases.

   
  **Target Architecture:**

-   **Temporal Cron Workflow:** A Temporal workflow runs at 09:00, queries the Postgres users table, and pushes eligible customer IDs to a message broker (RabbitMQ or Kafka) or spawns Temporal Child Workflows.
-   **Distributed Workers:** A pool of scalable Node.js/Go workers consume these tasks, check the user_preferences table for the 72-hour frequency cap, and execute the LLM call.
-   **Batching & Throttling:** Temporal or the message queue natively handles API rate limits to OpenAI, pausing and retrying if a 429 error occurs, ensuring zero dropped messages.

   
  **Recommended Tools:** Temporal Cron Workflows, RabbitMQ/Kafka (for fan-out message distribution), LangChain.js (in standard Node.js), Postgres.  
   
  ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSPBCzbfFB4QwYwEZiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AMTRBeKSdeM4AAAAAElFTkSuQmCC)  
   
    
   
 | | | | |  
   
 |-|-|-|-|  
   
 | **Feature ID & Name** | **Current v31 Architecture (n8n-Centric)** | **Target v32 Architecture (Microservices/Temporal)** | **Infrastructure & Breaking Changes** |  
   
 | **F6: Full Speech-to-Speech IVR Replacement** | Stateless webhook triggered by external telephony provider; limited to constant-time liveness/biometric checks. No conversational loop. | Streaming Media Gateway (SIP/RTP) routed to a dedicated Voice Orchestration service. Direct asynchronous pipeline: ASR (Uzbek/Russian) → LLM Engine → TTS Engine. | Requires a high-throughput streaming server (e.g., FreeSWITCH or Asterisk) acting as an edge node to stream raw audio directly to the processing pipeline with sub-100ms latency. |  
   
 | **F7: Unified Voice Biometric Identity** | Isolated n8n binary data processing checking for replay attacks on a single database record. | Centralized Identity Provider (IdP) service exposed via gRPC. Real-time voice embedding extraction and comparison via Vector Database (pgvector). | Radical database refactor: voiceprints must be decoupled from local bank schemas and exposed via a secure, cross-channel authentication token system. |  
   
 | **F8: Document & Image Understanding** | Image paths or raw base64 strings passed via generic Telegram webhooks, failing on large attachments or causing n8n timeouts. | Asynchronous Object Storage (S3/MinIO) upload gateway. Webhook generates an ephemeral pre-signed URL passed to a Vision-LLM worker pool. | Implementation of strict payload size filtering at the API Gateway level to block malicious, massive multi-megabyte image uploads. |  
   
 | **F9: Two-Way Messaging Bot (WhatsApp/Telegram)** | One-way outbound HTTP notification dispatch node with zero conversational inbound state management. | Stateful Chat Gateway backed by a Redis session manager and Temporal conversational state machines to handle inbound routing, quick-replies, and callbacks. | Migration from static outbound payload builders to a dynamic, bidirectional webhook receiver capable of processing inline keyboard payloads. |  
 ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OMQ2AABAAsSPBCzbfFB4QwYwEZiywEZJWQZeZ2ao9AAD+4lyruzq+ngAA8Nr1AMTRBeKSdeM4AAAAAElFTkSuQmCC)  
 **4. Execution Workers (Trunks 1–5)**  
   
    
   
  A quick translation note: in the n8n-era documents, "Trunk" meant a *cross-cutting functional layer* (Compliance, AI, Forensics, Approval, Banking) shared by every VLAN. In the code-first world, that job splits into two different things — **shared internal services** (for cross-cutting logic like AI Cognition and Compliance screening) and   **domain-dedicated Temporal Worker pools** (for the actual durable execution of each VLAN's workflows). This section uses "Trunk" the way you defined it for this document:   **each domain's dedicated background worker.**  
   
    
   
  A **Temporal Worker** is a long-running process that polls a specific   **Task Queue** for work and executes Workflow/Activity code. This maps almost exactly onto the old idea of an isolated n8n sub-workflow — except it's a real, independently-deployable, independently-scalable process, not a node group on a shared canvas.  
   
    
   
  | | | | |  
   
    
   
  |-|-|-|-|  
   
    
   
  | **Trunk** |  **Domain** |  **Task Queue** |  **What runs here** |  
   
    
   
  | **Trunk 1** | P2P Execution | p2p-queue | P2PTransferWorkflow and its Activities (CBU resolution, sanitization, idempotency check, ledger execution). |  
   
    
   
  | **Trunk 2** | Credit Execution | credit-queue | CreditDecisionWorkflow and its Activities (eligibility, decisioning, signature, disbursement). |  
   
    
   
  | **Trunk 3** | Merchant Execution | merchant-queue | Merchant verification, QR generation, POS webhook-fire workflows. |  
   
    
   
  | **Trunk 4** | Bill-Pay Execution | billpay-queue | Provider-lookup-and-execute workflows for each registered utility/tax/top-up provider. |  
   
    
   
  | **Trunk 5a/5b** | HITL & Advisory/Fallback Execution | platform-queue | The  **shared** Activities every domain workflow calls into: AI Cognition (LLM consensus + RAG), Compliance/AML screening, and Forensic signing/audit-event emission. |  
   
    
   
     
   
  **Why Trunk 5a/5b is deliberately shared, not duplicated per domain:** LLM calls specifically benefit from centralized rate-limiting and circuit-breaking — you don't want four independent worker pools each hammering OpenRouter with their own uncoordinated retry logic. Putting the AI Cognition Activity on one shared platform-queue, backed by one shared circuit breaker, means a vendor-side outage degrades predictably *once*, system-wide, instead of four times independently and inconsistently. Lightweight, fast helper logic (basic field validators, formatting utilities) doesn't need this — that can simply be a shared npm package each domain worker imports directly, with no network hop at all.  
   
  **Circuit breakers, simplified:** for any external call wrapped as a Temporal Activity, you largely don't need a *separate* circuit-breaker library — Activity options (startToCloseTimeout, retryPolicy.maximumAttempts, backoff coefficients, and heartbeating for long-running calls) already cover most of what a circuit breaker provides. Reserve a dedicated library (opossum for Node, gobreaker for Go) specifically for calls made   *outside* a Temporal workflow context — for example, a synchronous Gateway-to-Service call that isn't itself part of a durable workflow.       
### 4.1 Hybrid BYOC (Bring Your Own Cloud) & Security Framework  
Tier-1 banks will not expose core financial ledgers to a shared multi-tenant database. Therefore, REVENANT v32 adopts a Hybrid Deployment Model: **The Edge is SaaS (Shared), and the Core is BYOC (Isolated).**

[v31 Monolith] -> Hardcoded DB / Single Vault Namespace  
                                   │  
                                   ▼  
[v32 Hybrid BYOC Architecture] 
  ├── SaaS Edge (VLAN 20/30): Multi-Tenant Router identifies X-Tenant-ID for stateless FAQ/Bill-Pay routing.
  └── BYOC Core (VLAN 10/40): Terraform/Helm deployed directly into the Bank's private AWS/GCP/On-Prem perimeter. 
   
- Hybrid Infrastructure Isolation (F10):  
  - v31 Mechanics: Globally defined environmental variables hardcoded to one bank's credentials.  
  - v32 Migration: Low-risk services (AI Cognition, FAQ) run on REVENANT's multi-tenant SaaS edge. High-risk services (P2P, Credit Origination) are packaged as isolated Temporal microservices deployed directly onto the bank's own cloud infrastructure. We manage it remotely; the bank owns the data perimeter, instantly bypassing CBU data localization hurdles.
- Bank-Grade Cryptographic Fraud Intelligence Network (F11):  
  - v31 Mechanics: Fraud signals (malicious voice prints, device IDs) are completely isolated within a single client's instance.  
  - v32 Migration: A global, decentralized intelligence cluster. Instead of vulnerable public hashing, identity tokens utilize **Keyed HMACs (Hash-based Message Authentication Codes) with centrally rotated cryptographic salts**, or **Zero-Knowledge Proofs (ZKPs)**. When a fraud vector is flagged, the salted token is written to the global pool, triggering real-time edge caching without exposing reversible PII.
-   ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OQQmAABRAsSdYxpY/jzGMYQKPRrCCNxG2BFtmZquOAAD4i3Ot7mr/egIAwGvXA3dBBc3fHxprAAAAAElFTkSuQmCC)

   
  **5. Phased Migration Plan (Strangler Fig Strategy)**  
   
    
   
  The goal of a Strangler Fig migration is exactly what the name describes: the new system grows up *around* the old one, taking over one branch at a time, until the old system can be removed with nothing left depending on it. At every phase, n8n keeps running — you are never choosing between "the old system" and "the new system" being live; you're choosing, piece by piece, which requests go to which one.  
   
    
   
  graph LR  
   
    
   
       P1[Phase 1: Shadow Mode] --> P2[Phase 2: Cut Over Low-Risk VLANs]  
   
    
   
       P2 --> P3[Phase 3: Cut Over High-Risk VLANs]  
   
    
   
       P3 --> P4[Phase 4: Decommission n8n]  
   
    
   
     
   
 **Central Bank of Uzbekistan (CBU) Open API Rail (Pillar 1 / F1 / F2):**

-   *Technical Strategy:* Create a decoupled "Banking Integration Layer" utilizing a standard Adapter Pattern. Write mock providers matching the draft CBU specifications so that core business workflows remain unaffected when production API keys are granted.
-   **Stablecoin Settlement Pilot (F14):**
-   *Technical Strategy:* Keep this architecture completely segregated within a dedicated sandbox sub-workflow container. The conversational ledger engine should handle this as an external settlement rail, ensuring zero contamination of the main fiat transaction processors.

   
**## 6. Platform Operations & SRE (DevSecOps)**  
   
    
   
  The v31 architecture utilized n8n's Schedule Trigger (CRON) to handle infrastructure synchronization and load testing. In v32, these operational tasks are removed from the application layer entirely and delegated to native cloud infrastructure and container orchestration tools.  
   
  **### 6.1 Regional WORM Audit Sync (Disaster Recovery)**  
   
  **Description:** A cross-region synchronization process that ensures all forensic compliance logs in revenant-worm-audit-region-a are replicated to a fallback region (region-b), followed by a success alert to the Splunk SOC.  
   
    
   
     
   
  **Current n8n Pain Points:**  
   
    
   
  *   **Polling Overhead:** Running an S3 List, filtering deltas via JavaScript, downloading, and re-uploading every 30 seconds wastes compute cycles and incurs unnecessary AWS bandwidth/API costs. It reinvents a wheel that cloud providers already offer natively.  
   
    
   
  *   **Scale Limits:** If a massive spike in transactions occurs, downloading and uploading thousands of files through an n8n Code node memory buffer will crash the worker (OOM errors).  
   
    
   
     
   
  **Target Architecture:**  
   
    
   
  *   **Native S3 Cross-Region Replication (CRR):** Drop the code entirely. Configure AWS S3 CRR directly on the revenant-worm-audit-region-a bucket. AWS will automatically, asynchronously, and securely replicate objects to region-b at the storage layer with zero compute overhead.  
   
    
   
  *   **Event-Driven Logging:** To maintain the Splunk SOC alerts, configure AWS EventBridge (or S3 Event Notifications) to listen for s3:Replication:OperationCompleted events, which triggers a lightweight AWS Lambda function to format the DR_SYNC_SUCCESS JSON and push it to the Splunk HEC.  
   
    
   
     
   
  **Recommended Tools:** AWS S3 CRR, AWS EventBridge, AWS Lambda (Node.js/Go) for Splunk formatting, Terraform/OpenTofu (to manage the infrastructure as code).  
   
    
   
     
   
  **---**  
   
    
   
     
   
  **### 6.2 k6 Chaos Engineering Engine**  
   
  **Description:** A nightly cron job (02:00 AM) that triggers a 5000 TPS load test against the API Gateway via k6 Cloud, then notifies the Splunk SOC (CHAOS_ENGINEERING_START) so the security team knows the traffic spike is a drill, not a DDoS attack.  
   
    
   
     
   
  **Current n8n Pain Points:**  
   
    
   
  *   **Orchestrator Misuse:** n8n is an integration orchestrator, not a CI/CD pipeline or a task scheduler. Keeping test automation inside the application workflow tool mixes production logic with QA logic.  
   
    
   
     
   
  **Target Architecture:**  
   
    
   
  *   **Containerized Cron / CI Pipeline:** The load test trigger belongs in the CI/CD pipeline or the Kubernetes cluster where the code lives.  
   
    
   
  *   **Execution:** A scheduled Kubernetes CronJob runs a lightweight container every night at 02:00. This container executes a simple bash/Go script to trigger the k6 API and send the CHAOS_ENGINEERING_START payload to Splunk. Alternatively, this runs as a GitHub Actions / GitLab CI scheduled workflow.  
   
    
   
     
   
  **Recommended Tools:** Kubernetes CronJob or GitLab CI/GitHub Actions scheduled pipelines, k6 Cloud API, Bash/curl or lightweight Go script for the Splunk webhook.  
   
    
   
     
 **6.3 MLOps & Model Drift Monitoring (Batch Jobs)**  
 **Description:** A midnight cron job that fetches the last 24 hours of LLM/embedding inferences from the bank_audit_logs table, calculates Population Stability Index (PSI) and Wasserstein distance, and alerts the SOC/MLOps team via Slack if model drift is detected.   **Current n8n Pain Points:**

-   **Wrong Ecosystem:** JavaScript/n8n is fundamentally the wrong tool for matrix math, vector calculations, and data science. True drift calculation requires statistical libraries that JS lacks.
-   **Data Volume:** Pulling 24 hours of high-dimensional vector embeddings into an n8n memory buffer is a massive performance bottleneck.

   
  **Target Architecture:**

-   **Python-Native Execution:** The entire job is ported to Python, which is the industry standard for ML.
-   **Kubernetes CronJob:** A K8s CronJob spins up a lightweight Python container at midnight.
-   **Data Science Libraries:** The script connects directly to Postgres, uses pandas and evidently (or scipy) to calculate mathematically accurate PSI/Wasserstein drift on the vectors, sends the Slack payload, and spins down.

   
  **Recommended Tools:** Kubernetes CronJob or Apache Airflow, Python 3.11+, Pandas, Evidently AI (for drift detection), Slack API.  
   
    
   
     
   
**Phase 1 — SQB "Shadow Mode" & Gateway Finalization (July/August 2026)** **Target:** SQB (Uzpromstroybank) — Currently running a highly visible "toy" demo FAQ bot.
Put the new API Gateway (VLAN 0) in front of n8n. We will run a "Shadow Mode" pilot directly comparing REVENANT's output against SQB's existing demo bot to prove our AI's superiority without touching their real core money. Concurrently, package the Temporal workers into deployable Helm charts for the BYOC model and officially kick off the SOC 2 Type II audit readiness program.

**Phase 2 — Cut Over the Low-Risk Domains First (August 2026)** Once the SQB shadow-mode comparison is mathematically proven, start sending a small percentage of real traffic (1-5%) to the new SaaS edge services (FAQ/Bill-Pay) instead of n8n. Watch error rates and latency closely. n8n continues handling P2P, Credit, and Merchant traffic entirely during this phase.

**Phase 3 — The "Do-or-Die" Voice-IVR Deadline (September/October 2026)** **Target:** MikroKreditBank (via IFC/ADB Technical Assistance Grants).
The Voice-IVR Speech-to-Speech loop **must** be feature-complete and demo-ready by September 2026. If we miss this window, we miss the enterprise budget lock-in for 2027. We will deploy a live Voice-IVR pilot targeting rural microfinance, funded entirely by Asian Development Bank (ADB) or IFC grants, allowing us to build a massive case study without asking the margin-strapped bank for SaaS fees. 

**Phase 4 — Commercial Contract & Decommissioning (November 2026)** Sign the first commercial Hybrid BYOC contract with SQB before their 2027 budgets freeze. Once all VLANs are running 100% on the new services, run one full audit/reconciliation cycle comparing old-path and new-path outcomes. Archive the final n8n workflow JSON export as a historical record rather than deleting it outright, and remove the Gateway's "forward to n8n" code path.
   
    
   
  Once shadow-mode comparison looks clean for FAQ and Bill-Pay, start sending a *small percentage* of real traffic to the new services instead of n8n — 1–5% to start, using a simple feature-flag or percentage-based router in the Gateway. Watch error rates and latency closely; ramp upward over days, not hours. n8n continues handling P2P, Credit, and Merchant traffic entirely during this phase — nothing about the riskiest flows changes yet.  
   
  **Phase 3.1 — Cut Over the High-Risk Domains, Carefully**  
   
    
   
  For P2P, Credit, and Merchant — the three VLANs with asynchronous Telegram-callback approvals — repeat Phase 1's shadow-mode approach first, but this time specifically to validate the *riskiest behavioral change in the whole migration*: that a real Telegram button press correctly delivers a Temporal Signal and wakes the right suspended workflow. Deliberately test the edge cases the earlier roadmap called out — a stale token past its TTL must still be rejected even with a valid signature, and a double-tap on the same button must collapse to one execution, not two. Only once that's been validated against real-world callback patterns for a couple of weeks should the percentage-ramp cutover from Phase 2 begin here — with P2P and Merchant going first, and Credit, the highest-stakes domain, cut over last and most conservatively.  
   
  **Phase 4.1 — Decommission n8n**  
   
    
   
  Once all five VLANs are running 100% on the new services, run one full audit/reconciliation cycle comparing old-path and new-path outcomes against the forensic/compliance ledger — the same standard the earlier n8n-internal migration document set (a full month of parallel-run reconciliation) applies here too, for consistency. Only after that reconciliation evidence is clean should the n8n instance actually be turned off. Archive the final workflow JSON export as a historical record rather than deleting it outright, and remove the Gateway's "forward to n8n" code path as the very last cleanup step — that's the moment the migration is actually finished, not before.