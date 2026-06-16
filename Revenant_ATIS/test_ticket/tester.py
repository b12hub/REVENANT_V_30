import json
import asyncio
import aiohttp
import random
import time
from datetime import datetime

# --- CONFIGURATION ---
WEBHOOK_URL = "https://notheroeb.app.n8n.cloud/webhook/f860224a-492d-454b-b3dc-0970fa48ad3a"
FILE_PATH = "ticket.json"

# --- SAFE MODE CONFIGURATION ---
# We force sequential processing (1 at a time) to confirm server health
CONCURRENCY_LIMIT = 1
BATCH_DELAY = 1.0  # 1 second pause between tickets to let server breathe

# --- METADATA POOLS ---
SEVERITIES = ["low", "medium", "high", "critical"]
PRIORITIES = ["low", "medium", "high"]
CATEGORIES = ["financial", "technical", "access", "general", "compliance"]


async def send_ticket(session, ticket, idx):
    raw_body = ticket.get("body", {})
    payload = {
        "subject": raw_body.get("subject"),
        "body": raw_body.get("body"),
        "customer_email": raw_body.get("customer_email"),
        "severity": random.choice(SEVERITIES),
        "priority": random.choice(PRIORITIES),
        "category": random.choice(CATEGORIES),
        "executionMode": "test",
        "timestamp": datetime.now().isoformat()
    }

    print(f"⏳ [Ticket #{idx + 1}] Sending...", end="\r")

    try:
        # Increase timeout to 30s just in case the queue is deep
        timeout = aiohttp.ClientTimeout(total=30)
        async with session.post(WEBHOOK_URL, json=payload, timeout=timeout) as response:
            status = response.status
            if status == 200:
                print(f"✅ [Ticket #{idx + 1}] SENT | {payload['customer_email']} | 200 OK   ")
                return True
            else:
                print(f"❌ [Ticket #{idx + 1}] FAIL | Status: {status}                         ")
                return False
    except Exception as e:
        print(f"🔥 [Ticket #{idx + 1}] ERROR | {str(e)}")
        return False


async def main():
    try:
        with open(FILE_PATH, 'r', encoding='utf-8') as f:
            tickets = json.load(f)
    except FileNotFoundError:
        print("Error: File not found.")
        return

    print(f"🚀 INITIALIZING SAFE-MODE INJECTION: {len(tickets)} TICKETS")
    print(f"🎯 TARGET: {WEBHOOK_URL}")
    print(f"⚡ SPEED: Sequential (1 by 1) | {BATCH_DELAY}s delay")
    print("-" * 60)

    async with aiohttp.ClientSession() as session:
        success_count = 0
        for idx, ticket in enumerate(tickets):
            # STRICT SEQUENTIAL EXECUTION
            success = await send_ticket(session, ticket, idx)
            if success:
                success_count += 1
            else:
                # If we hit a 524/500, wait longer before trying next
                print("⚠️ Server struggling. Pausing for 5 seconds...")
                await asyncio.sleep(5)

            # Normal throttle
            await asyncio.sleep(BATCH_DELAY)

    print("-" * 60)
    print(f"🏁 MISSION COMPLETE | Successful: {success_count}/{len(tickets)}")


if __name__ == "__main__":
    asyncio.run(main())