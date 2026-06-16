package main

import (
	"log"
	"net/http"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{ CheckOrigin: func(r *http.Request) bool { return true } }

func main() {
	http.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		conn, _ := upgrader.Upgrade(w, r, nil)
		log.Println("[TELEMETRY] Dashboard connected!")
		for {
			// This is a telemetry stub. In a full deployment, this reads the TPS from Aeron.
			conn.WriteJSON(map[string]interface{}{
				"tps": 1200,
				"tx_total": 50000,
				"lifecycle": map[string]int{"gateway_us": 45, "mutator_us": 12},
			})
			// Block to keep connection open
			select {} 
		}
	})
	
	log.Println("[TELEMETRY] Server LIVE on :8082")
	if err := http.ListenAndServe(":8082", nil); err != nil {
		log.Fatalf("Fatal: %v", err)
	}
}
