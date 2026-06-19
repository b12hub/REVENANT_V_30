# REVENANT V31 — Ticketlarni avtomatlashtirishdan Milliy moliyaviy operatsion qatlamgacha



### Xususiyatlar va Raqobatbardoshlik Yo'l xaritasi



**Muallifning bayoni:** REVENANT bosh direktori / Loyiha ta'minotchisi tomonidan jamoa va "keyingi qadam nima" deb so'raydigan investorlar uchun yozilgan.
**Qamrov:** Faqat yangi imkoniyatlar. Hech qanday qattiqlashtirish (hardening), xatolarni tuzatish (bug-fixing), infratuzilma barqarorligi yo'q — bu suhbat V30.1 da bo'lib o'tgan.
**Asosiy shart:** V30.1 biz bitta bankning qo'llab-quvvatlash navbatini xavfsiz boshqara olishimizni isbotladi. V31 butun milliy bank sektori ishlaydigan sun'iy intellekt (AI) qatlami bo'lishimiz mumkinligini isbotlash haqidadir.

---

## 1. Nima uchun bu yo'l xaritasi mavjud — Bozor hozirgina o'zgardi



Bir vaqtning o'zida ikkita narsa haqiqatdir va ular keyingi 12 oy uchun butun strategiyamizni belgilaydi:

**Xavf:** Uzum — O'zbekistonning elektron tijorat va bank super-ilovasi — hozirda taxminan 2,3 milliard dollarga baholanmoqda, Tencent, VR Capital va Ummon suveren boylik jamg'armasi tomonidan qo'llab-quvvatlanadi, mamlakatning yarmidan ko'pi undan har oy foydalanadi va IPO dan oldin 250–300 million dollar jalb qilish arafasida. Biz sotadigan har bir bank mijozlarning e'tiborini o'zlariniki bo'lmagan ilovaga boy bermoqda. Bizning 40 ta maqsadli banklarimizning hech biri Uzumdan o'zib keta olmaydi. Ularga buning keragi ham yo'q. Ularga 5 yillik, 200 million dollarlik muhandislik dasturisiz, *o'zlarining* ilovalarini Uzumniki kabi tezkor va suhbatlashish (conversational) qulayligiga ega qiladigan AI qatlami kerak.

**Imkoniyat:** O'zbekiston Markaziy banki *ayni damda* Tezkor To'lovlar Tizimi doirasida telefon raqamiga asoslangan P2P o'tkazmalari qoidalarini yakunlamoqda va har qanday ilova ulana olishi uchun uni ochiq API (**Open API**) sifatida taqdim etmoqda. Bu butunlay yangi milliy to'lov tizimi bo'lib, joriy yilda ochiq va real vaqt rejimida qurilmoqda. Bir vaqtning o'zida 40 ta bank uchun uning ustida eng yaxshi suhbat interfeysini birinchi bo'lib qurgan har qanday kishi o'zbeklarning pul o'tkazishining odatiy usuliga aylanib borayotgan tranzaksiya turi uchun UX (foydalanuvchi tajribasi) qatlamiga egalik qiladi. Biz API mavjudligini bironta ham raqobatchi sezmasidan oldin ushbu qatlam bo'lish uchun qulay pozitsiyadamiz.

Bunga qo'shimcha: "Raqamli O'zbekiston 2030" doirasida milliy e-KYC / e-imzoga bo'lgan undov, Markaziy bank tomonidan joriy yilning aprel oyidan boshlanishi kutilayotgan naqd pulsiz iqtisodiyotga o'tish mandati va yanvar oyidan beri ishlayotgan steyblkoin (stablecoin) tartibga solish sinov doirasi (sandbox) mavjud — bizning ostimizdagi me'yoriy baza tezkorlik bilan va deyarli butunlay yilda ikki marta yangilanish chiqaradigan an'anaviy asosiy bank IT departamentidan ko'ra AI-orkestratsiya qatlami foydasiga xizmat qiladigan yo'nalishlarda o'zgarmoqda.

**Tezis:** REVENANT super-ilovaga aylanmaydi. Biz litsenziyaga ega banklar super-ilovalar *bilan* raqobatlashish uchun ulanadigan AI asab tizimiga aylanamiz — balans, ishonch va litsenziya bankning o'zida qoladi, biz esa uning ustidagi suhbat (conversational), agentlik (agentic) va intellekt qatlamiga egalik qilamiz.

---

## 2. Oltita ustun



| Ustun

 | Bir qatorli ta'rif

 | Maqsadli muddat

 |
| --- | --- | --- |
| 1. Pul harakati

 | Yangi MB tezkor to'lov tizimidan boshqalardan oldin foydalanish

 | 2026-yil 3-chorak

 |
| 2. O'rnatilgan kredit

 | Chatdagi bank darajasidagi kreditlash orqali Uzum Nasiya'ning BNPL ustunligiga qarshi chiqish

 | 2026-yil 3-4-choraklar

 |
| 3. Ovozli birinchi bank xizmatlari

 | Uzum g'alaba qozona olmaydigan kanalni — telefon qo'ng'irog'ini yutib olish

 | 2026-yil 4-chorak

 |
| 4. Suhbat orqali tijorat

 | Zamonaviy iste'molchi ilovalari bilan multimodal UX tengligi

 | 2026-yil 4-chorak – 2027-yil 1-chorak

 |
| 5. Platforma va B2B himoyasi

 | Loyiha sotishni to'xtatish. Tarmoq sotishni boshlash.

 | 2027-yil 1-2-choraklar

 |
| 6. Chegara garovlari

 | Qonunchilik keyinchalik qaysi tomonga o'zgarishiga nisbatan arzon variantlar

 | Davom etayotgan, imkoniyatga qarab

 |

---

## 3. 1-ustun — Pul harakati (2026-yil 3-chorak)



### F1. Telefon raqami orqali suhbatlashish tarzidagi P2P — *asosiy xususiyat*

**Bu nima:** "Ravshanga 50 000 so'm yubor" — og'zaki yoki yozma — yangi MB Open API ma'lumotnomasi orqali qabul qiluvchining telefon raqamini aniqlaydi, yuboruvchi bilan tasdiqlaydi, o'tkazmani amalga oshiradi va tasdiqni o'qib beradi. Chat, Telegram yoki telefon qo'ng'irog'i orqali ishlaydi.
**Nega bu g'alaba qozonadi:** Bu amaldagi eski odatlarga ega bo'lmagan mutlaqo yangi xatti-harakatdir. Mijozlar kimning UX'ini birinchi bo'lib o'rgansa, o'sha odatga aylanib g'alaba qozonadi. Har bir bankning mobil jamoasi aniq "pul yuborish" tugmachasini nusxalashidan oldin bizda 6-9 oylik muddat bor — biz ularning barchasi uchun bir vaqtning o'zida uning *suhbat* versiyasiga egalik qilishimiz mumkin.
**Qanday mavjud narsalar ustiga quriladi:** mavjud `HTTP: PEP/Sanctions API` tekshirish modeli (bu tizim terrorizmni moliyalashtirish/OMM tarqatish ro'yxatiga kiritilgan shaxslarni aniq chiqarib tashlaydi — biz bu tekshiruvni allaqachon amalga oshiramiz), Boshqaruv darvozasi (Governance Gate)ning ABAC/xavflarni baholash mantig'i, Ovozli protsessorning (Voice Processor) ovoz bilan boshlangan o'tkazmalar uchun haqiqiylik (liveness) tekshiruvi va haqiqiy daftardagi (ledger) harakatlar uchun Postgres pessimitik-qulflash (pessimistic-lock) modeli.
**Yangi qurilma:** bitta tugun bloki — `CBU TTT: Telefonni hisobga ulash (Resolve Phone-to-Account)` (yangi Open API-ga HTTP chaqiruvi), tasdiqlash tsikli (confirmation-loop) quyi oqimi va biz allaqachon ishonadigan mavjud qulf/kriminalistik-imzo/SIEM zanjiriga ulangan `Ledger: P2P o'tkazmasini bajarish` tuguni.

### F2. Universal hisob-kitoblar va davlat xizmatlari agregatori



**Bu nima:** Kommunal xizmatlar, mobil hisobni to'ldirish, soliq/STIR (INN) to'lovlari va yo'l harakati jarimalari uchun yagona suhbat oqimi (aynan Click, Payme va Uzum hozirda g'alaba qozonayotgan agregatsiya turi). "INN va kommunal xizmatlar" allaqachon bizning o'z pozitsiyamizda bor — bu uni slayd nuqtasidan haqiqiy, ko'p provayderli dispetcher dvigateliga aylantiradi.
**Nega bu g'alaba qozonadi:** *Biz* orqali to'langan har bir to'lov — bu Uzum/Click/Payme hamyoniga chiqib ketish o'rniga, bankning o'z ilovasida qoladigan tranzaksiyadir. Bu kichik bir tranzaksiya to'lovi foydasi bilan tranzaksiya hajmini sof himoya qilishdir.
**Asoslanadi:** `Asosiy marshrutizator (Master Router)` (allaqachon maqsad tasnifini (intent classification) amalga oshiradi), `BLOK 9.0: Mantiq tarqatuvchi (Logic Distributor)` (allaqachon Switch asosidagi jo'natishni amalga oshiradi) — qattiq kodlangan manzillar o'rniga provayder-registr (provider-registry) modeli bilan kengaytiring.

### F3. Chat orqali to'lash (QR / Sotuvchida hisob-kitob qilish)



**Bu nima:** Suhbat davomida bir martalik QR yoki to'lov havolasini yarating, shunda chatning o'zi to'lov yuzasiga aylanadi — yozishmadan chiqmagan holda "bu sotuvchiga 120 000 so'm to'lang".
**Nega bu g'alaba qozonadi:** REVENANT-ni xarajat markazidan (qo'llab-quvvatlashni avtomatlashtirish) banklar va investorlar haqiqatan ham pul to'laydigan asosiy ko'rsatkich — tranzaksiya hajmi drayveriga aylantiradi.

---

## 4. 2-ustun — O'rnatilgan kredit (2026-yil 3-4-choraklar)



### F4. Suhbat orqali Mikro-qarz / BNPL ni rasmiylashtirish



**Bu nima:** "Menga 2 million so'm kerak" → AI muvofiqlikni bankning o'zining asosiy bank ma'lumotlari va bizning mavjud xavf-xatarlarni baholash infratuzilmamiz orqali tekshiradi → zudlik bilan oldindan ma'qullash → elektron imzo (e-signature) shartnomasi (ayni e-KYC/e-imzo milliy raqamli ID tashabbusiga asoslangan holda) → mablag'ni ajratish, bularning barchasi suhbatdan chiqmagan holda amalga oshadi.
**Nega bu g'alaba qozonadi:** Bu Uzum Nasiyaning BNPL ustunligiga to'g'ridan-to'g'ri zarba, ammo fintex qobig'i o'rniga litsenziyaga ega bank balansi va me'yoriy maqom bilan qo'llab-quvvatlanadi. Banklar nihoyat kredit bo'yicha qaror qabul qilish *tezligi* bo'yicha raqobatlasha oladilar, bu Uzum hozirda ularni mag'lub etayotgan yagona narsadir.
**Asoslanadi:** `Biznes ta'sirini hisoblagich (Business Impact Calculator)`, `Boshqaruv darvozasi (Governance Gate)`ning xavf/ABAC baholashi va avtomatik ma'qullash chegarasidan yuqori bo'lgan har qanday narsa uchun "Inson aralashuvi" (Human-in-the-Loop) darvozasi.
**Yangi qurilma:** `Kredit: Muvofiqlikni baholovchi (Eligibility Scorer)`, `Kredit: Elektron imzoni jo'natish (e-Signature Dispatch)`, `Kredit: To'lovni boshlash (Disbursement Trigger)` — sozlangan summadan yuqori bo'lsa inson ishtirokini talab qiluvchi, 3-tugunli quyi oqim.

### F5. AI Moliyaviy salomatlik va Saqlab qolish undovlari



**Bu nima:** Proaktiv chiquvchi (outbound) harakatlar: "balansingiz past, avtomatik to'lov muvaffaqiyatsiz bo'ladi", shaxsiylashtirilgan jamg'arma undovlari, kreditni uzaytirish eslatmalari. REVENANT-ni faqat reaktiv qo'llab-quvvatlashdan mijozlarni saqlab qolish va depozit yopishqoqligi vositasiga aylantiradi.
**Nega u raqobat nuqtai nazaridan muhim:** Bu bizdagi bugungi vebxukli (webhook-only) dizayn o'rniga **Jadval Triggeri (Schedule Trigger) ish jarayonini** talab qiladigan birinchi xususiyatdir — buni alohida ta'kidlash joiz, chunki u arxitekturani qanday taqdim etishimizni o'zgartiradi ("REVENANT endi faqat talabga binoan emas, balki fonga o'rnatilgan holda ishlaydi").

---

## 5. 3-ustun — Ovozli birinchi bank xizmatlari (2026-yil 4-chorak)



### F6. To'liq nutqdan-nutqqa IVR ni almashtirish — *super-ilovalar egallay olmaydigan kanal*

**Bu nima:** Bugungi kunda `Ovozli protsessor` faqat *siz kimligingizni* tekshiradi (liveness/biometrik tekshiruv). Bu uni o'zbek va rus tillarida to'liq ASR → LLM → TTS tsikligacha kengaytiradi, shunda mijoz to'liq bank sessiyasini telefon qo'ng'irog'i orqali amalga oshirishi mumkin — balansni tekshirish, hisobni to'lash, to'lovni nizo qilish — hech qanday ilova talab qilinmaydi.
**Nega bu g'alaba qozonadi:** Uzum, Click va Payme o'z tabiati bo'yicha faqat ilovalarga asoslangan. Aholining katta qismi — keksalar, qishloq joylari, o'sha paytda smartfonida internet paketi bo'lmagan har qanday shaxs — super-ilovalar uchun ko'rinmas, lekin telefon qo'ng'irog'i orqali mukammal tarzda etib borish mumkin bo'lgan qatlamdir. REVENANT o'rnatilgandan so'ng, bankning mavjud call-markazi raqami zarar emas, balki haqiqiy aktivga aylanadigan yagona kanal shu.
**Asoslanadi:** Ovozli protsessorning mavjud doimiy-vaqtni (constant-time) jonli tekshirish va takroriy hujumni (replay-attack) aniqlash tizimi — biz xavfsizlikni qayta quramayapmiz, shunchaki suhbatni "ha, bu haqiqatan ham sizsiz"dan tashqariga kengaytirmoqdamiz.

### F7. Birlashtirilgan Ovozli Biometrik Identifikatsiya — "Bitta ovozli iz, Har bir kanal"



**Bu nima:** Xuddi shu ro'yxatdan o'tgan ovozli iz (voiceprint) telefon orqali bank xizmatlari, ilova ichidagi ovozli buyruqlar va keyinchalik filial/bankomat o'z-o'ziga xizmat ko'rsatish kiosklarida autentifikatsiyani amalga oshiradi.
**Nega buni o'z-o'zidan sotish mumkin:** Bu shunchaki ichki firibgarlikni nazorat qilish vositasi bo'lishdan to'xtaydi va bank o'z mijozlariga faqat himoya vositasi emas, balki o'ziga xos xususiyat (feature) sifatida sota oladigan parolsiz bank identifikatori mahsulotiga aylanadi.

---

## 6. 4-ustun — Suhbat orqali tijorat va Multimodal (2026-yil 4-chorak – 2027-yil 1-chorak)



### F8. Hujjat va Tasvirlarni Tushunish



**Bu nima:** Mijoz xabarnoma, ko'chirma, sotuvchi kvitansiyasi yoki shartnomani suratga oladi va ko'rish (vision) qobiliyatiga ega modeldan foydalanib, bevosita yozishma ichida u haqida savollar beradi.
**Nega u muhim:** Bu endi 2026 yilda har qanday jiddiy suhbatga asoslangan AI mahsuloti uchun majburiy (table-stakes) UX hisoblanadi — uning yo'qligi, bank raqamli jamoasi bizni sotib olish o'rniga oddiy ChatGPT uslubidagi raqobatchiga ulanish vasvasasiga tushishi mumkin bo'lgan eng ko'zga ko'ringan kamchilikdir.

### F9. WhatsApp Business + Telegram Boy (Rich) Bot UX



**Bu nima:** Tezkor javob tugmalari, kartani muzlatish/muzlatishdan chiqarish boshqaruvlari, balansni tekshirish qisqartmalari — shunchaki eskalatsiya/bildirishnoma kanali emas (bugungi kunda Telegram biz uchun faqat shuni qiladi — faqat jo'natish, hech qachon kiruvchi suhbat emas), balki haqiqiy ikki tomonlama suhbat boti.
**Nega bu g'alaba qozonadi:** "Lekin men yana boshqa ilovani yuklab olishim kerak bo'ladi" degan e'tirozni butunlay olib tashlaydi. Mijozlar bilan kun bo'yi ochiq bo'lgan xabar almashish ilovasida uchrashadi.

---

## 7. 5-ustun — Platforma va B2B himoyasi (2027-yil 1-2-choraklar)



Bu bizning qanday kompaniya ekanligimizni o'zgartiradigan ustundir — har bir bank uchun qayta quradigan loyihadan, bir marta sotib, qirq marta o'lchovni kattalashtiradigan platformagacha.

### F10. Multi-Tenant SaaS Rejimi — *ushbu butun yo'l xaritasidagi eng yuqori darajadagi ta'sirga ega bo'lgan yagona band*

**Bu nima:** Joriy bir bankli ish oqimini haqiqiy ko'p ijarachili (multi-tenant) platformaga aylantirish: Vault-da har bir bank konfiguratsiyasi maydoni (namespace), Supabase-da har bir bank sxemasi yoki qatorlar darajasidagi izolyatsiya, chipta (ticket) yoki tranzaksiya uchun foydalanishga asoslangan hisob-kitob/o'lchov.
**Nega u ustuvor:** Bu yo'l xaritasidagi qolgan har bir xususiyat, agar har bir mijoz uchun alohida tarqatish (deployment) talab qilinmasa, taxminan 40 baravar qimmatroq bo'ladi. Bu "ta'sirchan talaba/tanlov loyihasi" va "sotish mumkin bo'lgan mahsulotga ega kompaniya" o'rtasidagi farqdir.

### F11. Banklararo Firibgarlik Intellekt Tarmog'i



**Bu nima:** REVENANT-ni boshqarayotgan har bir bank bo'ylab anonimlashtirilgan, faqat heshdan iborat umumiy firibgarlik signal hovuzi. A bankida belgilangan dipfeyk (deepfake) ovozli iz yoki firibgarlik naqshi (pattern) daqiqalar ichida B bankiga maxfiylikni saqlovchi ogohlantirishni tarqatadi.
**Nega bu shunchaki xususiyat emas, balki himoya (moat):** Hech bir bank buni yakka o'zi qura olmaydi — bu faqat bitta platformadagi bir nechta ijarachilar bilan ishlaydi. Bu REVENANT-ni tashlab raqobatchiga o'tishni bankning firibgarlik holati uchun *xavfliroq* qilib qo'yadigan xususiyatdir, bu aynan investorlar qidiradigan qaramlik (lock-in) turidir.

### F12. White-Label Rahbariyat Analitikasi Mahsuloti



**Bu nima:** Biz allaqachon SLA ga rioya qilish, har bir chipta (ticket) uchun ROI, AI konsensus ishonchliligi va operatsion chiqindi sifatida siljish (drift) telemetriyasini to'playmiz. Buni bank COO'lari va boshqaruv kengashlari uchun sotiladigan BI paneli (dashboard) sifatida yig'ing — biz shundoq ham ishlab chiqarayotgan ma'lumotlardan olinadigan ikkinchi daromad liniyasi.

### F13. Inson agentlari uchun AI Co-Pilot



**Bu nima:** "Inson aralashuvi" (Human-in-the-Loop) darvozasi hali ham insonga yo'naltiradigan holatlar uchun, u inson agentiga bo'sh chipta (ticket) navbati o'rniga, real vaqtda taklif etilgan javob va kontekst qisqachasi bo'lgan UI ni bering.
**Nega bu sotish uchun muhim:** Bu hatto AI ga avtonom ishlashiga hali tayyor bo'lmagan, xavfdan qochuvchi banklar uchun ham sotiladigan samaradorlik hikoyasidir — biz birinchi kunda shartnomani yutamiz, to'liq avtomatlashtirish keyin keladi.

---

## 8. 6-ustun — Chegara garovlari (imkoniyatli, majburiy emas)



### F14. Steyblkoin hisob-kitobi (Settlement) uchuvchi loyihasi



O'zbekiston 2026-yil yanvar oyida steyblkoinlarni tartibga soluvchi sinov doirasini (sandbox) ochdi. Qisqa muddatli qurilish emas, lekin sinov doirasi ma'qullanishiga ega bo'lgandan so'ng suhbatlashish orqali steyblkoin o'tkazmalarini sinab ko'rishga tayyor bo'lgan bitta homiy bank bilan doimiy munosabatlarni o'rnatishga arziydi — aniq oldinga siljib borayotgan me'yoriy yo'nalish bo'yicha arzon opsion (optionality).

### F15. QMB (Kichik va o'rta biznes) Kreditlash va Savdo moliyasini moliyalashtirish bo'yicha Konsyerj



QMB krediti va savdoni moliyalashtirish ilovalari uchun agentlik onbordingi (onboarding) — hujjat OCR hamda anderrayting nazorat ro'yxati suhbati. F4 ning iste'molchilarni kreditlash oqimi o'z isbotini topgandan so'ng, yo'l xaritasida keyinroq chakana chiptalarni (ticket) kamaytirishdan tashqari, yuqori marjali QMB segmentini ochadi.

---

## 9. Ketma-ketlik mantig'i (nega boshqa emas, aynan shu tartibda)



| Ustuvorlik omili

 | U ishora qiluvchi ustunlar

 |
| --- | --- |
| Qonunchilik oynasi eng tez yopilmoqda

 | 1-ustun (MB tizimi *bu yil* yakunlanmoqda)

 |
| To'g'ridan-to'g'ri raqobatbardosh qarshi zarba

 | 2-ustun (Uzum Nasiyaning aniq zaif tomoni sarmoya emas, qaror qabul qilish tezligidir)

 |
| Hech bir super-ilova nusxalay olmaydigan farq

 | 3-ustun (ovoz/telefon tizimli jihatdan faqat ilova modeliga kirmaydi)

 |
| Majburiy (table-stakes) UX tengligi

 | 4-ustun (umumiy AI chat mahsulotlariga nisbatan bo'shliqni yopadi)

 |
| Biznes-model transformatsiyasi

 | 5-ustun ("loyiha" ni "platforma" ga aylantiradi; 1-2 ustunlar mahsulotning bitta bankda ishlashini isbotlagandan so'ng buni amalga oshiring)

 |
| Tanlash imkoniyati (Optionality)

 | 6-ustun (arzon narxlardagi garovlar, qat'iy muddat yo'q)

 |

---

## 10. Buni haqiqatga aylantirish uchun menga jamoadan nima kerak (bosh direktorning ochiq eslatmasi)



Yo'l xaritasi slaydi arzon turadi; men ularni birovga va'da qilishdan oldin haqiqiy qaramliklarni (dependencies) nomlab o'tmoqchiman:

* **F1/F2** ga MB Open API mavjud bo'lgan zahoti uni sinab ko'rish uchun haqiqiy muhit (sandbox) ma'lumotnomasi kerak — bu bitta bandda biz o'z tezligimizga emas, balki tashqi vaqt jadvaliga bog'liqmiz. API to'liq ommaviy bo'lishidan oldin, Markaziy Bank/tajriba (pilot) banki bilan *hozir* munosabatlarni o'rnatish kerak.


* **F6/F7** o'zbek va rus tillari uchun haqiqiy ASR/TTS ta'minotchisi bo'yicha qaror qabul qilishini talab qiladi (ochiq vaznlar (open-weights) tijoriy API-ga qarshi) — bu yo'l xaritasi bandi emas, balki qurish yoki sotib olish (build-or-buy) tanlovidir va har bir ovozli daqiqa uchun iqtisodiy oqibatlarga ega.


* **F10** xususiyat qo'shilishi emas, muhandislik re-arxitekturasidir — u bitta bankning Vault yo'li va Supabase sxemasini nazarda tutuvchi har bir tugunga ta'sir qiladi. Bu boshqa ustundagi sprint emas, balki o'zining bag'ishlangan ish oqimiga (workstream) munosib.


* **F11** faqatgina 2+ bank mijozlari bo'lgandagina qadr-qimmatga ega — buni biz haqiqatdan ham ikkinchi logotipni yopgandan so'nggina ketma-ketlikka qo'shing.



---

## 11. Ushbu Yo'l xaritasi bizga taqdim etadigan Bir qatorli pitch



"REVENANT V30 sun'iy intellekt bankning qo'llab-quvvatlash navbatini xavfsiz boshqara olishini isbotladi. REVENANT V31 — bu 40 ta bankdan iborat, litsenziyaga ega bo'lgan sektorga 2,3 milliard dollarlik super-ilova bilan raqobatlashish imkonini beruvchi AI qatlami — ularning birortasi ham o'zi super-ilovaga aylanmagan holda."

Bu keyingi investorlar xonasi uchun qator.
