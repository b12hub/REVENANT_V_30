package aeronpub

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"log"
	"time"

	"github.com/lirm/aeron-go/aeron"
	"github.com/lirm/aeron-go/aeron/atomic"
)

const (
	Channel         = "aeron:udp?endpoint=127.0.0.1:40123"
	StreamID        = int32(1001)
	EnvelopeSize    = 512
	PayloadOffset   = 88
	SignatureOffset = 128 // <--- NEW: Where we put the 64-byte signature
)

type Publisher struct {
	aeronCtx   *aeron.Context
	aeron      *aeron.Aeron
	pub        *aeron.Publication
	privateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey // Exported so main.go can print it for Rust
}

func NewPublisher(aeronDir string) (*Publisher, error) {
	// Generate Ephemeral Zero-Trust Keypair
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate ed25519 key: %w", err)
	}

	aeronCtx := aeron.NewContext().AeronDir(aeronDir)
	a, err := aeron.Connect(aeronCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to aeron: %w", err)
	}

	pub, err := a.AddPublication(Channel, StreamID)
	if err != nil {
		return nil, fmt.Errorf("failed to add publication: %w", err)
	}

	log.Printf("[AERON] Publisher LIVE | Channel: %s | Stream: %d", Channel, StreamID)
	log.Printf("[SECURITY] Zero-Trust Ed25519 Key Generated.")

	return &Publisher{
		aeronCtx:   aeronCtx,
		aeron:      a,
		pub:        pub,
		privateKey: privKey,
		PublicKey:  pubKey,
	}, nil
}

func (p *Publisher) Publish(payload []byte) error {
	if len(payload) != 32 {
		return fmt.Errorf("CRITICAL ABI MISMATCH: Payload is %d bytes, expected 32", len(payload))
	}

	frame := make([]byte, EnvelopeSize)

	// Mocking the Header
	frame[0] = 0x01 // Version
	frame[1] = 0x18 // Flags (Mock PoW + Signature Valid)

	// Inject 8-byte Timestamp at offset 8 (UNIX Epoch Nanoseconds)
	binary.LittleEndian.PutUint64(frame[8:16], uint64(time.Now().UnixNano()))

	// Embed the 32-byte payload
	copy(frame[PayloadOffset:], payload)

	// ─── NEW: CRYPTOGRAPHIC SIGNING ──────────────────────────────
	// Sign the 32-byte payload using Go's private key
	signature := ed25519.Sign(p.privateKey, payload)

	// Embed the 64-byte signature at offset 128
	copy(frame[SignatureOffset:], signature)
	// ─────────────────────────────────────────────────────────────

	buffer := atomic.MakeBuffer(frame)

	for retries := 0; retries < 3; retries++ {
		result := p.pub.Offer(buffer, 0, int32(len(frame)), nil)
		if result > 0 {
			return nil
		}
		if result == aeron.NotConnected {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		if result == aeron.BackPressured {
			time.Sleep(1 * time.Millisecond)
			continue
		}
	}

	return fmt.Errorf("aeron offer failed: subscriber disconnected or severe backpressure")
}

func (p *Publisher) Close() {
	if p.pub != nil {
		p.pub.Close()
	}
	if p.aeron != nil {
		p.aeron.Close()
	}
}
