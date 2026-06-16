package main

import (
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var (
	upgrader  = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	clients   = make(map[*websocket.Conn]bool)
	clientsMu sync.Mutex
)

func main() {
	// Listen for live UDP metrics from the Rust Engine
	addr, _ := net.ResolveUDPAddr("udp", "127.0.0.1:8084")
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatalf("UDP Listen failed: %v", err)
	}

	go func() {
		buf := make([]byte, 1024)
		for {
			n, _, err := conn.ReadFromUDP(buf)
			if err == nil {
				msg := buf[:n]
				clientsMu.Lock()
				// Blast the Rust data to all connected React Dashboards
				for client := range clients {
					client.WriteMessage(websocket.TextMessage, msg)
				}
				clientsMu.Unlock()
			}
		}
	}()

	http.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		ws, _ := upgrader.Upgrade(w, r, nil)
		clientsMu.Lock()
		clients[ws] = true
		clientsMu.Unlock()
		log.Println("[TELEMETRY] Dashboard connected to live firehose!")

		defer func() {
			clientsMu.Lock()
			delete(clients, ws)
			clientsMu.Unlock()
			ws.Close()
		}()
		select {} // Keep connection alive
	})

	log.Println("[TELEMETRY] Server LIVE on :8082 (WebSocket) and :8084 (UDP from Rust)")
	http.ListenAndServe(":8082", nil)
}
