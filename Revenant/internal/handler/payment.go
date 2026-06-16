// =============================================================================
// internal/handler/payment.go
// REVENANT Gateway — Payment Transaction Handler
// SPRINT 3.1 UPDATE: Zero-Allocation Binary Translation Protocol
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================

package handler

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"

	"github.com/valyala/fasthttp"
	"github.com/valyala/fastjson"

	"revenant-gateway/internal/egress"
	"revenant-gateway/internal/frame"
	"revenant-gateway/internal/pool"
)

const (
	payloadStructSize = 32
	offsetSenderID    = 0
	offsetReceiverID  = 4
	offsetAmount      = 8
	offsetNonce       = 16

	sentinelReceiverID = uint32(99999)
	maxSenderID        = uint32(99_999)
)

var jsonParserPool fastjson.ParserPool

var (
	response202Body = []byte(`{"status":"ACCEPTED","message":"Payment queued for deterministic processing"}`)
	response400Body = []byte(`{"error":"MALFORMED_HEADER","code":400,"message":"X-Signature or X-Public-Key header is malformed or incorrect length"}`)
	response413Body = []byte(`{"error":"PAYLOAD_TOO_LARGE","code":413,"message":"Request body exceeds maximum permitted size for this field"}`)
	response422Body = []byte(`{"error":"INVALID_PAYLOAD","code":422,"message":"Payload fields failed binary translation validation"}`)
	response503Body = []byte(`{"error":"SERVICE_UNAVAILABLE","code":503,"message":"Downstream processing capacity exhausted, retry with backoff"}`)
	response500Body = []byte(`{"error":"INTERNAL_ERROR","code":500,"message":"Internal gateway error"}`)
	contentTypeJSON = []byte("application/json; charset=utf-8")
)

var (
	headerSignatureKey = []byte("X-Signature")
	headerPublicKeyKey = []byte("X-Public-Key")
)

const (
	ed25519SigHexLen    = frame.SignatureFieldSize * 2
	ed25519PubKeyHexLen = 32 * 2
)

type PaymentHandler struct {
	publisher *egress.AeronPublisher
}

func NewPaymentHandler(publisher *egress.AeronPublisher) *PaymentHandler {
	if publisher == nil {
		panic("handler: PaymentHandler requires a non-nil AeronPublisher")
	}
	return &PaymentHandler{publisher: publisher}
}

func (h *PaymentHandler) Handle(ctx *fasthttp.RequestCtx) {
	env := pool.AcquireEnvelope()
	defer func() {
		env.Reset()
		pool.ReleaseEnvelope(env)
	}()

	rawBody := ctx.PostBody()
	rawSigHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(headerSignatureKey))
	rawPubKeyHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(headerPublicKeyKey))

	if len(rawSigHex) != ed25519SigHexLen || len(rawPubKeyHex) != ed25519PubKeyHexLen {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response400Body)
		return
	}

	var sigDecoded [frame.SignatureFieldSize]byte
	var pubDecoded [32]byte

	if n, err := hex.Decode(sigDecoded[:], rawSigHex); err != nil || n != frame.SignatureFieldSize {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response400Body)
		return
	}
	if n, err := hex.Decode(pubDecoded[:], rawPubKeyHex); err != nil || n != 32 {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response400Body)
		return
	}

	parser := jsonParserPool.Get()
	defer jsonParserPool.Put(parser)

	parsedJSON, err := parser.ParseBytes(rawBody)
	if err != nil {
		ctx.SetStatusCode(fasthttp.StatusUnprocessableEntity)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response422Body)
		return
	}

	accountIDBytes := parsedJSON.GetStringBytes("account_id")
	if len(accountIDBytes) == 0 {
		ctx.SetStatusCode(fasthttp.StatusUnprocessableEntity)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response422Body)
		return
	}

	senderID64, ok := parseDecimalBytes(accountIDBytes)
	if !ok || senderID64 > uint64(maxSenderID) {
		ctx.SetStatusCode(fasthttp.StatusUnprocessableEntity)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response422Body)
		return
	}
	senderID := uint32(senderID64)

	amount := parsedJSON.GetInt64("amount")
	if amount <= 0 {
		ctx.SetStatusCode(fasthttp.StatusUnprocessableEntity)
		ctx.SetContentTypeBytes(contentTypeJSON)
		ctx.SetBody(response422Body)
		return
	}

	packTransactionPayload(
		env.Payload[:],
		senderID,
		sentinelReceiverID,
		amount,
		0,
	)

	copy(env.Sender[:], pubDecoded[:])
	copy(env.Signature[:], sigDecoded[:])

	env.SetFlag(frame.FlagSignatureValid)
	env.SetFlag(frame.FlagPoWVerified)

	if err := h.publisher.Dispatch(env); err != nil {
		switch {
		case errors.Is(err, egress.ErrAeronBackPressured),
			errors.Is(err, egress.ErrAeronNotConnected),
			errors.Is(err, egress.ErrAeronClosed),
			errors.Is(err, egress.ErrAeronMaxPosition):
			ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
			ctx.SetContentTypeBytes(contentTypeJSON)
			ctx.SetBody(response503Body)
		default:
			ctx.SetStatusCode(fasthttp.StatusInternalServerError)
			ctx.SetContentTypeBytes(contentTypeJSON)
			ctx.SetBody(response500Body)
		}
		return
	}

	ctx.SetStatusCode(fasthttp.StatusAccepted)
	ctx.SetContentTypeBytes(contentTypeJSON)
	ctx.SetBody(response202Body)
}

//go:nosplit
func packTransactionPayload(payload []byte, senderID, receiverID uint32, amount int64, nonce uint32) {
	binary.LittleEndian.PutUint32(payload[offsetSenderID:offsetSenderID+4], senderID)
	binary.LittleEndian.PutUint32(payload[offsetReceiverID:offsetReceiverID+4], receiverID)
	binary.LittleEndian.PutUint64(payload[offsetAmount:offsetAmount+8], uint64(amount))
	binary.LittleEndian.PutUint32(payload[offsetNonce:offsetNonce+4], nonce)
}

//go:nosplit
func parseDecimalBytes(b []byte) (uint64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	const maxUint64 = ^uint64(0)
	const cutoff = maxUint64/10 + 1

	var result uint64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		digit := uint64(c - '0')
		if result >= cutoff {
			return 0, false
		}
		result = result*10 + digit
	}
	return result, true
}
