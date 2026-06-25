# REVENANT V31 — From Ticket Automation to National Financial Operating Layer
### A Feature & Competitiveness Roadmap

**Author framing:** Written as REVENANT's CEO / Project Vendor, for the team and for investors who ask "what's next."
**Scope:** New capabilities only. No hardening, no bug-fixing, no infra resilience — that conversation already happened in V30.1.
**Premise:** V30.1 proved we can run a single bank's support queue safely. V31 is about proving we can be the AI layer an entire national banking sector runs on top of.

---

## 1. Why This Roadmap Exists — The Market Just Moved

Two things are true at the same time, and they define our entire strategy for the next 12 months:

**The threat:** Uzum — Uzbekistan's e-commerce-plus-banking super-app — is now valued at roughly $2.3B, backed by Tencent, VR Capital, and Omani sovereign wealth, with more than half the country using it monthly and a pre-IPO raise of $250–300M in motion. Every bank we sell to is losing customer mindshare to an app that isn't theirs. None of our 40 target banks can out-build Uzum. They don't need to. They need an AI layer that makes *their own* app feel as instant and conversational as Uzum's — without a 5-year, $200M engineering program.

**The opening:** The Central Bank of Uzbekistan is *right now* finalizing the rules for phone-number-based P2P transfers inside the Instant Payment System, and explicitly delivering it as an **Open API** so any application can plug in. This is a brand-new national payment rail being built in public, in real time, this year. Whoever builds the best conversational interface on top of it first — for 40 banks at once — owns the UX layer for a transaction type that's about to become the default way Uzbeks move money. We are positioned to be that layer before a single competitor notices the API exists.

Add to that: a national e-KYC / e-signature push under "Digital Uzbekistan 2030," a CBU-mandated cashless expansion starting this April, and a live stablecoin regulatory sandbox since January — the regulatory floor under us is moving fast, and almost entirely in directions that favor an AI-orchestration layer over a traditional core-banking IT department that ships twice a year.

**The thesis:** REVENANT does not become a super-app. We become the AI nervous system that licensed banks plug in to compete *with* super-apps — keeping the balance sheet, the trust, the license with the bank, while we own the conversational, agentic, and intelligence layer on top.

---

## 2. The Six Pillars

| Pillar | One-line pitch | Target window |
|---|---|---|
| 1. Money Movement | Ride the new CBU instant-payment rail before anyone else does | Q3 2026 |
| 2. Embedded Credit | Take on Uzum Nasiya's BNPL dominance with bank-grade lending in chat | Q3–Q4 2026 |
| 3. Voice-First Banking | Win the channel Uzum can't — the phone call | Q4 2026 |
| 4. Conversational Commerce | Multimodal UX parity with modern consumer apps | Q4 2026 – Q1 2027 |
| 5. Platform & B2B Moat | Stop selling a project. Start selling a network. | Q1–Q2 2027 |
| 6. Frontier Bets | Cheap options on where regulation goes next | Ongoing, opportunistic |

---

## 3. Pillar 1 — Money Movement (Q3 2026)

### F1. Conversational P2P by Phone Number — *flagship feature*
**What it is:** "Ravshanga 50,000 so'm yubor" — spoken or typed — resolves the recipient's phone number through the new CBU Open API directory, confirms with the sender, executes the transfer, and reads back a confirmation. Works in chat, Telegram, or by phone call.
**Why it wins:** This is a brand-new behavior with zero incumbent muscle memory. Whoever's UX customers learn first, wins the habit. We have a 6–9 month window before every bank's mobile team copies the obvious "send money" button — we can own the *conversational* version of it for all of them simultaneously.
**Builds on what we already have:** the existing `HTTP: PEP/Sanctions API` screening pattern (this rail explicitly excludes terrorism-financing/WMD-proliferation-listed individuals — we already do this check), the Governance Gate's ABAC/risk-scoring logic, the Voice Processor's liveness check for voice-initiated transfers, and the Postgres pessimistic-lock pattern for the actual ledger movement.
**New build:** one node block — `CBU TTT: Resolve Phone-to-Account` (HTTP call to the new Open API), a confirmation-loop sub-flow, and a `Ledger: Execute P2P Transfer` node wired into the existing lock/forensic-sign/SIEM chain we already trust.

### F2. Universal Bill-Pay & Government Services Aggregator
**What it is:** One conversational flow for utilities, mobile top-up, tax/INN payments, and traffic fines (the kind of aggregation Click, Payme, and Uzum currently win on). "INN va kommunal xizmatlar" is already in our own positioning — this turns it from a slide bullet into a real, multi-provider dispatch engine.
**Why it wins:** Every bill paid through *us* is a transaction that stays inside the bank's app instead of leaking to a Uzum/Click/Payme wallet. This is pure defense of transaction volume, with a small per-transaction fee upside.
**Builds on:** `Master Router` (already does intent classification), `BLOCK 9.0: Logic Distributor` (already does Switch-based dispatch) — extend with a provider-registry pattern instead of hardcoded destinations.

### F3. Pay-by-Chat (QR / Merchant Checkout)
**What it is:** Generate a one-time QR or payment link mid-conversation so the chat itself becomes a checkout surface — "pay this merchant 120,000 so'm" without leaving the thread.
**Why it wins:** Turns REVENANT from a cost center (support automation) into a transaction-volume driver, the metric banks and investors actually pay for.

---

## 4. Pillar 2 — Embedded Credit (Q3–Q4 2026)

### F4. Conversational Micro-Loan / BNPL Origination
**What it is:** "Menga 2 million so'm kerak" → AI runs eligibility against the bank's own core banking data and our existing risk-scoring infrastructure → instant pre-approval → e-signature contract (riding the same e-KYC/e-imzo national digital-ID push) → disbursement, all without leaving the conversation.
**Why it wins:** This is a direct shot at Uzum Nasiya's BNPL dominance — but backed by a licensed bank's balance sheet and regulatory standing instead of a fintech wrapper. Banks can finally compete on *speed* of credit decisioning, which is the only thing Uzum currently beats them on.
**Builds on:** `Business Impact Calculator`, `Governance Gate`'s risk/ABAC scoring, and the Human-in-the-Loop gate for anything above an auto-approval threshold.
**New build:** `Credit: Eligibility Scorer`, `Credit: e-Signature Dispatch`, `Credit: Disbursement Trigger` — a 3-node sub-flow, human-gated above a configurable amount.

### F5. AI Financial Wellness & Retention Nudges
**What it is:** Proactive outbound: "balansingiz past, avtomatik to'lov muvaffaqiyatsiz bo'ladi," personalized savings nudges, loan-renewal reminders. Turns REVENANT from purely reactive support into a retention and deposit-stickiness tool.
**Why it matters competitively:** This is the first feature that requires a **Schedule Trigger workflow** rather than the webhook-only design we have today — worth calling out because it changes how we pitch the architecture ("REVENANT now runs in the background, not just on-demand").

---

## 5. Pillar 3 — Voice-First Banking (Q4 2026)

### F6. Full Speech-to-Speech IVR Replacement — *the channel super-apps can't take*
**What it is:** Today, `Voice Processor` only verifies *who you are* (liveness/biometric check). This extends it to a full ASR → LLM → TTS loop in Uzbek and Russian, so a customer can do an entire banking session by phone call — check balance, pay a bill, dispute a charge — with no app required.
**Why it wins:** Uzum, Click, and Payme are app-only by nature. A meaningful share of the population — older customers, rural areas, anyone without a smartphone data plan in the moment — is invisible to super-apps but perfectly reachable by a phone call. This is the one channel where a bank's existing call-center number is actually an asset, not a liability, once REVENANT is behind it.
**Builds on:** the Voice Processor's existing constant-time liveness comparison and replay-attack detection — we're not rebuilding security, just extending the conversation past "yes, it's really you."

### F7. Unified Voice Biometric Identity — "One Voiceprint, Every Channel"
**What it is:** The same enrolled voiceprint authenticates phone banking, in-app voice commands, and eventually branch/ATM self-service kiosks.
**Why it's sellable on its own:** This stops being just an internal fraud control and becomes a passwordless-banking identity product line a bank can market to its own customers as a feature, not just a safeguard.

---

## 6. Pillar 4 — Conversational Commerce & Multimodal (Q4 2026 – Q1 2027)

### F8. Document & Image Understanding
**What it is:** A customer photographs a notice, a statement, a merchant receipt, or a contract and asks questions about it directly in the thread, using a vision-capable model.
**Why it matters:** This is now table-stakes UX for any serious conversational AI product in 2026 — its absence is the most visible gap versus a generic ChatGPT-style competitor a bank's digital team might be tempted to bolt on instead of buying us.

### F9. WhatsApp Business + Telegram Rich Bot UX
**What it is:** Quick-reply buttons, card freeze/unfreeze controls, balance-check shortcuts — a real two-way conversational bot, not just an escalation/notification channel (which is all Telegram currently does for us — dispatch only, never inbound conversation).
**Why it wins:** Removes the "but I'd have to download yet another app" objection entirely. Meets customers in the messaging app they already have open all day.

---

## 7. Pillar 5 — Platform & B2B Moat (Q1–Q2 2027)

This is the pillar that actually changes what kind of company we are — from a project we rebuild per bank to a platform we sell once and scale forty times.

### F10. Multi-Tenant SaaS Mode — *the single highest-leverage item on this entire roadmap*
**What it is:** Turn the current single-bank workflow into a true multi-tenant platform: per-bank configuration namespace in Vault, per-bank Supabase schema or row-level isolation, usage-based billing/metering per ticket or transaction.
**Why it's the priority:** Every other feature on this roadmap is worth roughly 40x more once it doesn't require a bespoke deployment per client. This is the difference between "an impressive student/competition project" and "a company with a sellable product."

### F11. Cross-Bank Fraud Intelligence Network
**What it is:** An anonymized, hash-only shared fraud signal pool across every bank running REVENANT. A deepfake voiceprint or a scam pattern flagged at Bank A propagates a privacy-preserving alert to Bank B within minutes.
**Why it's a moat, not just a feature:** No single bank can build this alone — it only works with multiple tenants on one platform. This is the feature that makes leaving REVENANT for a competitor actively *more dangerous* for a bank's fraud posture, which is exactly the kind of lock-in investors look for.

### F12. White-Label Executive Analytics Product
**What it is:** We already collect SLA compliance, ROI-per-ticket, AI consensus-confidence, and drift telemetry as operational exhaust. Package it as a sellable BI dashboard for bank COOs and boards — a second revenue line from data we're generating anyway.

### F13. AI Co-Pilot for Human Agents
**What it is:** For the cases the Human-in-the-Loop gate still routes to a person, give that human agent a real-time suggested-response and context-summary UI instead of a bare ticket queue.
**Why it matters for sales:** It's a sellable efficiency story even to risk-averse banks who aren't ready to let AI act autonomously yet — we win the deal on day one, full automation comes later.

---

## 8. Pillar 6 — Frontier Bets (opportunistic, not committed)

### F14. Stablecoin Settlement Pilot
Uzbekistan opened a stablecoin regulatory sandbox in January 2026. Not a near-term build, but worth a standing relationship with one sponsor bank willing to pilot conversational stablecoin transfers once they have sandbox approval — cheap optionality on a regulatory direction that's clearly moving forward.

### F15. SME Lending & Trade Finance Concierge
Agentic onboarding for SME loan and trade-finance applications — document OCR plus an underwriting checklist conversation. Opens the higher-margin SME segment beyond retail ticket deflection, later in the roadmap once F4's consumer-lending flow is proven.

---

## 9. Sequencing Logic (why this order, not another)

| Priority driver | Pillars it points to |
|---|---|
| Regulatory window closing fastest | Pillar 1 (CBU rail is being finalized *this year*) |
| Direct competitive counter-punch | Pillar 2 (Uzum Nasiya's exact weak spot is decisioning speed, not capital) |
| Differentiation no super-app can copy | Pillar 3 (voice/phone is structurally outside an app-only model) |
| Table-stakes UX parity | Pillar 4 (closes the gap vs. generic AI chat products) |
| Business-model transformation | Pillar 5 (turns "project" into "platform"; do this once Pillars 1–2 prove the product works at one bank) |
| Optionality | Pillar 6 (low-cost bets, no fixed timeline) |

---

## 10. What I'd Need From the Team to Make This Real (the honest CEO note)

A roadmap slide is cheap; I want to name the actual dependencies before we promise these to anyone:

- **F1/F2** need an actual sandbox credential for the CBU Open API the moment it's available — this is the one item where we are dependent on an external timeline, not our own velocity. Worth establishing the relationship with CBU/a pilot bank *now*, before the API is fully public.
- **F6/F7** need a real ASR/TTS vendor decision for Uzbek and Russian (open-weights vs. a commercial API) — this is a build-or-buy call, not a roadmap line item, and it has real unit-economics implications per voice minute.
- **F10** is an engineering re-architecture, not a feature add — it touches every node that currently assumes a single bank's Vault path and Supabase schema. This deserves its own dedicated workstream, not a sprint inside another pillar.
- **F11** only has value at 2+ bank clients — sequence it after we've actually closed a second logo, not before.

---

## 11. The One-Line Pitch This Roadmap Buys Us

*"REVENANT V30 proved an AI can safely run a bank's support queue. REVENANT V31 is the AI layer that lets a 40-bank-strong, license-holding sector compete with a $2.3B super-app — without any one of them having to become one."*

That's the line for the next investor room.
