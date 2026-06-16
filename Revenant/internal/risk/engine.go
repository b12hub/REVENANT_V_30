package risk

import (
	"fmt"
	"sync"
)

const (
	// Fallback limit for brand new users (e.g., 5,000,000 UZS in tiyins)
	BaseLimit uint64 = 5_000_000_000
	// Multiplier for behavioral limit (e.g., 3x their historical average)
	RiskMultiplier uint64 = 3
)

type UserProfile struct {
	TxCount     uint64
	TotalVolume uint64
	AvgAmount   uint64
}

type Engine struct {
	mu       sync.RWMutex
	profiles map[uint32]*UserProfile
}

func NewEngine() *Engine {
	return &Engine{
		profiles: make(map[uint32]*UserProfile),
	}
}

// Evaluate checks if a transaction is anomalous based on historical behavior.
func (e *Engine) Evaluate(userID uint32, amount uint64) error {
	e.mu.RLock()
	profile, exists := e.profiles[userID]
	e.mu.RUnlock()

	limit := BaseLimit
	if exists && profile.TxCount > 0 {
		behavioralLimit := profile.AvgAmount * RiskMultiplier
		if behavioralLimit > limit {
			limit = behavioralLimit
		}
	}

	if amount > limit {
		return fmt.Errorf("QUARANTINE: Amount %d exceeds dynamic behavioral limit of %d", amount, limit)
	}

	return nil
}

// RecordAsync updates the user's behavioral profile AFTER a successful transaction.
func (e *Engine) RecordAsync(userID uint32, amount uint64) {
	e.mu.Lock()
	defer e.mu.Unlock()

	profile, exists := e.profiles[userID]
	if !exists {
		profile = &UserProfile{}
		e.profiles[userID] = profile
	}

	profile.TxCount++
	profile.TotalVolume += amount
	profile.AvgAmount = profile.TotalVolume / profile.TxCount
}
