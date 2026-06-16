package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"io/ioutil"
	"net/http"
	"strconv"
	"time"
)

func main() {
	// 1. PASTE YOUR NEW GENERATED KEY ARRAY HERE
	testPrivateKey := ed25519.PrivateKey{
		36, 200, 17, 115, 177, 27, 246, 66, 147, 33, 88, 83, 112, 210, 188, 6,
		119, 229, 14, 87, 95, 233, 162, 7, 248, 123, 175, 130, 206, 219, 0, 199,
		36, 23, 122, 184, 166, 196, 160, 74, 101, 47, 122, 13, 17, 72, 157, 127,
		51, 204, 72, 50, 172, 187, 150, 164, 230, 115, 26, 154, 102, 253, 121, 32,
	}

	// 2. Mathematically extract the Public Key
	pubKey := testPrivateKey.Public().(ed25519.PublicKey)

	//payload := []byte(`{"intent": "Oyligim tushdi. 2 million somni onamga yubor."}`)
	payload := []byte(`{"intent": "Transfer 2 million UZS to mom"}`)

	// 3. The Gateway strictly verifies ONLY the POST body
	msgToSign := payload
	sig := ed25519.Sign(testPrivateKey, msgToSign)

	req, _ := http.NewRequest("POST", "http://localhost:8080/api/v1/agentic/transact", bytes.NewBuffer(payload))
	req.Header.Set("Content-Type", "application/json")

	// 4. Inject the Public Key and Signature headers!
	req.Header.Set("X-Public-Key", hex.EncodeToString(pubKey))
	req.Header.Set("X-Signature", hex.EncodeToString(sig))

	// Boilerplate headers to pass the rest of the pipeline
	nonce := strconv.FormatInt(time.Now().UnixNano(), 10)
	deadline := strconv.FormatInt(time.Now().Add(5*time.Second).Unix(), 10)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Deadline-Timestamp", deadline)
	req.Header.Set("X-PoW-Hash", "0000abc123")

	fmt.Println("Firing Pure Cryptographically Signed Payload...")
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	defer resp.Body.Close()

	body, _ := ioutil.ReadAll(resp.Body)
	fmt.Printf("Gateway Response: %s\n", string(body))
}
