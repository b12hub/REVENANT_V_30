#!/bin/bash

echo "[*] Hunting down zombie processes..."
pkill -f MediaDriver
pkill -f revenant-engine

echo "[*] Formatting Shared Memory (/dev/shm/aeron-rust)..."
rm -rf /dev/shm/aeron-rust
mkdir -p /dev/shm/aeron-rust
chmod 777 /dev/shm/aeron-rust

echo "[*] Igniting Aeron Media Driver (Background)..."
java \
  --add-opens java.base/sun.nio.ch=ALL-UNNAMED \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  --add-opens java.base/java.lang.reflect=ALL-UNNAMED \
  --add-opens java.base/java.util.zip=ALL-UNNAMED \
  -Daeron.dir=/dev/shm/aeron-rust \
  -cp aeron-all.jar \
  io.aeron.driver.MediaDriver &

echo "[*] Waiting 3 seconds for memory allocation..."
sleep 3

if [ -f "/dev/shm/aeron-rust/cnc.dat" ]; then
    echo "[SUCCESS] Memory lockfile (cnc.dat) verified!"
else
    echo "[FATAL] Aeron failed to allocate memory. Check Java."
    exit 1
fi

echo "[*] Booting the Iron Vault (Rust LMAX Engine)..."
cd revenant-engine
cargo run --release --bin revenant-engine
