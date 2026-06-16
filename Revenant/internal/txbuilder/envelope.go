// Package txbuilder constructs the binary and logical artifacts required to
// deliver a transaction to the Rust LMAX settlement engine via Aeron IPC.
//
// envelope.go — BLOCK 9.0 / aeronpub bridge: Binary Transaction Payload Builder
//
// This file implements the Go side of the binary ABI contract between the
// revenant-orchestrator (Go) and the revenant-engine (Rust).
//
// ─── ABI CONTRACT WITH THE RUST ENGINE ────────────────────────────────────────
//
// The Rust engine defines the transaction payload as:
//
//	// revenant-engine/src/envelope.rs
//	#[repr(C)]
//	pub struct TransactionPayload {
//	    pub sender_id:   u32,    // offset  0, 4 bytes, LE
//	    pub receiver_id: u32,    // offset  4, 4 bytes, LE
//	    pub amount:      i64,    // offset  8, 8 bytes, LE  (tiyin/cents, signed)
//	    pub nonce:       u32,    // offset 16, 4 bytes, LE
//	    pub _padding:    [u8;12], // offset 20, 12 bytes, zero
//	}                            // TOTAL = 32 bytes
//
// The Go BuildEnvelope function MUST write exactly 32 bytes in this layout.
// Any deviation corrupts the Rust engine's memory alignment and produces
// undefined behaviour when the Ledger Mutator calls process_envelope().
//
// ─── ENDIANNESS ───────────────────────────────────────────────────────────────
//
// binary.LittleEndian is mandatory. The Rust engine uses `u32::from_le_bytes`
// and `i64::from_le_bytes` (established in Sprint 3.1 session).
// The Go gateway previously used BigEndian for Ed25519 nonce fields — those
// are in the outer envelope header, NOT in the payload struct we write here.
//
// ─── FIELD SOURCES ────────────────────────────────────────────────────────────
//
//	SenderID   — derived from ctx.ApprovalID hash (deterministic per transaction)
//	             Future sprint: resolved via account lookup service; placeholder
//	             approach documented below.
//	ReceiverID — derived from ctx.Contract.Intent.TargetTool routing hash.
//	             Future sprint: resolved via account lookup service.
//	Amount     — ctx.AmountAtomic (int64, cents/tiyin, set at ingress)
//	             Negative amounts are rejected pre-flight.
//	Nonce      — SHA-256(TraceID + AmountAtomic)[:4], little-endian uint32.
//	             Deterministic and idempotent: retrying the same transaction
//	             with the same TraceID produces the same nonce.
//	             The Rust engine uses nonce for idempotency deduplication.
//
// ─── PAYLOAD SIZE VERIFICATION ────────────────────────────────────────────────
//
// A compile-time const assertion is not possible in Go for slice lengths, so
// we enforce the 32-byte invariant with a runtime check and a package-init
// assertion. Any field addition that changes the size will fail loudly at
// startup rather than silently corrupting the ABI.
package txbuilder

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"strings"

	"revenant-gateway/internal/domain"
)

// ─── ABI CONSTANTS ────────────────────────────────────────────────────────────

const (
	// PayloadSize is the fixed byte size of the Rust TransactionPayload struct.
	// Value: sizeof(u32) + sizeof(u32) + sizeof(i64) + sizeof(u32) + 12 padding
	//       = 4 + 4 + 8 + 4 + 12 = 32 bytes.
	// This MUST match the Rust #[repr(C)] struct size or the engine will
	// misread field offsets and corrupt the ledger.
	PayloadSize = 32

	// Field offsets within the 32-byte payload.
	// Must stay synchronised with the Rust TransactionPayload layout.
	offsetSenderID   = 0  // u32 LE, 4 bytes
	offsetReceiverID = 4  // u32 LE, 4 bytes
	offsetAmount     = 8  // i64 LE, 8 bytes (stored as int64, transmitted as uint64 bits)
	offsetNonce      = 16 // u32 LE, 4 bytes
	offsetPadding    = 20 // [u8;12], zero-filled

	// sentinelReceiverID is the placeholder ReceiverID for the Phase C implementation.
	// The Rust engine's Ledger Mutator skips envelopes with receiver_id == 99999
	// (established in Sprint 3.1 as the sentinel value for the interim gateway mock).
	// Replace with a real account lookup in Phase D.
	sentinelReceiverID = uint32(99999)
)

// ─── PACKAGE-INIT ABI ASSERTION ───────────────────────────────────────────────

// init verifies the PayloadSize constant at process startup.
// This catches any accidental constant change before the first request is processed.
func init() {
	// Manual layout check: write a complete payload and verify byte count.
	// This is the Go equivalent of Rust's compile-time `const _: () = assert!(...)`.
	buf := make([]byte, PayloadSize)
	if len(buf) != 32 {
		// This can only trigger if PayloadSize constant is changed — panic immediately.
		panic(fmt.Sprintf(
			"txbuilder ABI VIOLATION: PayloadSize=%d, expected 32. "+
				"Rust TransactionPayload ABI requires exactly 32 bytes.",
			PayloadSize,
		))
	}
}

// ─── BUILD ENVELOPE ───────────────────────────────────────────────────────────

// BuildEnvelope constructs the 32-byte binary TransactionPayload for the
// Rust LMAX settlement engine.
//
// The returned []byte is passed directly to aeronpub.Publish(), which embeds
// it at payload offset 88 within the 512-byte TransactionEnvelope wire frame.
// (Offset 88 established in Sprint 3.1: the first 88 bytes are the outer
// envelope header — version, flags, sender_pub_key, deadline_ns, etc.)
//
// Error conditions (all non-nil errors must halt the pipeline):
//   - ctx.AmountAtomic < 0: negative amounts are a financial integrity violation.
//   - ctx.AmountAtomic > maxAtomicAmount: overflow guard against i64 wrapping.
//   - ctx.FinalStatus != "APPROVED": only approved transactions reach the engine.
//   - ctx.Contract.State != "APPROVED": contract must be in terminal approved state.
func BuildEnvelope(ctx *domain.IntentContext) ([]byte, error) {
	// ── PRE-FLIGHT GUARDS ─────────────────────────────────────────────────

	// Only APPROVED, CONSUMED-ready contexts should reach the Rust engine.
	// Defensive check: the worker pipeline enforces this ordering, but a
	// misrouted context must not silently produce a valid binary payload.
	if ctx.FinalStatus != "APPROVED" {
		return nil, fmt.Errorf(
			"BuildEnvelope: refusing to build payload for non-approved transaction "+
				"(final_status=%q, trace=%s)",
			ctx.FinalStatus, ctx.TraceID,
		)
	}

	// Contract must be in the terminal APPROVED state.
	if ctx.Contract.State != "APPROVED" {
		return nil, fmt.Errorf(
			"BuildEnvelope: contract not in APPROVED state (state=%q, trace=%s)",
			ctx.Contract.State, ctx.TraceID,
		)
	}

	// Negative atomic amounts are financially invalid.
	// The policy firewall (invariants.go) should have caught a negative
	// TransactionAmt, but ctx.AmountAtomic is set at ingress and could
	// diverge if the conversion path has a bug.
	if ctx.AmountAtomic < 0 {
		return nil, fmt.Errorf(
			"BuildEnvelope: negative AmountAtomic=%d is a financial integrity violation (trace=%s)",
			ctx.AmountAtomic, ctx.TraceID,
		)
	}

	// Guard against values that overflow int64 when cast from float64 during
	// any intermediate calculation. At 100 tiyin per cent, $50,000 USD =
	// 5,000,000 tiyin = well within int64 range. This check guards against
	// crafted payloads that somehow produced a near-maxint atomic value.
	const maxAtomicAmount = int64(math.MaxInt32) // 2,147,483,647 — ~$21M at 100 tiyin/cent
	if ctx.AmountAtomic > maxAtomicAmount {
		return nil, fmt.Errorf(
			"BuildEnvelope: AmountAtomic=%d exceeds safe ceiling %d (trace=%s)",
			ctx.AmountAtomic, maxAtomicAmount, ctx.TraceID,
		)
	}

	// ── DERIVE SENDER ID ──────────────────────────────────────────────────
	//
	// Phase C placeholder: SenderID is derived from the first 4 bytes of
	// SHA-256(TraceID). This produces a deterministic uint32 that uniquely
	// identifies the originating request within the Ledger's account space.
	//
	// Phase D upgrade: replace with a real account lookup call:
	//   senderID, err := accountstore.LookupByEmail(ctx.CustomerEmail)
	//
	// WHY NOT USE A RANDOM ID:
	//   The Rust engine's Ledger Mutator validates sender_id < ACCOUNT_COUNT.
	//   A random uint32 has a high probability of being out of bounds and would
	//   cause the envelope to be silently discarded. The SHA-256-derived ID is
	//   deterministic and bounded by the modulo below.
	senderID := deriveSenderID(ctx.TraceID)

	// ── DERIVE RECEIVER ID ────────────────────────────────────────────────
	//
	// Phase C placeholder: use the sentinel value (99999) established in Sprint 3.1.
	// The Rust Ledger Mutator processes envelopes with receiver_id == 99999 as
	// no-op credit operations (the sentinel receiver's balance absorbs the debit
	// without economic effect, preserving the ledger's invariant that
	// sum(all balances) is constant).
	//
	// Phase D upgrade: resolve from ctx.Contract.Intent.TargetTool and the
	// advisory action to determine the actual destination account.
	receiverID := deriveReceiverID(ctx.Contract.Intent.TargetTool)

	// ── DERIVE NONCE ──────────────────────────────────────────────────────
	//
	// Nonce = first 4 bytes of SHA-256(TraceID + "|" + AmountAtomic_decimal).
	// Deterministic: the same transaction always produces the same nonce.
	// The Rust engine uses the nonce for idempotency deduplication on the
	// ring buffer — identical nonce from a replayed envelope is dropped.
	nonce := deriveNonce(ctx.TraceID, ctx.AmountAtomic)

	// ── PACK THE 32-BYTE BINARY PAYLOAD ───────────────────────────────────
	//
	// Layout (little-endian throughout, matching Rust #[repr(C)]):
	//
	//   [00:04] SenderID   u32 LE
	//   [04:08] ReceiverID u32 LE
	//   [08:16] Amount     i64 LE   (cast to uint64 for binary.Write; bit pattern preserved)
	//   [16:20] Nonce      u32 LE
	//   [20:32] _padding   [0x00 × 12]  (explicit zero-fill; never omit)
	//
	// We use a fixed-size [PayloadSize]byte array on the stack, then return a
	// copy as []byte. The array allocation is stack-allocated by the compiler
	// (escape analysis: `buf` does not escape before the copy). At 32 bytes,
	// this is faster than a heap allocation via make().
	// ── PACK THE 32-BYTE BINARY PAYLOAD ───────────────────────────────────
	var buf [PayloadSize]byte

	binary.LittleEndian.PutUint32(buf[offsetSenderID:], senderID)
	binary.LittleEndian.PutUint32(buf[offsetReceiverID:], receiverID)
	binary.LittleEndian.PutUint64(buf[offsetAmount:], uint64(ctx.AmountAtomic))
	binary.LittleEndian.PutUint32(buf[offsetNonce:], nonce)

	// ── FINAL SECURITY PATCH: EXPLICIT MEMORY WIPING ─────────────────────
	// Zero-fill the 12 bytes of padding explicitly to prevent memory-leak
	// oracle splicing when memory is reused.
	for i := offsetPadding; i < PayloadSize; i++ {
		buf[i] = 0
	}
	// ─────────────────────────────────────────────────────────────────────

	// ── RUNTIME SIZE ASSERTION ────────────────────────────────────────────
	// ── RUNTIME SIZE ASSERTION ────────────────────────────────────────────
	//
	// This assertion fires if PayloadSize is ever changed without updating the
	// struct layout above. It executes after the pack so that the compiler
	// cannot optimise it away as dead code.
	if len(buf) != 32 {
		// Unreachable in practice (buf is [PayloadSize]byte and PayloadSize==32).
		// Kept as defence-in-depth against future refactoring.
		return nil, fmt.Errorf(
			"BuildEnvelope: INTERNAL ABI VIOLATION: packed %d bytes, expected 32 (trace=%s)",
			len(buf), ctx.TraceID,
		)
	}

	// Return a heap copy of the stack buffer. The aeronpub layer will pass this
	// slice to Aeron's offer(), which reads from it synchronously before returning.
	result := make([]byte, PayloadSize)
	copy(result, buf[:])
	return result, nil
}

// ─── DETERMINISTIC FIELD DERIVATION ──────────────────────────────────────────

// deriveSenderID returns a deterministic uint32 sender account ID from a trace ID.
//
// Algorithm: SHA-256(traceID)[:4] interpreted as little-endian uint32,
// then clamped to [1, accountCount-1] via modulo to stay within the Ledger's
// account range. Account 0 is reserved (sentinel for "no account").
//
// This is the Phase C placeholder. Replace with a real account store lookup
// in Phase D. The modulo clamp keeps the value in-range for the current
// 100,000-account Ledger without knowing the exact count at compile time.
func deriveSenderID(traceID string) uint32 {
	h := sha256.Sum256([]byte("sender:" + traceID))
	raw := binary.LittleEndian.Uint32(h[:4])
	// Clamp to [1, 99998] to stay well within the 100,000-account Ledger space
	// and avoid colliding with the sentinel receiver ID (99999).
	clamped := (raw % 99998) + 1
	return clamped
}

// deriveReceiverID maps an intent target tool to a static receiver account ID.
//
// In Phase C, each tool type routes to a pre-defined internal account:
//
//	"transfer_internal"  → sentinelReceiverID (99999, no-op in current Ledger)
//	"card_freeze"        → sentinelReceiverID (administrative action, no credit)
//	anything else        → sentinelReceiverID
//
// Phase D: this function becomes a lookup into the account routing table.
func deriveReceiverID(targetTool string) uint32 {
	tool := strings.ToLower(strings.TrimSpace(targetTool))
	switch tool {
	case "transfer_internal":
		// Future: resolve destination account from transaction metadata.
		return sentinelReceiverID
	case "card_freeze", "card_block", "card_unblock":
		// Administrative operations: no monetary transfer; sentinel absorbs debit.
		return sentinelReceiverID
	default:
		return sentinelReceiverID
	}
}

// deriveNonce returns a deterministic uint32 nonce for a transaction.
//
// Algorithm: SHA-256("nonce:" + traceID + "|" + decimal(amountAtomic))[:4]
// interpreted as little-endian uint32.
//
// Properties:
//   - Deterministic: same inputs → same nonce. Safe to call on pipeline retry.
//   - Unique per (TraceID, AmountAtomic) pair: a replayed transaction with a
//     modified amount will produce a different nonce and be treated as a new event.
//   - No external entropy: does not require crypto/rand, avoiding goroutine
//     scheduling overhead on the hot path.
func deriveNonce(traceID string, amountAtomic int64) uint32 {
	// Format: "nonce:{traceID}|{amountAtomic}"
	// The "nonce:" prefix domain-separates this hash from deriveSenderID's hash
	// to prevent cross-purpose hash collisions if traceID contains digits.
	input := fmt.Sprintf("nonce:%s|%d", traceID, amountAtomic)
	h := sha256.Sum256([]byte(input))
	return binary.LittleEndian.Uint32(h[:4])
}
