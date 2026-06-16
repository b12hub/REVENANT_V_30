package icde

import (
	"crypto/ed25519"
	"errors"
)

var ErrInvalidKey = errors.New("icde: invalid ed25519 private key")

// IntentSigner holds the cryptographic material required to authorize the payload
// for the Rust execution core.
type IntentSigner struct {
	privKey ed25519.PrivateKey
}

// NewIntentSigner initializes the signer. In production, this key must be
// injected via a secure enclave or KMS, never hardcoded.
func NewIntentSigner(key ed25519.PrivateKey) (*IntentSigner, error) {
	if len(key) != ed25519.PrivateKeySize {
		return nil, ErrInvalidKey
	}
	return &IntentSigner{privKey: key}, nil
}

// Sign payload signs the mathematically stable 32-byte hash.
// This signature proves to the Rust core that the intent survived the Go
// validation layer untampered.
func (s *IntentSigner) Sign(intentHash [32]byte) []byte {
	// Standard library allocates 64 bytes here.
	// This is an acceptable trade-off for utilizing heavily audited crypto routines.
	return ed25519.Sign(s.privKey, intentHash[:])
}
