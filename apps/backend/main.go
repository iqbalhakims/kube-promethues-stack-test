package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

var version = os.Getenv("APP_VERSION")

func main() {
	if version == "" {
		version = "v1"
	}

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://app.iqbalhakim.ink")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		hostname, _ := os.Hostname()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"service":  "backend",
			"version":  version,
			"hostname": hostname,
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	fmt.Printf("backend %s listening on :%s\n", version, port)
	http.ListenAndServe(":"+port, nil)
}
