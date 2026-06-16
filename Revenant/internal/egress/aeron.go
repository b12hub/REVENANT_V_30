// =============================================================================
// internal/egress/aeron.go
// REVENANT Gateway — Aeron UDP Multicast Egress Publisher (Sprint 3: LIVE)
// =============================================================================

package egress

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync/atomic"
	"time"
	"unsafe" // Added for pointer cast

	"github.com/lirm/aeron-go/aeron"
	aeronatomic "github.com/lirm/aeron-go/aeron/atomic"
	"github.com/lirm/aeron-go/aeron/logbuffer"

	"revenant-gateway/internal/frame"
)

const (
	PublicationChannel = "aeron:udp?endpoint=127.0.0.1:40123"
	StreamID           = int32(1001)
	aeronDir           = "/dev/shm/aeron-go"
	maxOfferRetries    = 50
	connectTimeout     = 10 * time.Second
)

var (
	ErrAeronNotConnected  = errors.New("aeron: publication has no connected subscribers")
	ErrAeronBackPressured = errors.New("aeron: ring buffer back-pressured after max retries")
	ErrAeronClosed        = errors.New("aeron: publication channel closed")
	ErrAeronMaxPosition   = errors.New("aeron: max stream position exceeded")
	ErrEnvelopeNil        = errors.New("aeron: cannot dispatch nil TransactionEnvelope")
)

type AeronPublisher struct {
	publication *aeron.Publication
	aeronClient *aeron.Aeron
	sequencer   atomic.Uint64
	channel     string
	streamID    int32
}

type AeronConfig struct {
	Channel  string
	StreamID int32
	AeronDir string
}

func DefaultConfig() AeronConfig {
	return AeronConfig{
		Channel:  PublicationChannel,
		StreamID: StreamID,
		AeronDir: aeronDir,
	}
}

func New(cfg AeronConfig) (*AeronPublisher, error) {
	if cfg.Channel == "" {
		cfg.Channel = PublicationChannel
	}
	if cfg.StreamID <= 0 {
		cfg.StreamID = StreamID
	}
	if cfg.AeronDir == "" {
		cfg.AeronDir = aeronDir
	}

	log.Printf("[AERON] Connecting to Media Driver at %s", cfg.AeronDir)

	ctx := aeron.NewContext().
		AeronDir(cfg.AeronDir).
		MediaDriverTimeout(connectTimeout)

	a, err := aeron.Connect(ctx)
	if err != nil {
		return nil, fmt.Errorf("aeron: failed to connect to Media Driver at %s: %w", cfg.AeronDir, err)
	}

	log.Printf("[AERON] Connected. Creating publication on channel: %s stream: %d", cfg.Channel, cfg.StreamID)

	pub, err := a.AddPublication(cfg.Channel, cfg.StreamID)
	if err != nil {
		return nil, fmt.Errorf("aeron: AddPublication failed: %w", err)
	}
	if pub == nil {
		return nil, errors.New("aeron: AddPublication returned nil publication")
	}

	log.Printf("[AERON] Publication created. Waiting for Rust subscriber on stream %d...", cfg.StreamID)

	deadline := time.Now().Add(connectTimeout)
	for !pub.IsConnected() {
		if time.Now().After(deadline) {
			_ = pub.Close()
			_ = a.Close()
			return nil, fmt.Errorf("aeron: timed out waiting for Rust subscriber")
		}
		runtime.Gosched()
	}

	log.Printf("[AERON] Rust subscriber connected. AeronPublisher is LIVE.")

	p := &AeronPublisher{
		publication: pub,
		aeronClient: a,
		channel:     cfg.Channel,
		streamID:    cfg.StreamID,
	}

	p.sequencer.Store(0)

	return p, nil
}

// PublishRaw bridges the new Phase F IPC envelopes into the Sprint 3 Aeron Publisher
func (p *AeronPublisher) PublishRaw(bufPtr unsafe.Pointer, length int32) error {
	var srcBuffer aeronatomic.Buffer
	srcBuffer.Wrap(bufPtr, length)

	var pos int64
	for attempt := 0; attempt <= maxOfferRetries; attempt++ {
		pos = p.publication.Offer(&srcBuffer, 0, length, nil)

		if pos >= 0 {
			return nil
		}

		switch pos {
		case aeron.NotConnected:
			return ErrAeronNotConnected
		case aeron.BackPressured, aeron.AdminAction:
			runtime.Gosched()
		case aeron.PublicationClosed:
			return ErrAeronClosed
		default:
			return ErrAeronMaxPosition
		}
	}

	return ErrAeronBackPressured
}

func (p *AeronPublisher) Dispatch(env *frame.TransactionEnvelope) error {
	if env == nil {
		return ErrEnvelopeNil
	}

	env.Nonce = p.sequencer.Add(1)
	env.Timestamp = uint64(time.Now().UnixNano())

	buf := env.Serialize()

	// FIX: Aeron's Wrap expects a raw memory pointer and an int32 capacity.
	// We pass the memory address of the first byte of our 512-byte array.
	var srcBuffer aeronatomic.Buffer
	srcBuffer.Wrap(unsafe.Pointer(&buf[0]), int32(len(buf)))

	var pos int64
	for attempt := 0; attempt <= maxOfferRetries; attempt++ {
		pos = p.publication.Offer(&srcBuffer, 0, int32(len(buf)), nil)

		if pos >= 0 {
			return nil
		}

		switch pos {
		case aeron.NotConnected:
			return ErrAeronNotConnected
		case aeron.BackPressured, aeron.AdminAction:
			runtime.Gosched()
		case aeron.PublicationClosed:
			return ErrAeronClosed
		default:
			return ErrAeronMaxPosition
		}
	}

	return ErrAeronBackPressured
}

func (p *AeronPublisher) Close() error {
	if p.publication != nil {
		p.publication.Close()
	}
	if p.aeronClient != nil {
		p.aeronClient.Close()
	}
	return nil
}

func (p *AeronPublisher) IsConnected() bool {
	return p.publication != nil && p.publication.IsConnected()
}

func (p *AeronPublisher) Channel() string         { return p.channel }
func (p *AeronPublisher) StreamID() int32         { return p.streamID }
func (p *AeronPublisher) CurrentSequence() uint64 { return p.sequencer.Load() }

func fragmentHandler(buffer *aeronatomic.Buffer, offset int32, length int32, header *logbuffer.Header) {
}
