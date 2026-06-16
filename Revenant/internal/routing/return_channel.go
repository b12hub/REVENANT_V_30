package routing

import (
	"errors"
	"log"
	"net"
	"sync"
)

var (
	ErrTimeout           = errors.New("routing: 504 gateway timeout, Rust core did not acknowledge")
	ErrInsufficientFunds = errors.New("mutator: 400 bad request, insufficient funds")
	ErrAccountBlocked    = errors.New("mutator: 403 forbidden, account is blocked")
	ErrLedgerFault       = errors.New("mutator: 500 internal server error, ledger fault")
)

const NumShards = 256
const AcknowledgmentSize = 33 // 32 bytes hash + 1 byte status

// Promise is a buffered channel to prevent the Aeron network thread from blocking
type Promise chan error

type RegistryShard struct {
	mu       sync.RWMutex
	promises map[[32]byte]Promise
}

type ReturnRegistry struct {
	shards [NumShards]*RegistryShard
}

func NewReturnRegistry() *ReturnRegistry {
	r := &ReturnRegistry{}
	for i := 0; i < NumShards; i++ {
		r.shards[i] = &RegistryShard{
			promises: make(map[[32]byte]Promise),
		}
	}
	return r
}

func (r *ReturnRegistry) getShard(hash [32]byte) *RegistryShard {
	return r.shards[hash[0]]
}

func (r *ReturnRegistry) RegisterPromise(hash [32]byte, p Promise) {
	shard := r.getShard(hash)
	shard.mu.Lock()
	shard.promises[hash] = p
	shard.mu.Unlock()
}

func (r *ReturnRegistry) RemovePromise(hash [32]byte) {
	shard := r.getShard(hash)
	shard.mu.Lock()
	delete(shard.promises, hash)
	shard.mu.Unlock()
}

// =========================================================================
// NATIVE UDP EGRESS LAYER (Local Dev Bridge)
// =========================================================================

// StartUDPListener boots a background goroutine to catch Rust ACKs over standard UDP.
func (r *ReturnRegistry) StartUDPListener(addr string) {
	go func() {
		udpAddr, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			log.Fatalf("[RETURN CHANNEL] FATAL: Cannot resolve UDP address: %v", err)
		}
		conn, err := net.ListenUDP("udp", udpAddr)
		if err != nil {
			log.Fatalf("[RETURN CHANNEL] FATAL: Cannot start UDP listener: %v", err)
		}
		defer conn.Close()

		log.Printf("[RETURN CHANNEL] LIVE. Listening for Rust ACKs on %s", addr)

		buffer := make([]byte, 1024)
		for {
			n, _, err := conn.ReadFromUDP(buffer)
			if err != nil {
				log.Printf("[RETURN CHANNEL] Read error: %v", err)
				continue
			}

			if n < AcknowledgmentSize {
				continue // Ignore malformed frames
			}

			// Extract Payload
			var hash [32]byte
			copy(hash[:], buffer[0:32])
			statusCode := buffer[32]

			log.Printf("[RETURN CHANNEL] ⚡ ACK Received | Status: %d", statusCode)

			// Resolve the Promise
			r.resolve(hash, statusCode)
		}
	}()
}

func (r *ReturnRegistry) resolve(hash [32]byte, statusCode uint8) {
	shard := r.getShard(hash)

	shard.mu.RLock()
	p, exists := shard.promises[hash]
	shard.mu.RUnlock()

	if !exists {
		log.Printf("[RETURN CHANNEL] ⚠️ Orphaned ACK dropped (Promise already resolved or timed out)")
		return
	}

	var err error
	switch statusCode {
	case 0:
		err = nil // SUCCESS
	case 1:
		err = ErrInsufficientFunds
	case 2:
		err = ErrAccountBlocked
	default:
		err = ErrLedgerFault
	}

	select {
	case p <- err:
	default:
	}
}
