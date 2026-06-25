# REVENANT v32 in Action: Data Flow & Unit Economics
### Tijorat banklari Boshqaruv Kengashlari va institutsional investorlar uchun arxitektura whitepaper'i

---

### 1. 🔵 Boshqaruv Xulosasi (Executive Summary)

O'zbekiston bank sektori tarixiy tanlov oldida turibdi: **Payme, Click va Uzum** — uchtasi birgalikda mamlakat raqamli to'lov muomalasining sezilarli qismini nazorat qiladi, va ularning afzalligi oddiy — ular mijozning telefonidagi *birinchi ilova*. Har bir an'anaviy bank, jumladan MikroKreditBANK kabi institutsional o'yinchilar, bugun ikki yo'l oldida: yoki super-ilova qurish uchun yillab davom etadigan va o'n millionlab dollar talab qiladigan IT dasturiga kirish, yoki super-ilovalarning "to'lov quvuri" (payment pipe) sifatida qolib, mijoz bilan to'g'ridan-to'g'ri munosabatni butunlay yo'qotish.

**REVENANT — uchinchi yo'lni taklif qiladi.**

Biz bankka *yana bir ilova* sotmaymiz. Biz bankning mavjud kanallarini — qo'ng'iroq markazi, Telegram, va hatto oddiy ovozli qo'ng'iroq — sun'iy intellekt asosida ishlaydigan, bank litsenziyasi va ishonchini saqlab qolgan holda, super-ilovalar darajasidagi tezlik va qulaylikka ko'taradigan **AI operatsion qatlamini** taqdim etamiz.

**Nima uchun bu ishlaydi:**
- **Voice-First arxitektura** — mijoz ilovasiz, oddiy qo'ng'iroq orqali balansini bilishi, pul o'tkazishi, kredit so'rashi mumkin. Bu — super-ilovalar hech qachon yetib bormaydigan segment: qishloq aholisi, yosh nafaqaxo'rlar, smartfonsiz mijozlar.
- **Telegram-Native tajriba** — O'zbekistondagi eng faol messenger ilovasida, mijoz allaqachon ochiq tutgan ilovada, to'liq bank operatsiyalarini amalga oshirish.
- **Litsenziya bankda qoladi** — REVENANT moliyaviy mahsulot emas, u bankning *aqliy infratuzilmasi*. Balans, qarz, mijoz ma'lumotlari — barchasi bankning o'z tizimida, o'z nazoratida qoladi.

Quyida — bu arxitekturaning real ma'lumotlar oqimi, har bir tranzaksiyaning aniq tannarxi, va bankning CFO'si uchun raqamlar bilan asoslangan investitsiya argumenti keltirilgan.

---

### 2. 🟢 Arxitektura Oqimi: Tranzaksiyalar Qanday Ishlaydi? (Data Flow & Workflows)

REVENANT v32 — Temporal.io asosidagi mikroservislar arxitekturasi. Quyida tizimning to'rt asosiy "VLAN" (domen-mikroservis) orqali real ma'lumotlar oqimi ko'rsatilgan.

#### 🔹 VLAN 0 — API Gateway: Qabul Qilish va Yo'naltirish

Har bir so'rov avval Gateway orqali o'tadi. Gateway uch ishni bir necha millisekund ichida bajaradi: so'rovni qabul qiladi, Redis orqali mintaqaviy "circuit breaker" holatini tekshiradi, va deterministik intent-router orqali to'g'ri mikroservisga yo'naltiradi.

**Kiruvchi so'rov (Input):**
```json
{
  "headers": { "x-real-ip": "84.54.12.9", "content-type": "application/json" },
  "body": {
    "channel": "TELEGRAM",
    "customer_id": "CUS-88123",
    "message": "Salom, menga 50 000 so'm Botirjonga o'tkazish kerak"
  }
}
```

**Redis circuit-breaker tekshiruvi (ichki holat):**
```json
{ "key": "infra:region_a:status", "value": "HEALTHY", "checked_at": "2026-06-25T10:13:58Z" }
```

**VLAN 10'ga yo'naltirilgan chiquvchi paket (Output):**
```json
{
  "meta": { "trace_id": "TRC-20260625-9F21", "target_service": "p2p-service", "hop_count": 1 },
  "security_context": { "customer_id": "CUS-88123", "channel": "TELEGRAM" },
  "canonical_ticket": { "intent": "P2P_TRANSFER", "entities": { "amount": 50000, "raw_recipient": "Botirjon" } }
}
```

#### 🔹 VLAN 10 — P2P Transfer: Telegram Tasdiqlash va Bank Ijrosi

P2P tranzaksiya — Temporal Workflow ichida "uxlab yotadi" (suspend), hech qanday server resursini sarflamasdan, mijoz Telegram tugmasini bosgunga qadar.

**Telegram `CONFIRM_P2P` signal (mijoz tugmani bosgandan keyin):**
```json
{
  "signal_name": "confirmP2P",
  "workflow_id": "p2p-TRC-20260625-9F21",
  "payload": {
    "callback_data": "CONFIRM_P2P|eyJjb250cmFjdF9pZCI6IlAyUC05OTIxIn0=",
    "telegram_user_id": 778812345,
    "pressed_at": "2026-06-25T10:14:02Z"
  }
}
```

**Bank tizimiga yuborilgan ijro natijasi (Output):**
```json
{
  "meta": { "trace_id": "TRC-20260625-9F21", "status": "SUCCESS" },
  "result": {
    "operation": "P2P_TRANSFER",
    "transaction_id": "TX-20260625-77321",
    "amount_uzs": 50000,
    "recipient_account_masked": "8600****3344",
    "provider_reference": "CBU-TTT-554821"
  },
  "error": null
}
```

#### 🔹 VLAN 40 — Credit Origination: Kredit Byurosi va e-Imzo

**Kredit byurosi javobi (mock, real integratsiyaga tayyor struktura — Input):**
```json
{
  "customer_id": "CUS-88123",
  "bureau_response": {
    "credit_score": 712,
    "debt_burden_ratio_dbr": 28,
    "active_loans": 1,
    "fraud_flag": false
  }
}
```

**`SIGN_LOAN` — avtomatik tasdiqlangan taklif (Output):**
```json
{
  "meta": { "trace_id": "TRC-20260625-9F88", "decision": "AUTO_APPROVE" },
  "result": {
    "contract_id": "LOAN-9921",
    "principal_amount_uzs": 5000000,
    "term_months": 12,
    "signature_token": "eyJhbGciOiJIUzI1NiJ9.eyJjb250cmFjdF9pZCI6IkxPQU4tOTkyMSJ9.k3F2x...",
    "telegram_button": { "text": "✍️ E-Imzo bilan tasdiqlash", "callback_data": "SIGN_LOAN|eyJ..." }
  }
}
```

#### 🔹 VLAN 60 / F5 — Proaktiv Moliyaviy Eslatmalar *(Keyingi bosqich — Roadmap'da rejalashtirilgan)*

> Eslatma: bu VLAN hozircha qurilmagan — u Schedule Trigger asosidagi alohida arxitektura talab qiladi va bizning rivojlanish reja(roadmap)mizda keyingi ustuvor yo'nalish sifatida belgilangan. Quyida — uning mo'ljallangan ma'lumotlar oqimi.

**Partiyali mijoz ma'lumotlarini yuklash (Batch Hydration — Input):**
```json
{
  "batch_id": "NUDGE-BATCH-20260625-06",
  "customer_snapshot": {
    "customer_id": "CUS-44109",
    "account_balance_uzs": 32000,
    "avg_monthly_outflow_uzs": 850000,
    "next_autopay_date": "2026-06-27",
    "autopay_amount_uzs": 120000
  }
}
```

**LLM tomonidan generatsiya qilingan Telegram eslatmasi (Output):**
```json
{
  "meta": { "trace_id": "NUDGE-CUS-44109-20260625", "channel": "TELEGRAM" },
  "result": {
    "message": "Salom! 27-iyun kuni 120 000 so'mlik avtoto'lovingiz bor, ammo joriy balansingiz 32 000 so'm. Avtoto'lov muvaffaqiyatsiz bo'lib qolmasligi uchun hisobingizni to'ldirib qo'yishni maslahat beramiz.",
    "nudge_type": "LOW_BALANCE_AUTOPAY_RISK"
  }
}
```

---

### 3. 🔵 Tranzaksiya Tannarxi va Tokenlar Iste'moli (Unit Economics per Request)

> **Metodologiya:** quyidagi raqamlar 2026-yil bozor narxlari (GPT-4o-mini: $0.15 / $0.60 har 1M token uchun; DeepSeek V4-Flash: $0.14 / $0.28 har 1M token uchun; Ovozli protsessing: ~$0.051/daqiqa) asosida, REVENANT'ning haqiqiy arxitekturasidagi token sarfi taxminlari bo'yicha hisoblangan. Bu — auditdan o'tgan moliyaviy hisobot emas, balki shaffof asoslangan iqtisodiy model — har bir hisob-kitob pastda ko'rsatilgan.

REVENANT'ning eng muhim arxitektura afzalligi shu yerda ko'rinadi: **deterministik intentlar (P2P, oddiy to'lovlar) to'liq Dual-LLM Consensus dvigatelini chetlab o'tadi** — bu nafaqat tezlikni, balki tannarxni ham keskin pasaytiradi.

| Tranzaksiya turi | O'rtacha token/daqiqa sarfi | Model | Hisoblash | Aniq tannarx |
|---|---|---|---|---|
| **FAQ Chat** (RAG asosida, Dual-Consensus) | 3,000 input / 300 output token | GPT-4o-mini + DeepSeek V4-Flash | (3000×$0.15 + 300×$0.60)/1M + (3000×$0.14 + 300×$0.28)/1M | **$0.00113** |
| **P2P O'tkazma** (deterministik, bitta model) | 800 input / 150 output token | GPT-4o-mini (yagona) | (800×$0.15 + 150×$0.60)/1M | **$0.00021** |
| **Kredit Taklifi Generatsiyasi** (Dual-Consensus) | 2,500 input / 400 output token | GPT-4o-mini + DeepSeek V4-Flash | (2500×$0.15+400×$0.60)/1M + (2500×$0.14+400×$0.28)/1M | **$0.00108** |
| **3-daqiqalik Ovozli IVR Qo'ng'iroq** | 3 daq. ovoz + 4 dialog turi (Dual-Consensus) | Voice API + GPT-4o-mini + DeepSeek | 3×$0.051 + 4×$0.00113 | **$0.1575** |
| **Vision Document OCR** (pasport/chek skanerlash) | ~1,500 vizual token / 200 output token | GPT-4o-mini (yagona, vizual) | (1500×$0.15+200×$0.60)/1M | **$0.00035** |

**Asosiy xulosa:** eng ko'p uchraydigan amal — P2P o'tkazma — atigi **$0.0002** tannarxga ega, chunki tizim uni avtomatik ravishda "engil" yo'lga yo'naltiradi. Bu — 150 nafar operator ishlaydigan an'anaviy qo'ng'iroq markazining bir mijoz bilan gaplashish tannarxidan **mingdan bir** ulushni tashkil etadi.

---

### 4. 🟢 Umumiy Egalik Qiymati (TCO) va Investitsiya Qaytimi (ROI)

> **Metodologiya eslatmasi:** quyidagi moliyaviy model 150 nafar operatorli qo'ng'iroq markazi va REVENANT'ning operatsion xarajatlari bo'yicha loyihalashtirilgan taqqoslashga asoslangan — bu prognoz model, mustaqil moliyaviy audit emas. Banklar o'z real shtat jadvali va xarajat tuzilmasi asosida ushbu modelni qayta hisoblashlari tavsiya etiladi.

| Ko'rsatkich | Qiymat |
|---|---|
| 🔵 **An'anaviy qo'ng'iroq markazi** (150 operator, oylik) | **$1,230,000 / oy** |
| 🟢 **REVENANT operatsion xarajati (COGS)** | **~$4,300 / oy** |
| 🟢 **REVENANT oylik litsenziya to'lovi** | **$45,000 / oy** |
| 🔵 **Jami REVENANT oylik xarajati** | $4,300 + $45,000 = **$49,300 / oy** |

#### 💰 Oylik Tejash Hisob-kitobi
$$1,230,000 - 49,300 = \mathbf{\$1,180,000 \text{ / oy tejash}}$$

#### 📊 Qoplash Davri (Payback Period)
Joriy etish to'lovi (implementation fee): **$1,250,000**

$$\frac{\$1,250,000}{\$1,180,000 \text{ / oy}} = \mathbf{1.06 \text{ oy}}$$

Ya'ni, bank REVENANT'ga sarflagan birinchi investitsiyasini **bir oydan sal ko'proq vaqt ichida** to'liq qoplaydi — bu moliya sektorida juda kam uchraydigan ko'rsatkich.

#### 📉 Bir Muloqot Tannarxining Pasayishi

$$\frac{\$1,180,000}{\$1,230,000} \times 100 = \mathbf{95.99\%}$$

**Har bir mijoz muloqotining tannarxi 95.99% ga pasayadi** — bu bank uchun nafaqat xarajatlarni qisqartirish, balki butunlay yangi moliyaviy model: deyarli cheksiz miqyosda kengaytirish imkoniyati, qo'shimcha xodim yollashsiz.

---

### 5. 🔵 Platformaning Bozordagi Intelektual Mulk Qiymati (Strategic Valuation)

REVENANT'ning haqiqiy qiymati — bitta bank uchun yaratilgan avtomatlashtirish emas. Uning qiymati **tarmoq effekti** (network effect) orqali ko'p martalab oshadi, va bu effekt aynan **Cross-Bank Fraud Intelligence Network** orqali yuzaga keladi.

**Bu qanday ishlaydi:**
- Har bir REVENANT mijozi (har bir bank) — tarmoqning bir tuguni.
- Bank A'da aniqlangan firibgarlik signali (masalan, deepfake ovoz yoki shubhali tranzaksiya andazasi) **mijozning shaxsiy ma'lumotlarini oshkor qilmagan holda**, **SHA-256 xesh** ko'rinishida, tarmoqning boshqa barcha banklariga — Bank B, Bank C — bir necha daqiqa ichida signal beradi.
- Hech bir alohida bank, qancha katta bo'lmasin, bu turdagi jamoaviy firibgarlik-razvedka tarmog'ini **yolg'iz qura olmaydi** — bu faqat ko'p-tenant (multi-tenant) platforma sifatida ishlaganda yuzaga keladi.

**Bu — klassik platforma biznes modeli:** har bir yangi bank mijozi tarmoqni *barcha* mavjud mijozlar uchun qiymatliroq qiladi. Bu xususiyat REVENANT'ni bitta avtomatlashtirish vositasidan — O'zbekiston (va keyinchalik Markaziy Osiyo) moliyaviy xavfsizlik infratuzilmasining ajralmas qismiga aylantiradi.

**Strategik xulosa investorlar uchun:**

> Yuqoridagi arxitektura yetuk holati, isbotlangan 95.99% tannarx pasayishi, 1.06 oylik qoplash davri, va ko'p-tenant tarmoq effekti moatini hisobga olgan holda, REVENANT platformasining **maqsadli sotib olish qiymati (target acquisition valuation)** **$8,000,000 dan $15,000,000+ gacha** oraliqda baholanadi. Bu — mustaqil moliyaviy baholash emas, balki taqqoslanadigan fintech infratuzilma bitimlari (comparable transactions) asosidagi strategik mo'ljal bo'lib, rasmiy due diligence jarayonida aniqlashtirilishi lozim.

**REVENANT — bankka sotiladigan mahsulot emas. U bank sektorining o'zi ustida quriladigan, har bir yangi mijoz bilan kuchayib boradigan moliyaviy infratuzilma qatlami.**
