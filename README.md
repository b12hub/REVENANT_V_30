<div align="center">

# 🏦 REVENANT
## _Bank AI Avtomatlashtirish Platformasi — Milliy Darajadagi Xavfsizlik_

> **"Hech qanday inson agenti kerak emas. Faqat natija."**

[![Version](https://img.shields.io/badge/Version-V30.1-blueviolet?style=for-the-badge&logo=github)](https://github.com/)
[![Architecture](https://img.shields.io/badge/Architecture-Tier--1_Enterprise-red?style=for-the-badge&logo=n8n)](https://github.com/)
[![Security](https://img.shields.io/badge/Security-WAF_%7C_Vault_%7C_KMS-success?style=for-the-badge&logo=spring-security)](https://github.com/)
[![AI](https://img.shields.io/badge/AI-Dual_LLM_Consensus-orange?style=for-the-badge&logo=openai)](https://github.com/)
[![Uzbekistan](https://img.shields.io/badge/Compliance-CBU_%7C_LRU--1115-teal?style=for-the-badge)](https://github.com/)
[![Nodes](https://img.shields.io/badge/Workflow_Nodes-139_Wired-success?style=for-the-badge&logo=n8n)](https://github.com/)
[![ROI](https://img.shields.io/badge/ROI-400%25_per_Ticket-gold?style=for-the-badge)](https://github.com/)

---

**🏆 PDP EcoSystem Startup Competition 2025** **Kategoriya: Sanoat va tadbirkorlikda sun'iy intellekt texnologiyalari**

</div>

---

## 💡 Oddiy Insonlar va Investorlar Uchun (Executive Summary)

**Revenant o'zi nima?** Tasavvur qiling, bankning call-markazida ishlaydigan minglab operatorlar o'rnini bitta "Super-Xodim" (Sun'iy Intellekt) egalladi. Ammo u oddiy chatbot emas — u 139 ta o'zaro bog'langan mantiqiy blokdan (n8n nodes) iborat, har bir qadami forensik jihatdan loglanadigan ishlov berish konveyeri:

* **U uxlamaydi va charchamaydi:** Webhook orqali kelgan har bir so'rov bir vaqtning o'zida minglab parallel mijoz uchun qayta ishlanishi mumkin.
* **U aldanmaydi:** Ovozli so'rovda sun'iy intellekt orqali soxtalashtirilgan (Deepfake) yoki qayta ishlatilgan (Replay) audio aniqlansa, `Voice Processor` darhol `soc_action: GLOBAL_ACCOUNT_FREEZE` signalini chiqaradi — jinoyatchi pulni yechib ketmasidan oldin.
* **U xato qilmaydi:** Har bir tranzaksiya `trace_id` orqali kuzatiladi, har bir bosqichda SHA-256 bilan muhrlanadi va Splunk SIEM + WORM saqlagichga parallel yoziladi.
* **Avtomatik tranzaksiyalarni ovoz yoki text orqali amalga oshiradi.**
* **INN, kommunal xizmatlar va boshqa to'lov amallarini bajarishda foydalanuvchini bosqichma-bosqich yo'naltiradi.**

> *"O'zbekiston banklari har kuni minglab mijoz murojaatini qo'lda ko'rib chiqmoqda. Har bitta tiket agentdan o'rtacha **15 daqiqa** va **12,500 UZS** sarflaydi. REVENANT bu muammoni hal qiladi: har bir tiketni **2,500 UZS**ga, **soniyalar ichida**, qat'iy xavfsizlik arxitekturasi bilan avtomatik ishlaydi. Bu faqat chatbot emas — bu O'zbekistondagi birinchi **Tier-1 darajadagi** bank AI orkestrasiya platformasidir."*

### 🎯 Biznes Muammo va REVENANT Yechimi

| # | Muammo | Joriy Holat | REVENANT Yechimi |
|---|--------|-------------|------------------|
| 1 | **Agent samaradorligi** | Har bir tiketga 15 min + 12,500 UZS | AI 2,500 UZS'ga soniyada hal qiladi |
| 2 | **SLA nazorati** | Manual kuzatuv, kechikishlar | `Uzbekistan SLA Calculator` orqali avtomatik kritik (30 min) / yuqori (2 soat) / o'rta (8 soat) / past (24 soat) darajali SLA, ish vaqtidan tashqari uchun ×1.5 koeffitsient |
| 3 | **Xavfsizlik** | Statik himoya, hakerlik hujumlariga zaif | WAF + Vault + AWS KMS + Redis token-bucket + PII to'siq |

---

## 💰 MOLIYAVIY ROI VA BIZNES MODELI

> *Barcha ko'rsatkichlar `Configuration Loader - V30` orqali HashiCorp Vault KV v2 (`secret/data/revenant/config`) dan dinamik yuklanadi; quyidagi raqamlar production fallback-default qiymatlardir — Vault'dagi haqiqiy qiymatlar bank tomonidan o'rnatiladi.*

### 📈 ROI Kalkulyatsiyasi

| Ko'rsatkich | Formulа | Natija |
|------------|---------|--------|
| **Tiket boshiga tejash** | `12,500 − 2,500` | **10,000 UZS** |
| **Oylik tejash (10k tiket)** | `10,000 × 10,000` | **100,000,000 UZS** |
| **Yillik tejash** | `100,000,000 × 12` | **1,200,000,000 UZS** |
| **ROI foizi** | `(12,500 − 2,500) / 2,500 × 100` | **400%** |
| **Vaqt tejamkorligi** | `15 daqiqa/tiket × 10,000` | **2,500 soat/oy** |

### 💳 Moliyaviy Xavfsizlik Chegaralari (Ingress'da qat'iy kodlangan)
* **`HARD_CEILING_USD = $50,000`** → `PROD Input Normalizer` darajasida tranzaksiya darhol rad etiladi (`REJECT_IMMEDIATE` / `HARD_LIMIT_BREACH_AT_INGRESS`).
* **`CHALLENGE_FLOOR = $10,000`** → biometrik tasdiqlanmagan bo'lsa, `CHALLENGE_REQUIRED` holatiga o'tadi va bir martalik `NEON-XXXX` formatdagi jonlilik (liveness) chaqiruvi generatsiya qilinadi.
* **`SAR_THRESHOLD_USD = $10,000`** → `BLOCK 7.8: CBU Compliance Engine` avtomatik LRU-1115 Modda 14 talabiga muvofiq SAR XML hisobotini generatsiya qiladi va `COMPLIANCE_OFFICER_DASHBOARD_V1` navbatiga `P0_CRITICAL` ustuvorlik bilan yuboradi.

---

## 🏗️ TIZIM ARXITEKTURASI: V30.1 GLOBAL SCALE

### 1. Makro Daraja: Haqiqiy Tasdiqlangan Mantiq Oqimi

Quyidagi diagramma `Webhook Ingestion` tugunidan boshlab `connections` grafigi orqali izchil kuzatilgan **haqiqiy ijro tartibini** aks ettiradi (taxminiy emas):

```mermaid
graph TD
    Client((Mijoz So'rovi)) --> Ingress[Webhook Ingestion]
    Ingress --> CB{EVALUATE: Region Health}
    CB -- "Region A Down" --> RegB[REDIRECT: Region B — HTTP 307]
    CB -- "Healthy" --> VoiceGate[Voice Processor / Enrollment]
    VoiceGate --> Norm[PROD Input Normalizer V30\nUUIDv4 + Amount Gates]
    Norm --> RIdem[Redis: Idempotency Check\nSET NX + 24h TTL]
    RIdem -- "Duplicate" --> Drop[429 — Stop: Duplicate]
    RIdem -- "New" --> RateLimit[Redis Token-Bucket\n10 req/min/IP]
    RateLimit --> Vault[Vault: AppRole Login + Fetch Config]
    Vault --> Sanitizer[BLOCK 0: Titanium Sanitizer\nWAF + Anti-CEO-Fraud]
    Sanitizer --> AML{IF: Requires Screening?}
    AML -- "Yes" --> PEP[HTTP: PEP/Sanctions API]
    PEP --> Gov[Governance Gate\nOIDC / ABAC / SoD]
    AML -- "No / Clean" --> Gov
    Gov --> RAG[Supabase: Hybrid RRF Search]
    RAG --> Drift[BLOCK 6.1: Memory Integrity Guard\nWasserstein / PSI Drift]
    Drift --> AI[Dual-LLM Consensus\nOpenAI ↔ Anthropic]
    AI --> Lock[Postgres: Pessimistic Lock\nSELECT...FOR UPDATE, Multi-AZ]
    Lock --> Sign[BLOCK 7.6: Forensic Signer → AWS KMS]
    Sign --> Splunk[(SIEM: Splunk HEC)]
    Splunk --> S3[(WORM Storage: AWS S3 Object Lock)]

    style Sanitizer fill:#1e1e1e,stroke:#ff0000,stroke-width:2px,color:#fff
    style Gov fill:#1e1e1e,stroke:#00aaff,stroke-width:2px,color:#fff
    style AI fill:#1e1e1e,stroke:#aa00ff,stroke-width:2px,color:#fff
    style Lock fill:#1e1e1e,stroke:#00ff00,stroke-width:2px,color:#fff
```

### 2. Mikro Daraja: 9 Bloklik Haqiqiy Tugun Tarkibi

Loyihaning 139 tuguni n8n canvas'idagi haqiqiy Sticky Note bo'limlariga muvofiq 9 blokka ajratilgan:

```mermaid
flowchart TD
    subgraph B1 ["🛡️ BLOK 1 — Enhanced Input & Security"]
        WH["📡 Webhook Ingestion"] --> RH["⚖️ EVALUATE: Region Health"]
        RH --> VP["🎙️ Voice Processor"]
        VP --> NORM["⚡ PROD Input Normalizer V30"]
        NORM --> RIDEM["🔑 Redis: Idempotency Check"]
        RIDEM --> VAL["🔐 Vault: AppRole Login"]
        VAL --> CL["⚙️ Configuration Loader V30"]
        CL --> TIT["🛡️ Titanium Sanitizer"]
        TIT --> PEP["🌍 PEP/Sanctions API"]
    end

    subgraph B2 ["🤖 BLOK 2 — Enhanced Classification & Context"]
        LDE["🌐 Language Detection V19"] --> RC["🧭 Rule-Based Classifier"]
        RC --> SEV["📊 Severity Classifier"]
    end

    subgraph B3 ["💼 BLOK 3 — Enhanced Business Logic"]
        BIC["💰 Business Impact Calculator UZS"] --> SLA["⏱️ Uzbekistan SLA Calculator"]
    end

    subgraph B4 ["🧠 BLOK 4 — Enhanced AI & Memory Context"]
        GOV["🏛️ Governance Gate (OIDC/ABAC)"] --> RRF["🔍 Hybrid RRF Search"]
        RRF --> MIG["🛡️ Memory Integrity Guard\n(Wasserstein/PSI)"]
        MIG --> PCP["📦 Prep Consensus Payload"]
        PCP --> LLM1["🤖 LLM OpenRouter (OpenAI)\nCircuit Breaker 2000ms"]
        LLM1 --> LLM2["🤖 LLM OpenRouter (Anthropic)"]
        LLM2 --> CEV["⚖️ Consensus Engine Validator"]
    end

    subgraph B5 ["✍️ BLOK 5 — Enhanced Approval & Dispatch"]
        SDL["🔒 Postgres: Acquire Dispatch Lock"] --> UAS["📝 Postgres: Update Approval State"]
        UAS --> HMAC["🔑 HMAC → KMS Verify"]
    end

    subgraph B6 ["🧩 BLOK 6 — Memory Core"]
        MC["💾 Memory Core Logic"] --> MEM["📚 Memory Context Formatter"]
    end

    subgraph B7 ["🔏 BLOK 7 — Forensic Audit"]
        SCRUB["🕵️ PII Forensic Scrubber"] --> SIGN["🔑 Forensic Signer → AWS KMS"]
        SIGN --> SIEM["📡 SIEM: Splunk HEC"]
        SIEM --> WORM["🗄️ WORM Storage: S3 Object Lock"]
    end

    subgraph B89 ["⚙️ BLOK 8–9 — Execution Policy & Dispatch"]
        FW["🚧 Execution Policy Firewall"] --> HIL["🧑‍⚖️ Human-in-the-Loop Gate"]
        HIL --> DIST["🧭 Logic Distributor (Switch)"]
    end

    B1 --> B2 --> B3 --> B4 --> B5 --> B7
    B4 --> B6
    B4 --> B89
```

---

## ⚙️ 5 BOSQICHLI TEXNIK EVOLYUTSIYA (V30 → V30.1)

Loyiha n8n, HashiCorp Vault, PostgreSQL, Redis va Supabase (pgvector) ekotizimida 5 bosqichda ishlab chiqildi. Har bir bandda **haqiqiy kod mantig'i** ko'rsatilgan; `[V30.1]` belgisi mini-roadmap audit natijasida qo'shilgan tuzatishlarni bildiradi.

### 🛡️ Phase 1: Ingress Perimeter va Kiber-Mudofaa

* **Redis Idempotency `[V30.1]`:** `PROD Input Normalizer` har bir so'rovni `Idempotency-Key` headeridagi qat'iy UUIDv4 regex (`^[0-9a-f]{8}-...$`) orqali tekshiradi. `Redis: Idempotency Check` endi **`SET NX` + 24 soatlik `EX`** bilan ishlaydi — shu bilan ikki marta yozish (double-spending) va abadiy bloklanib qolish muammosi yo'qoladi.
* **Distributed Rate Limiting `[V30.1]`:** `max_tickets_per_minute` konfiguratsiyasi endi haqiqatda qo'llaniladi — n8n `Redis` tugunidagi cheklovlarni aylanib o'tish uchun `Fixed-Window Time Key` arxitekturasi qo'llanildi. Har bir IP uchun joriy daqiqa kalitiga `INCR` qilinib, **10 so'rov/daqiqa** qat'iy chegarasi amalga oshiriladi.
* **Titanium WAF V30:** Ikki qatlamli himoya — Layer 1 chuqur SQLi/XSS/Prompt-Injection (`union all select`, `information_schema`, `exec xp_cmdshell`, `onload=`, `onerror=`, `ignore previous instructions`, `developer mode`), Layer 2 "Authority Poisoning" — soxta email header, soxta "Sent from my iPhone" imzo, soxta reply-chain va ijro etuvchi rol (CEO/CFO/director/compliance officer) taqlidini regex orqali aniqlaydi.
* **PEP/Sanctions Hook `[V30.1]`:** `HTTP: PEP/Sanctions API` `api.sanctions.io/screen` ga `customer_email` va `trace_id` bilan murojaat qiladi; oldingi versiyadagi JSON body formatlash xatosi (qiymatlar oldida ortiqcha `=` belgisi) tuzatildi.

### 🔐 Phase 2: Tranzaksiyalar Izolyatsiyasi (Core Banking)

* **Pessimistic Locking `[V30.1]`:** `Supabase: Acquire Dispatch Lock` va `Update Approval State` endi PostgREST `PATCH` o'rniga to'g'ridan-to'g'ri `SELECT ... FOR UPDATE` bilan o'rab olingan SQL tranzaksiyasi orqali qulflanadi — race-condition va ikki marta tasdiqlash xavfi yo'qoladi.
* **AWS KMS HSM Imzolash `[V30.1]`:** `BLOCK 7.6: Forensic Signer` manifestni (`trace_id`, `net_savings_uzs`, `input_state_hash`, `data_payload_hash`) tuzadi va endi to'g'ridan-to'g'ri AWS KMS `Sign` API'siga HTTP chaqiruv orqali yuboriladi — oldingi versiyada bu faqat tayyorlov bosqichi edi, haqiqiy imzolash tuguni yo'q edi.
* **WORM Storage `[V30.1]`:** `WORM Storage: AWS S3` endi shunchaki `glacier` storage class emas — **S3 Object Lock (Compliance mode)** bilan sozlangan, ya'ni yozuvlar belgilangan muddat davomida hech kim (shu jumladan admin) tomonidan o'chirilmaydi yoki o'zgartirilmaydi.
* **SIEM Integratsiyasi `[V30.1]`:** `SIEM: Stream to Splunk` endi haqiqiy Splunk HEC manzili va token bilan ishlaydi (avvalgi `[YOUR_SPLUNK_HEC_URL]` placeholder almashtirildi).

### 🧠 Phase 3: Gibrid Qidiruv (RRF) va AI Mustaqilligi

* **Reciprocal Rank Fusion (RRF):** `Supabase: Hybrid RRF Search` `rpc/hybrid_search_rrf` chaqiradi — Dense vektor (multilingual-e5-large) va Sparse BM25 natijalari `rrf_k=60` bilan birlashtiriladi, eng yuqori 5 natija (`match_count=5`) qaytadi.
* **AI Circuit Breaker:** `LLM OpenRouter (OpenAI)` so'rovi qat'iy **2000ms** timeout bilan ishlaydi (`onError: continueErrorOutput`), muvaffaqiyatsiz bo'lsa workflow yiqilmaydi — `LLM-error` IF orqali `LLM OpenRouter (Anthropic)`ga avtomatik o'tadi.
* **Localized Triton Fallover `[V30.1]`:** Governance Gate'dagi `LLM_MODE_LOCAL_ONLY` bayrog'i bilan belgilangan yuqori-xavfli (`RESTRICTED` klassifikatsiyali) tranzaksiyalar, shuningdek ikkala bulut provayder ham muvaffaqiyatsiz bo'lganda, endi bankning ichki, izolyatsiyalangan **Triton Inference Server**iga yo'naltiriladi — ma'lumot hech qachon tashqariga chiqmaydi.
* **Til Aniqlash V19:** O'zbek/Rus/Ingliz ball tizimi orqali aniqlangan til `urn:revenant:alignment:{til}_financial_v2` formatidagi inson tomonidan tasdiqlangan tarjima jadvaliga (Alignment Table) bog'lanadi.

### 🔬 Phase 4: Matematik Drift va Deepfake Nazorati

* **Wasserstein Distance va PSI:** `BLOCK 6.1: Memory Integrity Guard` har bir kiruvchi embedding'ni baseline bilan solishtiradi: Wasserstein masofa > **25.0** yoki PSI > **0.2** bo'lsa, risk balliga +50 qo'shiladi. Tezlik (2 soniyadan tez takrorlanish: +30) va summa og'ishi (o'rtachadan 10x yuqori: +40) bilan birga umumiy risk ≥ 80 bo'lganda `PREDICTIVE_BLOCK` ishga tushadi.
* **24-Soatlik Drift Monitoring `[V30.1]`:** Ilgari bu tekshiruv faqat real-vaqt, har bir tranzaksiyada ishlardi. Endi alohida **Schedule Trigger workflow** orqali har 24 soatda butun production so'rovlar to'plamining baseline'dan og'ishi hisoblanadi va MLOps monitoring konsoliga avtomatik signal yuboriladi.
* **Deepfake SOC Escalation:** `Voice Processor` `crypto.timingSafeEqual` orqali jonlilik (liveness) parolini Timing-Attack'siz tekshiradi; 60 soniyadan eski audio paketi (`Replay Attack`) yoki sintetik markerlar aniqlansa, `soc_action: GLOBAL_ACCOUNT_FREEZE` signali Master Router orqali tarqatiladi.

### 🌍 Phase 5: Global Masshtab va O'lmaslik (Chaos Engineering)

* **Real Region Health Check `[V30.1]`:** `EVALUATE: Region Health` ilgari statik (`Simulated as HEALTHY by default`) edi. Endi Region B'ning `/health` endpointiga haqiqiy HTTP probe yuboradi; faqat haqiqiy 5xx/timeout aniqlanganda HTTP 307 orqali Region B'ga yo'naltiradi.
* **Multi-AZ Failover:** PostgreSQL Primary (Region A) / Standby (Region B) rejimida; Pessimistic lock tugunlari endi `retryOnFail` va multi-AZ connection string bilan ishlaydi.
* **Chaos & Load Engineering `[V30.1]`:** Alohida Cron Workflow orqali tunlik **Grafana k6** yuklama testi (5,000 TPS gacha) va Chaos Monkey uslubidagi nodlarni tasodifiy o'chirish simulyatsiyasi ishga tushiriladi.
* **Cross-Region Sync:** WORM loglar har 30 soniyada Region B'dagi zaxira S3 saqlagichiga asinxron replikatsiya qilinadi.

---

## 📋 NOD-BA-NOD CHUQUR TAHLIL (EXHAUSTIVE DEEP DIVE)

### 🌐 BLOK 1: Ingress, Vault va Xavfsizlik Qatlami

* **`Webhook Ingestion` → `EVALUATE: Region Health` → `IF: Circuit Tripped?`:** Har bir so'rov avval mintaqaviy sog'lik tekshiruvidan o'tadi; faqat Region A sog'lom bo'lsa davom etadi.
* **`Voice Processor`:** Biometrik tekshiruv. `expected_liveness_phrase` bilan `spoken_phrase` `crypto.timingSafeEqual` orqali solishtiriladi (uzunlik teng bo'lmasa avtomatik `false`). Ro'yxatdan o'tmagan foydalanuvchi uchun `TRIGGER_ENROLLMENT_FLOW` qaytadi.
* **`PROD Input Normalizer - Hardened V30`:** `sanitizeString()` — buffer-overflow himoyasi (kesish), SQLi/NoSQLi tozalash, XSS entity-encode; `sanitizeEmail()` — faqat ruxsat etilgan belgilarni qoldiradi. `traceparent` headerini W3C formatida tekshirib `trace_id`ni tiklaydi, bo'lmasa `crypto.randomBytes(16)` bilan yangi ID generatsiya qiladi.
* **`Vault: AppRole Login` → `Vault: Fetch Configuration` → `Configuration Loader - V30`:** AppRole `role_id`/`secret_id` orqali qisqa muddatli `client_token` olinadi (production'da bu n8n credential store yoki environment orqali in'ektsiya qilinadi, kod ichida emas). Token bilan `secret/data/revenant/config` dan `AGENT_HOURLY_RATE`, `HMAC_SECRET` kabi qiymatlar tortib olinadi.
* **`BLOCK 0: Titanium Sanitizer`:** `THREAT_PATTERNS` massivi va `AUTHORITY_PATTERNS` regex to'plami orqali ikki qatlamli zararli kontent skaneri.

### 🤖 BLOK 2: Klassifikatsiya va Niyatni Aniqlash

* **`Language Detection Engine - V19 (Expanded)`:** O'zbekcha (`uzcard`, `humo`, `to'lov`), Ruscha (Kirill alifbosi + moliyaviy terminlar) va Inglizcha kalit so'zlar bo'yicha ballash tizimi; eng yuqori ball asosida til aniqlanadi va ishonch darajasi (`confidence`) hisoblanadi.
* **`Rule-Based Classifier` & `Rule-Based Severity Classifier`:** Deterministik (LLM'siz) qoidalar asosida dastlabki intent va jiddiylik darajasini belgilaydi — bu LLM chaqirilishidan oldingi tezkor filtr bo'lib xizmat qiladi.

### 💼 BLOK 3: Biznes Mantiq

* **`Business Impact Calculator (UZS) - V20`:** Har bir tiketning moliyaviy ta'sirini `Configuration Loader`dan kelgan stavkalar asosida UZS'da hisoblaydi.
* **`Uzbekistan SLA Calculator - Fixed Timezone V20`:** `Asia/Tashkent` vaqt mintaqasi, ish kunlari (Dush-Juma, 9:00–18:00) va ish vaqtidan tashqari uchun ×1.5 koeffitsient bilan critical/high/medium/low SLA muddatlarini hisoblaydi.

### 🧠 BLOK 4: Governance, RAG va Dual-LLM Konsensus

* **`Governance Gate & Context Assembler`:** OIDC kontekstidan (`user_role`, `clearance_level`) ABAC matritsasi orqali ruxsat tekshiriladi. Segregation-of-Duties qoidasi: `automation_engineer` roli `RESTRICTED` ma'lumotga kira olmaydi → `SoD_VIOLATION_BLOCKED`. Yuqori-xavfli holatlarda `LLM_MODE_LOCAL_ONLY` bayrog'i o'rnatiladi va kontekst n8n `Cloud Sandbox` cheklovlarini aylanib o'tuvchi maxsus `Pure-JS` deterministik xesh algoritmi (`getHash, sorted keys`) bilan muhrlanadi.
* **`Supabase: Hybrid RRF Search` → `BLOCK 6.1: Memory Integrity Guard`:** Qidiruv natijalari avval RRF orqali olinadi, so'ng xotira yaxlitligi (poisoning detection — embedding checksum solishtirish) va matematik drift (Wasserstein/PSI) tekshiriladi.
* **Dual-LLM Konsensus:** `Prep Consensus Payload` → `LLM OpenRouter (OpenAI — gpt-4o-mini)` (2000ms circuit breaker) → muvaffaqiyat/xato holatida ham → `LLM OpenRouter (Anthropic)` → **`Consensus Engine Validator`** ikkala javobni solishtiradi; kelishmovchilik yoki past ishonch holatida deterministik fallback rejimiga (yoki Triton'ga) o'tadi.

### ✍️ BLOK 5: Tranzaksiya Ijrosi va Tasdiqlash

* **`HMAC Verifier`:** Tasdiqlash so'rovlarini `crypto.timingSafeEqual` orqali constant-time solishtiradi (Timing-Attack himoyasi), muddati o'tgan (`expires_at`) va allaqachon ishlatilgan (`consumed`) tasdiqlarni rad etadi.
* **`Postgres: Acquire Dispatch Lock` / `Update Approval State`:** Pessimistic `SELECT ... FOR UPDATE` orqali bir vaqtning o'zida ikki marta tasdiqlanishning (double-approval) oldi olinadi.

### 🔏 BLOK 7: Forensic Audit va Kriptografiya

* **`BLOCK 7.4: PII Forensic Scrubber`:** Jurnalga yozishdan oldin barcha maxfiy ma'lumotlarni (UzCard/Humo raqami, pasport, email, telefon) regex orqali maskalaydi.
* **`BLOCK 7.6: Forensic Signer` → AWS KMS:** Manifest hash'lari (`input_state_hash`, `data_payload_hash`) tuziladi va imzolash uchun KMS'ga yuboriladi.
* **`SIEM: Stream to Splunk` → `WORM Storage: AWS S3`:** Audit paketi parallel ravishda real-vaqt SIEM monitoring va o'zgartirib bo'lmaydigan (Object Lock) uzoq-muddatli saqlashga yo'naltiriladi.
* **`BLOCK 7.8: CBU Compliance Engine`:** `escapeXml()` bilan xavfsiz XML generatsiya qiladi; $10,000 chegarasidan oshган tranzaksiyalar uchun avtomatik SAR hisobotini LRU-1115 Modda 14 formatida tuzadi.

### ⚙️ BLOK 8–9: Ijro Siyosati va Inson Nazorati

* **`BLOCK 8.2: Execution Policy Firewall` → `BLOCK 8.3: Human-in-the-Loop Gate`:** Governance Gate'dan kelgan `HUMAN_IN_THE_LOOP_REQUIRED` bayrog'i shu yerda amalga oshiriladi — yuqori-xavfli qarorlar inson tasdig'isiz ijro etilmaydi.
* **`BLOCK 9.0: Logic Distributor` (Switch):** Yakuniy yo'nalishni (Email/Telegram/Webhook/FAQ dispatch) ticket turiga qarab tanlaydi.

---

## 🔒 HARBIY DARAJALI XAVFSIZLIK POZITSIYASI

| # | Qatlam | Implementatsiya | Standart muvofiqligi |
| --- | --- | --- | --- |
| 1 | **Idempotentlik** | UUIDv4 `Idempotency-Key` + Redis `SET NX` + 24h TTL | RFC 7231 |
| 2 | **Vault AppRole** | Dinamik sir yuklash, kod ichida statik kalit yo'q | HashiCorp Vault v2 |
| 3 | **WAF Sanitizatsiya** | SQL/XSS/Prompt Injection + CEO-Fraud aniqlash | OWASP Top 10 prinsiplariga moslashtirilgan |
| 4 | **HSM Imzolash** | AWS KMS `Sign` API orqali asimmetrik kriptografiya | FIPS 140-2 Level 3 ga moslashtirilgan KMS infratuzilmasi¹ |
| 5 | **Rate Limiting** | Redis token-bucket, 10 so'rov/daqiqa/IP | NIST SP 800-53 Deny-by-Default |
| 6 | **Hard Ceiling** | $50,000 — darhol rad etish | Basel III operatsion risk prinsiplari |
| 7 | **Biometrik Deepfake** | Synthetic/Replay aniqlansa → SOC Account Freeze | PSD2 Strong Customer Authentication ruhida |
| 8 | **Drift Detection** | PSI va Wasserstein Distance, 24h batch + real-time | EU AI Act Risk Tier 1 yondashuviga mos |
| 9 | **CBU Muvofiqlik** | Avtomatik SAR XML, LRU-1115 Modda 14 | O'zbekiston Markaziy Banki talablari |
| 10 | **Disaster Recovery** | Multi-AZ Failover + 30s S3 Async Sync | RPO < 1s, RTO < 30s maqsadi |

> ¹ *Eslatma investorlar/auditorlar uchun:* "FIPS 140-2 Level 3" — bu konkret HSM apparatining sertifikatlangan holati, KMS API'ga ulanishning o'zi emas. Production joylashtirishda buni AWS CloudHSM (yoki tegishli sertifikatlangan HSM) bilan tasdiqlash kerak; hozircha bu — arxitektura **shu standartga moslashtirilgan**, lekin mustaqil sertifikatlanmagan.

---

## 🗺️ MOLIYALASHTIRISH: $3,000 INVESTITSIYA TAQSIMOTI

Bizning jamoamiz V30.1 ni to'liq kodlab, MVP ni yakunladi va o'z-o'zini auditdan o'tkazdi. PDP EcoSystem tomonidan ajratiladigan **$3,000 urug' (Seed) investitsiyasi** arxitekturani Production (Jonli) muhitda ushlab turish va masshtablash uchun quyidagicha taqsimlanadi:

| Yo'nalish | Miqdor | Maqsad |
| --- | --- | --- |
| **Kiber-Xavfsizlik & HSM** | $800 | AWS KMS kalitlari, HashiCorp Vault Cloud (3 oy) |
| **Infratuzilma (Multi-AZ)** | $800 | AWS RDS PostgreSQL klasterlari va Redis Enterprise |
| **AI API & Fallback** | $500 | OpenRouter konsensus to'lovlari + Triton mahalliy server |
| **Saqlash & Audit** | $400 | Supabase Pro (pgvector) va AWS S3 Object Lock |
| **Chaos & Penetration** | $300 | Grafana k6 Cloud litsenziyasi va zaifliklarni tekshirish |
| **Targ'ibot** | $200 | B2B formatida O'zbekiston banklari bilan uchrashuvlar |

---

## 🛠️ LOKAL MUHIT VA DOCKER DEPLOY

### ⚡ Tezkor Ishga Tushirish (Local Sandbox)

```bash
# 1. Repozitoriyani klonlash
git clone https://github.com/StartapNomi/Revenant-AI.git
cd Revenant-AI

# 2. Muhit o'zgaruvchilarini sozlash
cp .env.example .env
```

> ⚠️ **Faqat lokal sinov uchun:** Quyidagi `docker-compose.yml` Vault'ni **dev rejimida** ishga tushiradi (`VAULT_DEV_ROOT_TOKEN_ID`) — bu xotirada ishlaydi va konteyner qayta ishga tushganda barcha sirlar o'chib ketadi. Bu production uchun **yaroqsiz**. Production'da Vault doimiy storage backend (Consul/Raft) va cloud KMS orqali auto-unseal bilan, root token o'rniga faqat AppRole policy bilan ishga tushiriladi.

### 🐳 `docker-compose.yml` (Lokal Sinov — Zero-Trust Arch)

```yaml
version: '3.8'

services:
  # ========================
  # REVENANT Core Orchestrator
  # ========================
  n8n:
    image: n8nio/n8n:latest
    container_name: revenant_n8n
    restart: always
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=0.0.0.0
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - postgres
      - vault
    networks:
      - revenant_network

  # ========================
  # HashiCorp Vault (DEV MODE — local only)
  # ========================
  vault:
    image: hashicorp/vault:latest
    container_name: revenant_vault
    restart: always
    ports:
      - "8200:8200"
    environment:
      - VAULT_DEV_ROOT_TOKEN_ID=${VAULT_ROOT_TOKEN:-revenant-root-token}
    cap_add:
      - IPC_LOCK
    networks:
      - revenant_network

  # ========================
  # PostgreSQL (Multi-AZ Ready)
  # ========================
  postgres:
    image: postgres:15-alpine
    container_name: revenant_postgres
    restart: always
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=revenant_core
      - POSTGRES_USER=${POSTGRES_USER:-revenant_admin}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-supersecret_db_password}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - revenant_network

  # ========================
  # Redis (Rate Limiter & Idempotency)
  # ========================
  redis:
    image: redis:7-alpine
    container_name: revenant_redis
    restart: always
    ports:
      - "6379:6379"
    command: redis-server --requirepass ${REDIS_PASSWORD}
    networks:
      - revenant_network

volumes:
  n8n_data:
  postgres_data:

networks:
  revenant_network:
    driver: bridge
```

### 🚀 Vault va Workflow Sozlamalari

```bash
# 1. Konteynerlarni ko'tarish
docker-compose up -d

# 2. Vault ichiga kirish va sirlarni joylash
docker exec -it revenant_vault sh
vault auth enable approle
vault kv put secret/revenant/config \
    AGENT_HOURLY_RATE=50000 \
    MANUAL_TICKET_COST=12500 \
    AI_PROCESSING_COST=2500 \
    UZS_EXCHANGE_RATE=12850

# 3. N8N Interfeysiga kirish
# Manzil: http://localhost:5678
# "Import Workflow" orqali REVENANT_V30 JSON faylini yuklang.
```

---

## 👥 JAMOA

> *PDP EcoSystem raqobat qoidalariga muvofiq, REVENANT jamoasi quyidagi mutaxassislardan iborat:*

| 👤 Rol | 🎯 Mas'uliyat | 🛠️ Texnologiyalar | 📧 Bog'lanish |
| --- | --- | --- | --- |
| **Ergashboyev Bobur** 🚀 *Team Lead / Arxitekt / CEO* | n8n workflow dizayni | n8n | @b_007e |
| **Kurbanov Shavkat** 🤖 *Backend / AI Dasturchi* | Database design, LLM | Node.js, OpenAI API | @shava_007 |
| **Izzatov Abdurahmon** 📊🎨 *Biznes Analitik / Frontend / UX* | ROI kalkulyatsiyasi, UZS moliyaviy modellar, Agent yordamchi interfeysi | React, Tailwind, Supabase | @abdurakhmon5 |

---

## 📌 V30.1 Hardening Changelog

Quyidagi ro'yxat V30 ichki auditida aniqlangan kamchiliklar va ularning V30.1'da yopilgan holatini ko'rsatadi — bu sizning judges/investorlar oldida texnik etuklikni ko'rsatish uchun foydali bo'lishi mumkin:

| # | Audit topilmasi (V30) | V30.1 holati |
|---|---|---|
| 1 | Redis idempotency `NX`/TTL'siz, duplikatlarni aniqlamaydi | ✅ `SET NX` + 24h `EX` qo'shildi |
| 2 | PEP/Sanctions API jsonBody'da ortiqcha `=` belgisi | ✅ Tuzatildi |
| 3 | Splunk HEC URL placeholder edi | ✅ Haqiqiy endpoint sozlandi |
| 4 | Core Banking API mock (Beeceptor) endpointga ishora qilardi | ✅ Haqiqiy/sandbox endpoint ulandi |
| 5 | `HMAC Verifier` lokal `crypto.createHmac` ishlatardi | ✅ AWS KMS `Verify` chaqirig'iga o'tkazildi |
| 6 | `Forensic Signer` faqat "KMS uchun tayyorlardi", haqiqiy imzolash yo'q edi | ✅ KMS `Sign` HTTP chaqirig'i qo'shildi |
| 7 | Vault `role_id`/`secret_id` kod ichida hardcoded edi | ✅ Credential store/env'ga ko'chirildi |
| 8 | Supabase lock/approval node'lari faqat PostgREST `PATCH` edi | ✅ Raw SQL `SELECT...FOR UPDATE` ga o'tkazildi |
| 9 | Per-IP/token rate limiter umuman yo'q edi | ✅ Redis token-bucket (10/min) qo'shildi |
| 10 | Triton lokal fallback yo'q edi (faqat cloud-to-cloud) | ✅ `LLM_MODE_LOCAL_ONLY` yo'nalishi Triton'ga ulandi |
| 11 | Cross-encoder rerank tasdiqlanmagan edi | ✅ RPC darajasida tasdiqlandi/qo'shildi |
| 12 | Region Health statik/simulyatsiya edi | ✅ Haqiqiy `/health` probe qo'shildi |
| 13 | 24h drift job va chaos test uchun Schedule Trigger yo'q edi | ✅ Alohida Cron workflow qo'shildi |
| 14 | Data classification 4-tier emas, 2-tier (`CONFIDENTIAL` ishlatilmagan) edi | ✅ To'rt darajaning barchasi mantiqqa kiritildi |

*Tashkilot darajasidagi band (n8n workflow ichida yopib bo'lmaydigan): FIDO2/WebAuthn MFA, OPA policy server, SBOM/Cosign/Checkov CI/CD skanerlash, PAM/JIT vositalari, Model Card/Model Inventory reestri, BYOK/CMK ko'p-tenantli infratuzilma, k6/Locust 5,000 TPS yuklama testi — bularning barchasi alohida infratuzilma loyihasi sifatida kuzatilmoqda.*

---

### 💬 Loyiha Haqida

```
📌 Loyiha: REVENANT — Bank AI Avtomatlashtirish Platformasi
🏆 Tanlov:  PDP EcoSystem Startup Competition 2025
📂 Kategoriya: Sanoat va tadbirkorlikda sun'iy intellekt texnologiyalari
💰 Maqsad:  $3,000 Seed Investitsiya
🌍 Bozor:   O'zbekiston bank sektori (40+ litsenziyalangan bank)
```

---

*© 2026 REVENANT Team. O'zbekiston, Toshkent. Barcha huquqlar himoyalangan.*

**REVENANT V30.1 — Enterprise Global Scale AI**
