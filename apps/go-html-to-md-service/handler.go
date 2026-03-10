package main

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/rs/zerolog/log"
)

const (
	maxRequestSize = 150 * 1024 * 1024 // 150MB max request size
)

// Handler manages HTTP request handling
type Handler struct {
	converter *Converter
}

// NewHandler creates a new Handler instance
func NewHandler(converter *Converter) *Handler {
	return &Handler{
		converter: converter,
	}
}

// RegisterRoutes registers all HTTP routes
func (h *Handler) RegisterRoutes(router *mux.Router) {
	router.HandleFunc("/health", h.HealthCheck).Methods("GET")
	router.HandleFunc("/convert", h.ConvertHTML).Methods("POST")
	router.HandleFunc("/", h.Index).Methods("GET")
}

// HealthCheckResponse represents the health check response
type HealthCheckResponse struct {
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
	Service   string    `json:"service"`
}

// HealthCheck handles health check requests
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	response := HealthCheckResponse{
		Status:    "healthy",
		Timestamp: time.Now(),
		Service:   "html-to-markdown",
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// IndexResponse represents the index page response
type IndexResponse struct {
	Service     string   `json:"service"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Endpoints   []string `json:"endpoints"`
}

// Index handles root path requests
func (h *Handler) Index(w http.ResponseWriter, r *http.Request) {
	response := IndexResponse{
		Service:     "HTML to Markdown Converter",
		Version:     "1.0.0",
		Description: "A service for converting HTML content to Markdown format",
		Endpoints: []string{
			"GET  /health - Health check endpoint",
			"POST /convert - Convert HTML to Markdown",
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// ConvertRequest represents the conversion request payload
type ConvertRequest struct {
	HTML string `json:"html"`
}

// ConvertResponse represents the conversion response payload
type ConvertResponse struct {
	Markdown string `json:"markdown"`
	Success  bool   `json:"success"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error   string `json:"error"`
	Details string `json:"details,omitempty"`
	Success bool   `json:"success"`
}

// ConvertHTML handles HTML to Markdown conversion requests
func (h *Handler) ConvertHTML(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()

	// Extract request ID from header for logging
	requestID := r.Header.Get("X-Request-ID")
	logger := log.Logger
	if requestID != "" {
		logger = log.With().Str("request_id", requestID).Logger()
	}

	// Limit request body size
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)

	// Read and decode request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		logger.Error().Err(err).Msg("Failed to read request body")
		h.sendError(w, "Failed to read request body", err.Error(), http.StatusBadRequest)
		return
	}

	var req ConvertRequest
	if err := json.Unmarshal(body, &req); err != nil {
		logger.Error().Err(err).Msg("Failed to parse request body")
		h.sendError(w, "Invalid JSON in request body", err.Error(), http.StatusBadRequest)
		return
	}

	// Validate input
	if req.HTML == "" {
		logger.Warn().Msg("Empty HTML field in request")
		h.sendError(w, "HTML field is required", "The 'html' field cannot be empty", http.StatusBadRequest)
		return
	}

	// Convert HTML to Markdown
	markdown, err := h.converter.ConvertHTMLToMarkdown(req.HTML)
	if err != nil {
		logger.Error().Err(err).Msg("Failed to convert HTML to Markdown")
		h.sendError(w, "Failed to convert HTML to Markdown", err.Error(), http.StatusInternalServerError)
		return
	}

	// Log metrics
	duration := time.Since(startTime)
	logger.Info().
		Dur("duration_ms", duration).
		Int("input_size", len(req.HTML)).
		Int("output_size", len(markdown)).
		Msg("HTML to Markdown conversion completed")

	// Send response
	response := ConvertResponse{
		Markdown: markdown,
		Success:  true,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// sendError sends an error response
func (h *Handler) sendError(w http.ResponseWriter, message string, details string, statusCode int) {
	response := ErrorResponse{
		Error:   message,
		Details: details,
		Success: false,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}
