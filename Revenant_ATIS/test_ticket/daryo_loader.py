import json
import random
import time

# --- CONFIGURATION ---
TARGET_COUNT = 500
OUTPUT_FILE = "daryo_tickets.json"

# --- DATA POOLS (Real Uzbek Context) ---
SUBJECTS = [
    "Payme ilovasida xatolik", "Click orqali to'lov o'tmadi", "Humo kartam bloklandi",
    "Uzcard sms kelmayapti", "Ipoteka krediti foizlari", "Dollar kursi qancha",
    "Avtokredit shartlari", "MyID identifikatsiya ishlamayapti", "Elektr energiyasi to'lovi",
    "Gaz hisoblagich raqami", "Internet tezligi past", "Wi-Fi router sozlash",
    "Uztelecom tariflari", "Beeline aloqa sifati", "Ucell megabayt qolmagan",
    "Mobiuz balansni tekshirish", "Soliq to'lovchining kabineti", "Yagona darcha xizmatlari",
    "Propiska masalasi", "Pasport almashtirish", "Haydovchilik guvohnomasi",
    "Jarimani to'lash", "MIB qarzdorlik", "Pensiya kartasi ochish",
    "Talabalar krediti", "Kontrakt to'lovi", "Stipendiya tushmadi"
]

NAMES = ["Nodir", "Malika", "Jamshid", "Aziza", "Jasur", "Dilnoza", "Otabek", "Shahnoza", "Farhod", "Gulnoza", "Sardor",
         "Nargiza"]
LASTNAMES = ["Aliyev", "Karimova", "Rahimov", "Abdullayeva", "Tursunov", "Ismoilova", "Rustamov", "Yusupova"]
DOMAINS = ["gmail.com", "mail.ru", "yandex.uz", "list.ru", "bk.ru"]


def generate_ticket(idx):
    subject = random.choice(SUBJECTS)
    name = random.choice(NAMES)
    lastname = random.choice(LASTNAMES)
    email = f"{name.lower()}.{lastname.lower()}{random.randint(1980, 2005)}@{random.choice(DOMAINS)}"

    # 10% Chance of High Risk Keywords to test AI
    if random.random() < 0.1:
        subject += " (Pulim yo'qoldi / Moshenniklar)"

    return {
        "body": {
            "subject": subject,
            "body": f"Assalomu alaykum. {subject} bo'yicha muammo bo'lyapti. Iltimos yordam bering. ID: {idx}",
            "customer_email": email,
            "generated_source": "synthetic_loader_v1"
        }
    }


print(f"🚀 GENERATING {TARGET_COUNT} SYNTHETIC TICKETS...")

tickets = [generate_ticket(i) for i in range(TARGET_COUNT)]

with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    json.dump(tickets, f, ensure_ascii=False, indent=2)

print(f"✅ SUCCESS: Generated {len(tickets)} tickets into '{OUTPUT_FILE}'")