package icde

import (
	"errors"
	"strings"
	"sync"
)

// ErrAmbiguousEntity is triggered when the LLM outputs a string that cannot
// be mathematically mapped to a single, explicit AccountID.
var ErrAmbiguousEntity = errors.New("icde: semantic alias unknown or ambiguous - triggering HITL fallback")

// AccountID mirrors the Rust core's strict primitive types.
type AccountID uint32

// UserID represents the authenticated session initiating the intent.
type UserID uint32

// EntityResolver maintains the strict boundaries between semantic space and execution space.
type EntityResolver struct {
	mu sync.RWMutex
	// graph maps a UserID to their specific alias dictionary.
	// e.g., graph[User_1]["mom"] = Account_8832
	graph map[UserID]map[string]AccountID
}

// NewEntityResolver initializes the resolver. In production, this would be
// warmed up via gRPC streams from the primary database on boot.
func NewEntityResolver() *EntityResolver {
	return &EntityResolver{
		graph: map[UserID]map[string]AccountID{
			// MOCK DATABASE: Seed User 1055's address book for local testing
			1055: {
				//"onamga": 88888,
				"mom": 88888,
			},
		},
	}
}

// Resolve locks the semantic string into a hard primitive.
// It is heavily optimized to avoid allocations during the lookup phase.
func (r *EntityResolver) Resolve(user UserID, semanticAlias string) (AccountID, error) {
	// Normalize the alias to prevent case-sensitivity bypasses.
	// Note: strings.ToLower allocates. In a pure zero-alloc hot path,
	// we would require the AI Control Plane to output pre-normalized lower-case strings.
	normalized := strings.ToLower(strings.TrimSpace(semanticAlias))

	r.mu.RLock()
	defer r.mu.RUnlock()

	userAliases, exists := r.graph[user]
	if !exists {
		return 0, ErrAmbiguousEntity
	}

	accountID, found := userAliases[normalized]
	if !found {
		// The AI guessed or hallucinated an entity. We hard fail.
		return 0, ErrAmbiguousEntity
	}

	return accountID, nil
}
