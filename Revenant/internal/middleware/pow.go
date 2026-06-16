// =============================================================================
// internal/middleware/pow.go
// REVENANT Gateway — Layer 3: Stateless Proof-of-Work Token Gate
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// RED TEAM THREAT VECTOR ADDRESSED: ASYMMETRIC RESOURCE EXHAUSTION (Crypto-DoS)
//
//   Without this layer, Ed25519 verification costs ~60µs/request on the
//   gateway, but costs the attacker ~0µs to forge.
//   The PoW shield inverts the asymmetry completely:
//
//     16-bit difficulty → attacker must average 2^16 = 65,536 SHA256 hashes
//     Attacker CPU cost per valid request: ~8ms
//     Gateway verification cost:           ~80ns
//     Defense asymmetry ratio:             100,000:1
//
// =============================================================================

package middleware

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"

	"github.com/valyala/fasthttp"
)

const (
	powNonceSize           = 8
	powNonceHexSize        = powNonceSize * 2                    // 16
	powCombinedSize        = ed25519PublicKeySize + powNonceSize // 40
	powDifficultyZeroBytes = 2
	PowVerifiedKey = "pow_verified"
)


var powNonceHeaderKey = []byte("X-Proof-Of-Work")

// PoWMiddleware enforces a Layer 3 stateless cryptographic challenge.
func PoWMiddleware(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		// Step 1 & 2: Extract headers — zero copy, zero allocation.
		rawPubHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(publicKeyHeaderKey))
		rawNonceHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(powNonceHeaderKey))

		// Step 3: O(1) length pre-validation.
		if len(rawPubHex) != ed25519PublicKeyHexSize || len(rawNonceHex) != powNonceHexSize {
			writeUnauthorized(ctx) // Re-using standard 401 drop
			return
		}

		// Step 4: Declare stack-allocated decode arrays (Zero GC Escape).
		var pubBytes [ed25519PublicKeySize]byte
		var nonceBytes [powNonceSize]byte
		var combined [powCombinedSize]byte

		// Step 5 & 6: Hex-decode headers into stack arrays.
		n, err := hex.Decode(pubBytes[:], rawPubHex)
		if err != nil || n != ed25519PublicKeySize {
			writeUnauthorized(ctx)
			return
		}

		n, err = hex.Decode(nonceBytes[:], rawNonceHex)
		if err != nil || n != powNonceSize {
			writeUnauthorized(ctx)
			return
		}

		// Step 7: Construct the SHA256 pre-image on the stack.
		copy(combined[:ed25519PublicKeySize], pubBytes[:])
		copy(combined[ed25519PublicKeySize:], nonceBytes[:])

		// Step 8: Compute SHA256 of the combined pre-image (Zero heap allocation).
		hash := sha256.Sum256(combined[:])

		// Step 9: Difficulty check — verify leading zero bytes.
		for i := 0; i < powDifficultyZeroBytes; i++ {
			if hash[i] != 0x00 {
				writeUnauthorized(ctx)
				return
			}
		}

		// Step 10: PoW cleared. Inject cryptographic proof into context.
        ctx.SetUserValue(PowVerifiedKey, true)
		next(ctx)
	}
}
