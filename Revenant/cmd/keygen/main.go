package main

import (
	"crypto/ed25519"
	"fmt"
)

func main() {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		panic(err)
	}

	fmt.Println("=== COPY INTO GO (main.go & tester/main.go) ===")
	fmt.Printf("testPrivateKey := ed25519.PrivateKey{\n    ")
	for i, b := range priv {
		fmt.Printf("%d, ", b)
		if (i+1)%16 == 0 && i != 63 {
			fmt.Printf("\n    ")
		}
	}
	fmt.Printf("\n}\n\n")

	fmt.Println("=== COPY INTO RUST (network_rx.rs) ===")
	fmt.Printf("const GO_PUBLIC_KEY: [u8; 32] = [")
	for i, b := range pub {
		fmt.Printf("%d", b)
		if i != 31 {
			fmt.Print(", ")
		}
	}
	fmt.Printf("];\n")
}
