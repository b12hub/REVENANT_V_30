// =============================================================================
// internal/frame/envelope.go
// REVENANT Gateway — Fixed 512-Byte Transaction Envelope Frame
// =============================================================================

package frame

import (
	"fmt"
	"unsafe"
)

const (
	envelopeWireSize   = 512
	VersionCurrent     = uint16(0x0003)
	PayloadFieldSize   = 352
	SignatureFieldSize = 64
)

type EnvelopeFlags = uint16

const (
	FlagHighValue      EnvelopeFlags = 1 << 0
	FlagCrossBorder    EnvelopeFlags = 1 << 1
	FlagIsRetry        EnvelopeFlags = 1 << 2
	FlagSignatureValid EnvelopeFlags = 1 << 3
	FlagPoWVerified    EnvelopeFlags = 1 << 4
)

type TransactionEnvelope struct {
	Version   uint16
	Flags     uint16
	_pad0     [4]byte
	Timestamp uint64
	Nonce     uint64
	Sender    [32]byte
	Receiver  [32]byte
	Payload   [PayloadFieldSize]byte
	Signature [SignatureFieldSize]byte
	_pad1     [8]byte
}

func init() {
	if got := unsafe.Sizeof(TransactionEnvelope{}); got != envelopeWireSize {
		panic(fmt.Sprintf(
			"SOVEREIGN INVARIANT VIOLATED: TransactionEnvelope size is %d bytes, "+
				"expected %d bytes. Do not deploy.", got, envelopeWireSize,
		))
	}
}

func NewEnvelope() *TransactionEnvelope {
	e := &TransactionEnvelope{}
	e.Version = VersionCurrent
	return e
}

//go:nosplit
func (e *TransactionEnvelope) Serialize() []byte {
	return unsafe.Slice((*byte)(unsafe.Pointer(e)), envelopeWireSize)
}

func (e *TransactionEnvelope) Reset() {
	*e = TransactionEnvelope{}
	e.Version = VersionCurrent
}

//go:inline
func (e *TransactionEnvelope) HasFlag(f EnvelopeFlags) bool {
	return e.Flags&f != 0
}

//go:inline
func (e *TransactionEnvelope) SetFlag(f EnvelopeFlags) {
	e.Flags |= f
}

//go:inline
func (e *TransactionEnvelope) ClearFlag(f EnvelopeFlags) {
	e.Flags &^= f
}
