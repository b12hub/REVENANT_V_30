package ipc

import (
	"encoding/binary"
	"errors"
	"sync"
	"time"
)

const EnvelopeSize = 512

// EnvelopeBuffer is our fixed-size C-struct equivalent.
type EnvelopeBuffer [EnvelopeSize]byte

var ErrInvalidSignature = errors.New("ipc: invalid signature length, expected 64 bytes")

// envelopePool ensures we do not pressure the garbage collector with 512-byte allocations
// during high-frequency trading bursts.
var envelopePool = sync.Pool{
	New: func() interface{} {
		var b EnvelopeBuffer
		return &b
	},
}

// TransactionPrimitives represents the raw execution data needed by the Rust engine.
type TransactionPrimitives struct {
	Sender   uint32
	Receiver uint32
	Amount   uint64
	Nonce    uint64
	Action   uint8 // NEW: ActionType added to match Rust mutator expectations
}

// PackEnvelope constructs the strict 512-byte payload for Aeron UDP/Shm.
// Layout:
// [0:32]   Intent Hash
// [32:96]  Ed25519 Signature
// [96:104] TTL Timestamp (Unix Nano)
// [104:108] Sender AccountID
// [108:112] Receiver AccountID
// [112:120] Amount
// [120:128] Nonce
// [128:129] Action Type (u8)
// [129:512] Explicit Zero Padding (Padding Oracle Mitigation)

func PackEnvelope(
	intentHash [32]byte,
	signature []byte,
	primitives TransactionPrimitives,
) (*EnvelopeBuffer, error) {

	if len(signature) != 64 {
		return nil, ErrInvalidSignature
	}

	// 1. Acquire envelope from pool
	env := envelopePool.Get().(*EnvelopeBuffer)

	// 2. CRITICAL: Prevent Padding Oracle Exploit.
	// We explicitly zero out the entire array.
	*env = EnvelopeBuffer{}

	// [0:16] is INTENTIONALLY LEFT BLANK for the Global Sequencer to inject (Term + GSN)

	// 3. Write Intent Hash (32 bytes) - Shifted to 16
	copy(env[16:48], intentHash[:])

	// 4. Write Signature (64 bytes) - Shifted to 48
	copy(env[48:112], signature)

	// 5. Write TTL Timestamp (8 bytes) - Shifted to 112
	ttlTimestamp := uint64(time.Now().UnixNano())
	binary.LittleEndian.PutUint64(env[112:120], ttlTimestamp)

	// 6. Write Primitives (Strictly aligned to 4 and 8 byte boundaries)
	binary.LittleEndian.PutUint32(env[120:124], primitives.Sender)
	binary.LittleEndian.PutUint32(env[124:128], primitives.Receiver)
	binary.LittleEndian.PutUint64(env[128:136], primitives.Amount)
	binary.LittleEndian.PutUint64(env[136:144], primitives.Nonce)

	// 7. Write Action Type (1 byte) - Shifted to 144
	env[144] = primitives.Action

	// Remaining bytes [145:512] are already guaranteed to be 0x00 due to step 2.

	return env, nil
}

// ReleaseEnvelope must be called after the Aeron driver has successfully
// copied the bytes to the IPC ring buffer.
func ReleaseEnvelope(env *EnvelopeBuffer) {
	envelopePool.Put(env)
}
