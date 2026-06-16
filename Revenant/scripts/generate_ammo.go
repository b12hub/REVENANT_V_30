// Usage: go run scripts/generate_ammo.go
// Output: scripts/ammo.json

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

const (
	totalPayloads          = 10_000
	powDifficultyZeroBytes = 2
	powNonceSize           = 8
	ed25519PublicKeySize   = 32
	powCombinedSize        = ed25519PublicKeySize + powNonceSize // 40
)

type AmmoEntry struct {
	Payload   string `json:"payload"`
	PubKey    string `json:"pub_key"`
	Signature string `json:"signature"`
	PoWNonce  string `json:"pow_nonce"`
}

func main() {
	numWorkers := runtime.NumCPU()
	fmt.Fprintf(os.Stderr, "[REVENANT AMMO GEN] Generating %d payloads using %d CPU cores\n", totalPayloads, numWorkers)

	startTime := time.Now()
	results := make(chan AmmoEntry, totalPayloads)
	var counter atomic.Int64
	var wg sync.WaitGroup

	workCh := make(chan int, totalPayloads)
	for i := 0; i < totalPayloads; i++ {
		workCh <- i
	}
	close(workCh)

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var combined [powCombinedSize]byte
			for idx := range workCh {
				entry, err := generateEntry(idx, &combined)
				if err != nil {
					fmt.Fprintf(os.Stderr, "[WORKER] Error generating entry %d: %v\n", idx, err)
					os.Exit(1)
				}
				results <- entry
				n := counter.Add(1)
				if n%1000 == 0 {
					fmt.Fprintf(os.Stderr, "[REVENANT AMMO GEN] %d/%d generated\n", n, totalPayloads)
				}
			}
		}()
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	ammo := make([]AmmoEntry, 0, totalPayloads)
	for entry := range results {
		ammo = append(ammo, entry)
	}

	elapsed := time.Since(startTime)
	fmt.Fprintf(os.Stderr, "[REVENANT AMMO GEN] Mining complete in %s\n", elapsed.Round(time.Millisecond))

	outPath := "scripts/ammo.json"
	f, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: cannot create %s: %v\n", outPath, err)
		os.Exit(1)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(ammo); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: JSON encode failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[REVENANT AMMO GEN] Written to %s\n", outPath)
}

func generateEntry(idx int, combined *[powCombinedSize]byte) (AmmoEntry, error) {
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return AmmoEntry{}, err
	}

	payloadStr := fmt.Sprintf(`{"from":"bank-A","to":"bank-B","amount":100,"currency":"UZS","nonce":%d}`, idx)
	payloadBytes := []byte(payloadStr)
	sig := ed25519.Sign(privKey, payloadBytes)

	powNonceBytes, err := minePoWNonce(pubKey, combined)
	if err != nil {
		return AmmoEntry{}, err
	}

	return AmmoEntry{
		Payload:   payloadStr,
		PubKey:    hex.EncodeToString(pubKey),
		Signature: hex.EncodeToString(sig),
		PoWNonce:  hex.EncodeToString(powNonceBytes),
	}, nil
}

func minePoWNonce(pubKey ed25519.PublicKey, combined *[powCombinedSize]byte) ([]byte, error) {
	copy(combined[:ed25519PublicKeySize], pubKey)
	var seedBuf [8]byte
	if _, err := rand.Read(seedBuf[:]); err != nil {
		return nil, err
	}
	nonce := binary.BigEndian.Uint64(seedBuf[:])

	for {
		binary.BigEndian.PutUint64(combined[ed25519PublicKeySize:], nonce)
		hash := sha256.Sum256(combined[:])

		valid := true
		for i := 0; i < powDifficultyZeroBytes; i++ {
			if hash[i] != 0x00 {
				valid = false
				break
			}
		}

		if valid {
			result := make([]byte, powNonceSize)
			binary.BigEndian.PutUint64(result, nonce)
			return result, nil
		}
		nonce++
	}
}
