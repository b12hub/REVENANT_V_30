package routing

import (
	"encoding/json"
	"errors"
	"net/http"
	"revenant-gateway/internal/ipc"
	"sync"
	"sync/atomic"
	"time"
	// Assuming imports from previous sprints:
	// "revenant/internal/ipc"
)

var (
	ErrCircuitOpen    = errors.New("routing: cluster circuit breaker is OPEN (total cluster failure)")
	ErrPublisherDown  = errors.New("routing: active publisher offline, triggering failover")
	ErrClusterUnknown = errors.New("routing: unable to discover any active leader")
)

// AeronPublication defines the interface for our IPC bridge publisher.
// In reality, this wraps the C-Go Aeron client.
type AeronPublication interface {
	Offer(envelope *ipc.EnvelopeBuffer) error
	Close() error
	Endpoint() string
}

// ClusterStatus represents the control-plane JSON response from a Rust node.
type ClusterStatus struct {
	Role        string `json:"role"` // "Leader", "Follower", "Candidate"
	CurrentTerm uint64 `json:"current_term"`
	LeaderIP    string `json:"leader_ip"` // E.g., "samarkand:40123"
}

// SmartClusterClient manages the lock-free Aeron publisher and failover state.
type SmartClusterClient struct {
	// HOT PATH: atomic.Pointer allows lock-free, zero-allocation reads for 100k TPS.
	activePub atomic.Pointer[AeronPublication]

	// Circuit Breaker: 0 = Closed (Healthy), 1 = Open (Failing)
	breakerTripped atomic.Int32

	seedNodes  []string
	httpClient *http.Client

	// Control Plane Mutex: Ensures only one goroutine executes the failover swap at a time.
	failoverMu sync.Mutex
}

// NewSmartClusterClient initializes the router and discovers the primary leader.
func NewSmartClusterClient(seeds []string) (*SmartClusterClient, error) {
	client := &SmartClusterClient{
		seedNodes: seeds,
		httpClient: &http.Client{
			Timeout: 50 * time.Millisecond, // Strict timeout for control plane
		},
	}

	if err := client.ForceFailover(); err != nil {
		return nil, err
	}

	return client, nil
}

// =========================================================================
// THE HOT PATH (Zero-Allocation, Lock-Free)
// =========================================================================

// Publish deterministically routes the 512-byte payload to the active Leader.
func (c *SmartClusterClient) Publish(env *ipc.EnvelopeBuffer) error {
	// 1. Circuit Breaker Gate
	if c.breakerTripped.Load() == 1 {
		return ErrCircuitOpen
	}

	// 2. Lock-Free Pointer Load (Single CPU Instruction)
	pubPtr := c.activePub.Load()
	if pubPtr == nil {
		return ErrPublisherDown
	}
	pub := *pubPtr

	// 3. Execute IPC Transfer
	err := pub.Offer(env)
	if err != nil {
		// Asynchronous Failover Trigger
		// We do not block the hot path. We spawn a background goroutine to heal
		// the cluster, while returning an error so the Go API can retry or queue.
		go c.ForceFailover()
		return ErrPublisherDown
	}

	return nil
}

// =========================================================================
// THE CONTROL PLANE (Leader Discovery & Aeron Swapping)
// =========================================================================

// ForceFailover probes the cluster, identifies the new Leader, and atomically
// swaps the Aeron publication.
func (c *SmartClusterClient) ForceFailover() error {
	// Prevent failover stampedes. If another goroutine is already failing over, exit.
	if !c.failoverMu.TryLock() {
		return nil
	}
	defer c.failoverMu.Unlock()

	leaderEndpoint, err := c.discoverLeader()
	if err != nil {
		// TOTAL CLUSTER FAILURE (e.g., fiber cut to all 3 cities).
		// Trip the circuit breaker so the HTTP API instantly returns 503s.
		c.breakerTripped.Store(1)
		return ErrCircuitOpen
	}

	// We found the Leader. Are we already connected to it?
	currentPubPtr := c.activePub.Load()
	if currentPubPtr != nil {
		currentPub := *currentPubPtr
		if currentPub.Endpoint() == leaderEndpoint {
			// Cluster stabilized during our lock acquisition.
			c.breakerTripped.Store(0)
			return nil
		}
	}

	// -> AT THIS POINT: We must execute the dynamic Aeron swap.

	// 1. Boot the new publisher (e.g., "aeron:udp?endpoint=samarkand:40123")
	newPub, err := bootAeronPublisher(leaderEndpoint)
	if err != nil {
		return err
	}

	// 2. The Atomic Swap (Hot path instantly starts using the new Leader)
	c.activePub.Store(&newPub)

	// 3. Heal the Circuit Breaker
	c.breakerTripped.Store(0)

	// 4. Gracefully close the dead Tashkent connection in the background
	if currentPubPtr != nil {
		go (*currentPubPtr).Close()
	}

	return nil
}

// discoverLeader iterates through seed nodes to find the Raft Primary.
func (c *SmartClusterClient) discoverLeader() (string, error) {
	for _, node := range c.seedNodes {
		endpoint := "http://" + node + "/raft/status"

		// Note: HTTP allocates. This is acceptable because it's strictly
		// isolated to the control-plane failover path, never the 100k TPS hot path.
		resp, err := c.httpClient.Get(endpoint)
		if err != nil {
			continue // Node is dead (e.g., Tashkent power loss)
		}

		var status ClusterStatus
		if err := json.NewDecoder(resp.Body).Decode(&status); err == nil {
			resp.Body.Close()

			if status.Role == "Leader" {
				return node, nil
			} else if status.Role == "Follower" && status.LeaderIP != "" {
				// Node is alive but Follower. It tells us who the Leader is.
				// We instantly follow the redirect.
				return status.LeaderIP, nil
			}
		} else {
			resp.Body.Close()
		}
	}

	return "", ErrClusterUnknown
}

// bootAeronPublisher is a stub for initializing the C-Go Aeron bridge.
func bootAeronPublisher(endpoint string) (AeronPublication, error) {
	// return aeron.AddPublication("aeron:udp?endpoint=" + endpoint, 10)
	return &mockPub{endpoint: endpoint}, nil
}

// Mock implementation for the audit trail
type mockPub struct{ endpoint string }

func (m *mockPub) Offer(env *ipc.EnvelopeBuffer) error { return nil }
func (m *mockPub) Close() error                        { return nil }
func (m *mockPub) Endpoint() string                    { return m.endpoint }
