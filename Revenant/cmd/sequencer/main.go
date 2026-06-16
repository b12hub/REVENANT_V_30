// =============================================================================
// cmd/sequencer/main.go
// REVENANT Global Deterministic Control Plane
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================

package main

import (
	"encoding/binary"
	"log"
	"net"
	"os"
	"os/signal"
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"

	// Assuming standard internal path for your Aeron wrapper
	"revenant-gateway/internal/egress"
)

const (
	EnvelopeSize = 512
	ListenAddr   = "127.0.0.1:40122" // Internal Gateway-to-Sequencer channel
)

// Global State
var (
	currentTerm          uint64 = 1
	globalSequenceNumber uint64 = 0 // Starts at 0, pre-increments to 1 on first tx
)

// DirectPublisher defines the Aeron C-Go boundary interface
type DirectPublisher interface {
	PublishRaw(bufPtr unsafe.Pointer, length int32) error
}

func main() {
	// 1. Lock this thread to a single OS core to maximize L1 cache hits
	// and guarantee absolute sequential ordering.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	log.Println("[SEQUENCER] ════════════════════════════════════════════════════════")
	log.Println("[SEQUENCER] BOOTING GLOBAL DETERMINISTIC CONTROL PLANE")

	// 2. Initialize Aeron Publisher
	aeronCfg := egress.DefaultConfig()
	aeronCfg.AeronDir = "/dev/shm/aeron"
	publisher, err := egress.New(aeronCfg)
	if err != nil {
		log.Fatalf("[FATAL] Aeron publisher failed to initialize: %v", err)
	}

	// 3. Open Internal UDP Ingress (Gateway -> Sequencer)
	addr, err := net.ResolveUDPAddr("udp", ListenAddr)
	if err != nil {
		log.Fatalf("[FATAL] Failed to resolve UDP address: %v", err)
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatalf("[FATAL] Failed to bind internal ingress socket: %v", err)
	}
	defer conn.Close()

	// Optimize socket buffers for high-throughput microbursts
	conn.SetReadBuffer(16 * 1024 * 1024)

	log.Printf("[SEQUENCER] Listening for Gateway Intents on %s", ListenAddr)
	log.Println("[SEQUENCER] ────────────────────────────────────────────────────────")

	// Setup Graceful Shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Println("[SEQUENCER] Shutting down...")
		os.Exit(0)
	}()

	// 4. THE HOT LOOP (Zero-Allocation)
	// We pre-allocate a single 512-byte buffer. Since this loop is strictly
	// sequential, we reuse this exact memory address for every transaction.
	buf := make([]byte, EnvelopeSize)

	for {
		// Read raw pre-formatted payload from Gateway
		n, err := conn.Read(buf)
		if err != nil || n != EnvelopeSize {
			log.Printf("[SEQUENCER] ⚠️ Dropped packet. Expected %d bytes, got %d. Err: %v", EnvelopeSize, n, err)
			continue
		}

		// Atomically acquire the next GSN and current Term
		gsn := atomic.AddUint64(&globalSequenceNumber, 1)
		term := atomic.LoadUint64(&currentTerm)

		// INJECT THE DICTATOR'S STATE
		// The Gateway left [0:16] empty. We pack the 64-bit integers in Little Endian.
		binary.LittleEndian.PutUint64(buf[0:8], term)
		binary.LittleEndian.PutUint64(buf[8:16], gsn)

		// BLAST TO EXECUTION CORES
		// We pass the absolute memory pointer to the C-Go Aeron bridge.
		pubErr := publisher.PublishRaw(unsafe.Pointer(&buf[0]), int32(EnvelopeSize))
		if pubErr != nil {
			// In a production Tier-0 system, if the Sequencer cannot reach Aeron,
			// it should trigger a massive alert or circuit break. For now, we log.
			log.Printf("[SEQUENCER] 🛑 FATAL: Aeron Drop at GSN %d: %v", gsn, pubErr)
		}
	}
}
