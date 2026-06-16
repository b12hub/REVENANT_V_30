package icde

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sync"
)

// ActionType represents the bounded set of allowed operations.
type ActionType uint8

const (
	ActionTransfer ActionType = iota + 1
	ActionPayBill
	ActionCardBlock
)

// ResolvedAction is the mathematically locked struct ready for hashing.
type ResolvedAction struct {
	Action   ActionType
	Sender   AccountID
	Receiver AccountID
	Amount   uint64 // Strict u64. No floats allowed in the vault.
	Nonce    uint64 // Deduplication nonce from the gateway.
}

// bufferPool ensures zero-allocation byte slice management for hashing.
var bufferPool = sync.Pool{
	New: func() interface{} {
		// 33 bytes per action: 1 (Action) + 4 (Sender) + 4 (Receiver) + 8 (Amount) + 8 (Nonce) = 25 bytes.
		// Allocating 64 bytes to allow for small batch operations without resizing.
		b := make([]byte, 0, 64)
		return &b
	},
}

var ErrEmptyIntent = errors.New("icde: cannot canonicalize empty intent array")

// CanonicalizeIntent takes the resolved actions, packs them deterministically,
// and outputs the exact 32-byte hash required by the Rust core's Disruptor.
func CanonicalizeIntent(actions []ResolvedAction) ([32]byte, error) {
	if len(actions) == 0 {
		return [32]byte{}, ErrEmptyIntent
	}

	// Retrieve a pre-allocated buffer from the pool
	bufPtr := bufferPool.Get().(*[]byte)
	buf := (*bufPtr)[:0] // Reset length to 0, keep capacity

	defer func() {
		bufferPool.Put(bufPtr)
	}()

	// Deterministic Binary Packing
	// We avoid JSON keys entirely. The Rust Disruptor will verify this exact binary layout.
	// Layout per action: [ActionType (1 byte)][Sender (4 bytes)][Receiver (4 bytes)][Amount (8 bytes)][Nonce (8 bytes)]
	for _, act := range actions {
		buf = append(buf, byte(act.Action))

		buf = binary.LittleEndian.AppendUint32(buf, uint32(act.Sender))
		buf = binary.LittleEndian.AppendUint32(buf, uint32(act.Receiver))
		buf = binary.LittleEndian.AppendUint64(buf, act.Amount)
		buf = binary.LittleEndian.AppendUint64(buf, act.Nonce)
	}

	// Produce the final 32-byte intent hash
	// sha256.Sum256 allocates nothing on the heap; it returns an array by value.
	return sha256.Sum256(buf), nil
}
