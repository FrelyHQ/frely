package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	cpaBasicEvidenceContract     = "cpa-basic@1"
	cpaBasicJSONContract         = "cpa-basic-json@1"
	cpaBasicJSONPrefix           = `{"contract":"cpa-basic-json@1","version":1,"response":`
	cpaBasicEvidenceTestFaultEnv = "FRIDAY_CPA_EVIDENCE_TEST_FAULT"
	maxProviderAttemptRefBytes   = 128
	maxJSONInspectionBytes       = 256 * 1024
	maxSSEFrameInspectionBytes   = 256 * 1024
	maxJSONSafeInteger           = int64(9007199254740991)
)

// CPABasicEvidenceMiddleware adapts negotiated inference responses to Friday's
// stock CPA evidence contract. Requests that do not negotiate the exact
// contract and exact attempt reference pass through unchanged.
func CPABasicEvidenceMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		attemptRef, ok := negotiatedCPABasicAttempt(c.Request)
		if !ok || isWebsocketUpgrade(c.Request) {
			c.Next()
			return
		}

		writer := newCPABasicEvidenceWriter(c.Writer, c.Request.Context(), attemptRef)
		c.Writer = writer
		c.Next()
		if err := writer.finish(); err != nil {
			_ = c.Error(err)
		}
	}
}

func negotiatedCPABasicAttempt(request *http.Request) (string, bool) {
	if request == nil {
		return "", false
	}
	contracts := request.Header.Values("X-Friday-CPA-Evidence-Contract")
	requestIDs := request.Header.Values("X-Request-Id")
	if len(contracts) != 1 || contracts[0] != cpaBasicEvidenceContract || len(requestIDs) != 1 || !validProviderAttemptRef(requestIDs[0]) {
		return "", false
	}
	return requestIDs[0], true
}

func validProviderAttemptRef(value string) bool {
	if len(value) < 1 || len(value) > maxProviderAttemptRefBytes {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_' || character == '-' || character == '.' || character == ':' {
			continue
		}
		return false
	}
	return true
}

func isWebsocketUpgrade(request *http.Request) bool {
	if request == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket")
}

type cpaResponseMode uint8

const (
	cpaResponseUndecided cpaResponseMode = iota
	cpaResponseJSON
	cpaResponseSSE
	cpaResponsePassThrough
)

type cpaBasicEvidenceWriter struct {
	gin.ResponseWriter
	requestContext   context.Context
	attemptRef       string
	fault            string
	mode             cpaResponseMode
	status           int
	size             int
	wrote            bool
	committed        bool
	finished         bool
	evidenceWritten  bool
	jsonStarted      bool
	jsonBypass       bool
	inspection       bytes.Buffer
	inspectionClosed bool
	sseFrame         bytes.Buffer
	sseFrameOversize bool
	sseScanner       sseDelimiterScanner
	usage            *cpaTrustedUsage
	anthropicUsage   cpaAnthropicUsageAccumulator
	serviceTier      string
}

func newCPABasicEvidenceWriter(writer gin.ResponseWriter, requestContext context.Context, attemptRef string) *cpaBasicEvidenceWriter {
	writer.Header().Set("X-Request-Id", attemptRef)
	return &cpaBasicEvidenceWriter{
		ResponseWriter: writer,
		requestContext: requestContext,
		attemptRef:     attemptRef,
		fault:          evidenceTestFault(),
		status:         http.StatusOK,
		size:           -1,
	}
}

func (w *cpaBasicEvidenceWriter) WriteHeader(statusCode int) {
	if w.wrote || w.finished {
		return
	}
	w.status = statusCode
	w.refreshMode()
	if w.mode == cpaResponseSSE || w.mode == cpaResponsePassThrough {
		w.commit()
	}
}

func (w *cpaBasicEvidenceWriter) WriteHeaderNow() {
	if w.finished {
		return
	}
	w.wrote = true
	w.refreshMode()
	if w.mode == cpaResponseSSE || w.mode == cpaResponsePassThrough {
		w.commit()
	}
}

func (w *cpaBasicEvidenceWriter) Write(payload []byte) (int, error) {
	if w.finished {
		return 0, http.ErrBodyNotAllowed
	}
	w.wrote = true
	if w.size < 0 {
		w.size = 0
	}
	w.size += len(payload)
	w.refreshMode()

	if w.mode == cpaResponseUndecided {
		// Once body bytes arrive without an explicit media type, the response can
		// no longer be safely adapted without buffering it. Preserve it directly.
		w.mode = cpaResponsePassThrough
	}

	switch w.mode {
	case cpaResponseJSON:
		return w.writeJSON(payload)
	case cpaResponseSSE:
		if err := w.writeSSE(payload); err != nil {
			return 0, err
		}
		return len(payload), nil
	default:
		w.commit()
		return w.ResponseWriter.Write(payload)
	}
}

func (w *cpaBasicEvidenceWriter) WriteString(payload string) (int, error) {
	return w.Write([]byte(payload))
}

func (w *cpaBasicEvidenceWriter) Flush() {
	if w.finished {
		return
	}
	w.refreshMode()
	switch w.mode {
	case cpaResponseSSE, cpaResponsePassThrough:
		w.commit()
	case cpaResponseJSON:
		if !w.jsonStarted && !w.jsonBypass {
			return
		}
	default:
		return
	}
	w.ResponseWriter.Flush()
}

func (w *cpaBasicEvidenceWriter) Status() int { return w.status }
func (w *cpaBasicEvidenceWriter) Size() int   { return w.size }
func (w *cpaBasicEvidenceWriter) Written() bool {
	return w.wrote
}

func (w *cpaBasicEvidenceWriter) refreshMode() {
	if w.mode != cpaResponseUndecided {
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(w.Header().Get("Content-Type")))
	mediaType := strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	switch {
	case mediaType == "text/event-stream":
		w.mode = cpaResponseSSE
		w.Header().Del("Content-Length")
	case mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"):
		w.mode = cpaResponseJSON
	case mediaType != "":
		w.mode = cpaResponsePassThrough
	}
}

func (w *cpaBasicEvidenceWriter) commit() {
	if w.committed {
		return
	}
	w.Header().Set("X-Request-Id", w.attemptRef)
	w.ResponseWriter.WriteHeader(w.status)
	w.committed = true
}

func (w *cpaBasicEvidenceWriter) finish() error {
	if w.finished {
		return nil
	}
	w.finished = true
	w.refreshMode()

	switch w.mode {
	case cpaResponseJSON:
		return w.finishJSON()
	case cpaResponseSSE:
		// A bounded unfinished frame is a wire observation, not terminal
		// evidence. Oversized unfinished bytes were already streamed directly.
		w.commit()
		if w.sseFrame.Len() > 0 {
			err := writeResponseBytes(w.ResponseWriter, w.sseFrame.Bytes())
			w.sseFrame.Reset()
			return err
		}
		return nil
	case cpaResponseUndecided:
		if w.status >= http.StatusInternalServerError && w.size <= 0 {
			// The upstream recovery middleware intentionally writes only a status.
			// Negotiated callers still require a safe JSON public error plus pending
			// evidence; never include the recovered panic value.
			publicError := []byte(`{"error":{"type":"server_error"}}`)
			w.Header().Set("Content-Type", "application/json")
			w.mode = cpaResponseJSON
			if err := w.startJSON(); err != nil {
				return err
			}
			w.inspectJSON(publicError)
			if err := writeResponseBytes(w.ResponseWriter, publicError); err != nil {
				return err
			}
			return w.finishJSON()
		}
		w.commit()
		return nil
	default:
		w.commit()
		return nil
	}
}

func (w *cpaBasicEvidenceWriter) writeJSON(payload []byte) (int, error) {
	if len(payload) == 0 {
		return 0, nil
	}
	if w.fault == "missing" {
		w.jsonBypass = true
		w.commit()
		return w.ResponseWriter.Write(payload)
	}
	if err := w.startJSON(); err != nil {
		return 0, err
	}
	w.inspectJSON(payload)
	return w.ResponseWriter.Write(payload)
}

func (w *cpaBasicEvidenceWriter) startJSON() error {
	if w.jsonStarted {
		return nil
	}
	w.jsonStarted = true
	w.Header().Del("Content-Length")
	w.commit()
	return writeResponseBytes(w.ResponseWriter, []byte(cpaBasicJSONPrefix))
}

func (w *cpaBasicEvidenceWriter) inspectJSON(payload []byte) {
	if w.inspectionClosed {
		return
	}
	remaining := maxJSONInspectionBytes - w.inspection.Len()
	if remaining > len(payload) {
		remaining = len(payload)
	}
	if remaining > 0 {
		_, _ = w.inspection.Write(payload[:remaining])
	}
	if remaining < len(payload) {
		w.inspectionClosed = true
	}
}

func (w *cpaBasicEvidenceWriter) finishJSON() error {
	if w.jsonBypass || !w.jsonStarted {
		w.commit()
		return nil
	}

	observation := cpaFrameObservation{}
	cancelled := w.requestCancelled()
	if !cancelled && !w.inspectionClosed && json.Valid(w.inspection.Bytes()) {
		observation = inspectNormalizedJSON(w.inspection.Bytes())
	}
	w.inspection.Reset()

	evidence := cpaBasicEvidence{
		Contract:           cpaBasicEvidenceContract,
		Version:            1,
		ProviderAttemptRef: w.attemptRef,
		CostExposure:       "accruing",
		FinalUsageEvidence: "pending",
		ServiceTier:        observation.serviceTier,
	}
	if !cancelled && observation.terminal {
		evidence.CostExposure = "stopped"
		if observation.failed {
			evidence.FailureClass = failureClassForStatus(w.status)
		}
		if observation.usage != nil {
			evidence.FinalUsageEvidence = "final"
			evidence.TrustedUsage = observation.usage
		}
	}
	if w.status >= http.StatusBadRequest {
		// HTTP status alone cannot prove that Provider cost exposure stopped.
		evidence.CostExposure = "accruing"
		evidence.FinalUsageEvidence = "pending"
		evidence.TrustedUsage = nil
		evidence.FailureClass = failureClassForStatus(w.status)
	}

	switch w.fault {
	case "malformed":
		evidence.Contract = "malformed@1"
	case "mismatched":
		evidence.ProviderAttemptRef += "-mismatch"
	}
	evidenceJSON, err := json.Marshal(evidence)
	if err != nil {
		return err
	}
	suffix := make([]byte, 0, len(evidenceJSON)+16)
	suffix = append(suffix, `,"evidence":`...)
	suffix = append(suffix, evidenceJSON...)
	suffix = append(suffix, '}')
	return writeResponseBytes(w.ResponseWriter, suffix)
}

func (w *cpaBasicEvidenceWriter) writeSSE(payload []byte) error {
	w.commit()
	segmentStart := 0
	for index, character := range payload {
		delimiterLength := w.sseScanner.push(character)
		segmentLength := index + 1 - segmentStart
		if !w.sseFrameOversize && w.sseFrame.Len()+segmentLength > maxSSEFrameInspectionBytes {
			if err := writeResponseBytes(w.ResponseWriter, w.sseFrame.Bytes()); err != nil {
				return err
			}
			w.sseFrame.Reset()
			if err := writeResponseBytes(w.ResponseWriter, payload[segmentStart:index+1]); err != nil {
				return err
			}
			w.sseFrameOversize = true
			segmentStart = index + 1
		}
		if delimiterLength == 0 {
			continue
		}

		frameEnd := index + 1
		if w.sseFrameOversize {
			if err := writeResponseBytes(w.ResponseWriter, payload[segmentStart:frameEnd]); err != nil {
				return err
			}
		} else {
			_, _ = w.sseFrame.Write(payload[segmentStart:frameEnd])
			if err := w.processInspectableSSEFrame(w.sseFrame.Bytes()); err != nil {
				return err
			}
			w.sseFrame.Reset()
		}
		w.sseFrameOversize = false
		w.sseScanner.reset()
		segmentStart = frameEnd
	}

	if segmentStart < len(payload) {
		if w.sseFrameOversize {
			return writeResponseBytes(w.ResponseWriter, payload[segmentStart:])
		}
		_, _ = w.sseFrame.Write(payload[segmentStart:])
	}
	return nil
}

func (w *cpaBasicEvidenceWriter) processInspectableSSEFrame(frame []byte) error {
	observation := inspectSSEFrame(frame)
	if observation.usage != nil {
		w.usage = observation.usage
	}
	if observation.anthropicUsage != nil {
		w.anthropicUsage.merge(observation.anthropicUsage)
	}
	if observation.serviceTier != "" {
		w.serviceTier = observation.serviceTier
	}
	if observation.terminal && !w.evidenceWritten && !w.requestCancelled() {
		evidence := cpaBasicEvidence{
			Contract:           cpaBasicEvidenceContract,
			Version:            1,
			ProviderAttemptRef: w.attemptRef,
			CostExposure:       "stopped",
			FinalUsageEvidence: "pending",
			ServiceTier:        w.serviceTier,
		}
		trustedUsage := w.usage
		if w.anthropicUsage.seen {
			trustedUsage = w.anthropicUsage.trustedUsage()
		}
		if observation.failed {
			evidence.FailureClass = failureClassForStatus(observation.status)
			if trustedUsage == nil {
				// An error without complete usage cannot prove bounded exposure.
				evidence.CostExposure = "accruing"
			} else {
				evidence.FinalUsageEvidence = "final"
				evidence.TrustedUsage = trustedUsage
			}
		} else if trustedUsage != nil {
			evidence.FinalUsageEvidence = "final"
			evidence.TrustedUsage = trustedUsage
		}
		switch w.fault {
		case "missing":
			w.evidenceWritten = true
		case "malformed":
			evidence.Contract = "malformed@1"
			if err := w.writeEvidenceSSEFrame(evidence); err != nil {
				return err
			}
			w.evidenceWritten = true
		case "mismatched":
			evidence.ProviderAttemptRef += "-mismatch"
			if err := w.writeEvidenceSSEFrame(evidence); err != nil {
				return err
			}
			w.evidenceWritten = true
		case "duplicate":
			if err := w.writeEvidenceSSEFrame(evidence); err != nil {
				return err
			}
			if err := w.writeEvidenceSSEFrame(evidence); err != nil {
				return err
			}
			w.evidenceWritten = true
		default:
			if err := w.writeEvidenceSSEFrame(evidence); err != nil {
				return err
			}
			w.evidenceWritten = true
		}
	}
	return writeResponseBytes(w.ResponseWriter, frame)
}

func writeResponseBytes(writer io.Writer, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	written, err := writer.Write(payload)
	if err == nil && written != len(payload) {
		return io.ErrShortWrite
	}
	return err
}

func (w *cpaBasicEvidenceWriter) requestCancelled() bool {
	return w.requestContext != nil && w.requestContext.Err() != nil
}

func (w *cpaBasicEvidenceWriter) writeEvidenceSSEFrame(evidence cpaBasicEvidence) error {
	event := cpaBasicEvidenceEvent{Type: "cpa.basic.evidence", Envelope: evidence}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	frame := make([]byte, 0, len(payload)+48)
	frame = append(frame, "event: cpa.basic.evidence\n"...)
	frame = append(frame, "data: "...)
	frame = append(frame, payload...)
	frame = append(frame, '\n', '\n')
	return writeResponseBytes(w.ResponseWriter, frame)
}

type cpaBasicEvidenceEvent struct {
	Type     string           `json:"type"`
	Envelope cpaBasicEvidence `json:"envelope"`
}

type cpaBasicEvidence struct {
	Contract           string           `json:"contract"`
	Version            int              `json:"version"`
	ProviderAttemptRef string           `json:"providerAttemptRef"`
	CostExposure       string           `json:"costExposure"`
	FinalUsageEvidence string           `json:"finalUsageEvidence"`
	FailureClass       string           `json:"failureClass,omitempty"`
	TrustedUsage       *cpaTrustedUsage `json:"trustedUsage,omitempty"`
	ServiceTier        string           `json:"serviceTier,omitempty"`
}

type cpaTrustedUsage struct {
	InputTokens       int64  `json:"inputTokens"`
	CachedInputTokens int64  `json:"cachedInputTokens"`
	CacheWriteTokens  int64  `json:"cacheWriteTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	TotalTokens       int64  `json:"totalTokens"`
	Source            string `json:"source"`
}

type cpaFrameObservation struct {
	terminal       bool
	failed         bool
	status         int
	usage          *cpaTrustedUsage
	anthropicUsage *cpaAnthropicUsageParts
	serviceTier    string
}

func inspectSSEFrame(frame []byte) cpaFrameObservation {
	eventName, data := parseSSEFrame(frame)
	if bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
		return cpaFrameObservation{}
	}

	value, ok := decodeJSONObject(data)
	if ok && stringValue(value["type"]) == "cpa.basic.evidence" {
		// The namespace is reserved. Provider-shaped or malformed fake events are
		// preserved on the wire but never used as CPA evidence or terminal input.
		return cpaFrameObservation{}
	}
	if eventName == "cpa.basic.evidence" {
		return cpaFrameObservation{}
	}

	observation := inspectNormalizedObject(value)
	eventName = strings.ToLower(strings.TrimSpace(eventName))
	object := strings.ToLower(strings.TrimSpace(stringValue(value["object"])))
	if object == "chat.completion.chunk" {
		// Canonical Chat streams may emit finish_reason before a later usage-only
		// chunk. Only complete normalized usage closes CPA evidence.
		observation.terminal = observation.usage != nil
	}
	observation.anthropicUsage = anthropicSSEUsage(eventName, value)
	switch eventName {
	case "response.completed", "response.done", "message_stop":
		observation.terminal = true
	case "response.failed", "response.incomplete", "error":
		observation.terminal = true
		observation.failed = true
	}
	if !authoritativeSSEUsageEvent(eventName, value, observation.terminal) {
		observation.usage = nil
		observation.anthropicUsage = nil
	}
	if !authoritativeSSEServiceTierEvent(eventName, value) {
		observation.serviceTier = ""
	}
	return observation
}

func authoritativeSSEUsageEvent(eventName string, value map[string]any, terminal bool) bool {
	eventType := strings.ToLower(strings.TrimSpace(stringValue(value["type"])))
	switch eventName {
	case "response.completed", "response.done", "response.failed", "response.incomplete", "message_start", "message_delta", "message_stop", "error":
		return true
	}
	switch eventType {
	case "response.completed", "response.done", "response.failed", "response.incomplete", "message_start", "message_delta", "message_stop", "error":
		return true
	}
	object := strings.ToLower(strings.TrimSpace(stringValue(value["object"])))
	return terminal && (object == "chat.completion.chunk" || object == "chat.completion")
}

func authoritativeSSEServiceTierEvent(eventName string, value map[string]any) bool {
	eventType := strings.ToLower(strings.TrimSpace(stringValue(value["type"])))
	for _, candidate := range []string{eventName, eventType} {
		switch candidate {
		case "response.created", "response.in_progress", "response.completed", "response.done", "response.failed", "response.incomplete":
			return true
		}
	}
	object := strings.ToLower(strings.TrimSpace(stringValue(value["object"])))
	return object == "chat.completion.chunk" || object == "chat.completion"
}

func inspectNormalizedJSON(payload []byte) cpaFrameObservation {
	value, _ := decodeJSONObject(payload)
	return inspectNormalizedObject(value)
}

func inspectNormalizedObject(value map[string]any) cpaFrameObservation {
	if value == nil {
		return cpaFrameObservation{}
	}
	observation := cpaFrameObservation{
		status:      intNumber(value["status"]),
		usage:       normalizedUsage(value),
		serviceTier: normalizedServiceTier(value),
	}
	eventType := strings.ToLower(strings.TrimSpace(stringValue(value["type"])))
	switch eventType {
	case "response.completed", "response.done", "message_stop":
		observation.terminal = true
	case "response.failed", "response.incomplete", "error":
		observation.terminal = true
		observation.failed = true
	}
	if !observation.terminal && hasFinishReason(value["choices"]) {
		observation.terminal = true
	}
	object := strings.ToLower(strings.TrimSpace(stringValue(value["object"])))
	status := strings.ToLower(strings.TrimSpace(stringValue(value["status"])))
	if object == "response" {
		switch status {
		case "completed":
			observation.terminal = true
		case "failed", "incomplete", "cancelled", "canceled":
			observation.terminal = true
			observation.failed = true
		}
	}
	if strings.ToLower(strings.TrimSpace(stringValue(value["type"]))) == "message" && strings.TrimSpace(stringValue(value["stop_reason"])) != "" {
		observation.terminal = true
	}
	if observation.status == 0 {
		observation.status = nestedStatus(value)
	}
	return observation
}

func normalizedUsage(value map[string]any) *cpaTrustedUsage {
	if response := objectValue(value["response"]); response != nil {
		if usage := usageFromObject(objectValue(response["usage"])); usage != nil {
			return usage
		}
	}
	return usageFromObject(objectValue(value["usage"]))
}

func usageFromObject(usage map[string]any) *cpaTrustedUsage {
	if usage == nil || !knownUsageShape(usage) {
		return nil
	}
	input, inputOK := firstInteger(usage, "input_tokens", "prompt_tokens")
	output, outputOK := firstInteger(usage, "output_tokens", "completion_tokens")
	if !inputOK || !outputOK {
		return nil
	}

	total, totalOK := integerValue(usage["total_tokens"])
	var cached int64
	var cacheWrite int64
	if totalOK {
		// OpenAI-compatible normalized usage must explicitly carry both cache
		// dimensions. Omission is unknown and cannot be turned into zero.
		var cachedOK bool
		cached, cachedOK = firstNestedInteger(usage,
			[]string{"input_tokens_details", "cached_tokens"},
			[]string{"prompt_tokens_details", "cached_tokens"},
		)
		var cacheWriteOK bool
		cacheWrite, cacheWriteOK = firstNestedInteger(usage,
			[]string{"input_tokens_details", "cache_write_tokens"},
			[]string{"input_tokens_details", "cache_creation_tokens"},
			[]string{"prompt_tokens_details", "cache_write_tokens"},
			[]string{"prompt_tokens_details", "cache_creation_tokens"},
			[]string{"prompt_tokens_details", "cached_creation_tokens"},
		)
		if !cachedOK || !cacheWriteOK {
			return nil
		}
	} else {
		// Anthropic normalized usage reports cache buckets independently and has
		// no total_tokens field. Both fields must be explicit; omission is unknown.
		var cacheReadOK bool
		var cacheCreationOK bool
		cached, cacheReadOK = integerValue(usage["cache_read_input_tokens"])
		cacheWrite, cacheCreationOK = integerValue(usage["cache_creation_input_tokens"])
		if !cacheReadOK || !cacheCreationOK {
			return nil
		}
		return trustedAnthropicUsage(input, output, cached, cacheWrite)
	}
	if cached > input || cacheWrite > input-cached || input > maxJSONSafeInteger-output || total != input+output {
		return nil
	}
	return &cpaTrustedUsage{
		InputTokens:       input,
		CachedInputTokens: cached,
		CacheWriteTokens:  cacheWrite,
		OutputTokens:      output,
		TotalTokens:       total,
		Source:            "provider",
	}
}

func knownUsageShape(usage map[string]any) bool {
	for key := range usage {
		switch key {
		case "input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "total_tokens",
			"input_tokens_details", "prompt_tokens_details", "output_tokens_details", "completion_tokens_details",
			"cache_read_input_tokens", "cache_creation_input_tokens":
			continue
		default:
			// Unknown dimensions may be independently billable. This contract cannot
			// safely omit them from exact usage evidence.
			return false
		}
	}
	return true
}

type cpaOptionalInteger struct {
	value int64
	set   bool
}

type cpaAnthropicUsageParts struct {
	seen        bool
	invalid     bool
	input       cpaOptionalInteger
	cached      cpaOptionalInteger
	cacheWrite  cpaOptionalInteger
	output      cpaOptionalInteger
	outputFinal bool
}

type cpaAnthropicUsageAccumulator struct {
	cpaAnthropicUsageParts
}

func (usage *cpaAnthropicUsageAccumulator) merge(parts *cpaAnthropicUsageParts) {
	if parts == nil {
		return
	}
	usage.seen = usage.seen || parts.seen
	usage.invalid = usage.invalid || parts.invalid
	usage.outputFinal = usage.outputFinal || parts.outputFinal
	for _, dimension := range []struct {
		source cpaOptionalInteger
		target *cpaOptionalInteger
	}{
		{source: parts.input, target: &usage.input},
		{source: parts.cached, target: &usage.cached},
		{source: parts.cacheWrite, target: &usage.cacheWrite},
		{source: parts.output, target: &usage.output},
	} {
		if dimension.source.set {
			*dimension.target = dimension.source
		}
	}
}

func (usage *cpaAnthropicUsageAccumulator) trustedUsage() *cpaTrustedUsage {
	if !usage.seen || usage.invalid || !usage.input.set || !usage.cached.set || !usage.cacheWrite.set || !usage.output.set || !usage.outputFinal {
		return nil
	}
	return trustedAnthropicUsage(usage.input.value, usage.output.value, usage.cached.value, usage.cacheWrite.value)
}

func anthropicSSEUsage(eventName string, value map[string]any) *cpaAnthropicUsageParts {
	if value == nil {
		return nil
	}
	eventType := strings.ToLower(strings.TrimSpace(stringValue(value["type"])))
	kind := eventName
	if kind != "message_start" && kind != "message_delta" && kind != "message_stop" {
		kind = eventType
	}
	var usage map[string]any
	switch kind {
	case "message_start":
		if message := objectValue(value["message"]); message != nil {
			usage = objectValue(message["usage"])
		}
	case "message_delta", "message_stop":
		usage = objectValue(value["usage"])
	}
	parts := anthropicUsagePartsFromObject(usage)
	if parts != nil && (kind == "message_delta" || kind == "message_stop") && parts.output.set {
		parts.outputFinal = true
	}
	return parts
}

func anthropicUsagePartsFromObject(usage map[string]any) *cpaAnthropicUsageParts {
	if usage == nil {
		return nil
	}
	if !knownUsageShape(usage) {
		return &cpaAnthropicUsageParts{seen: true, invalid: true}
	}
	parts := &cpaAnthropicUsageParts{}
	for _, dimension := range []struct {
		key    string
		target *cpaOptionalInteger
	}{
		{key: "input_tokens", target: &parts.input},
		{key: "cache_read_input_tokens", target: &parts.cached},
		{key: "cache_creation_input_tokens", target: &parts.cacheWrite},
		{key: "output_tokens", target: &parts.output},
	} {
		raw, exists := usage[dimension.key]
		if !exists {
			continue
		}
		parts.seen = true
		value, ok := integerValue(raw)
		if !ok {
			parts.invalid = true
			continue
		}
		*dimension.target = cpaOptionalInteger{value: value, set: true}
	}
	if !parts.seen {
		return nil
	}
	return parts
}

func trustedAnthropicUsage(input, output, cached, cacheWrite int64) *cpaTrustedUsage {
	if input > maxJSONSafeInteger-cached {
		return nil
	}
	input += cached
	if input > maxJSONSafeInteger-cacheWrite {
		return nil
	}
	input += cacheWrite
	if input > maxJSONSafeInteger-output {
		return nil
	}
	return &cpaTrustedUsage{
		InputTokens:       input,
		CachedInputTokens: cached,
		CacheWriteTokens:  cacheWrite,
		OutputTokens:      output,
		TotalTokens:       input + output,
		Source:            "provider",
	}
}

func evidenceTestFault() string {
	fault := strings.ToLower(strings.TrimSpace(os.Getenv(cpaBasicEvidenceTestFaultEnv)))
	switch fault {
	case "missing", "malformed", "mismatched", "duplicate":
		return fault
	default:
		return ""
	}
}

func normalizedServiceTier(value map[string]any) string {
	if response := objectValue(value["response"]); response != nil {
		if tier := boundedServiceTier(response["service_tier"]); tier != "" {
			return tier
		}
	}
	return boundedServiceTier(value["service_tier"])
}

func boundedServiceTier(value any) string {
	tier, ok := value.(string)
	if !ok || len(tier) == 0 || len(tier) > 64 {
		return ""
	}
	return tier
}

func hasFinishReason(value any) bool {
	choices, ok := value.([]any)
	if !ok {
		return false
	}
	for _, choiceValue := range choices {
		choice := objectValue(choiceValue)
		if choice == nil {
			continue
		}
		finishReason, exists := choice["finish_reason"]
		if exists && finishReason != nil && strings.TrimSpace(stringValue(finishReason)) != "" {
			return true
		}
	}
	return false
}

func nestedStatus(value map[string]any) int {
	for _, path := range [][]string{{"error", "status"}, {"response", "status"}, {"response", "error", "status"}} {
		current := any(value)
		for _, key := range path {
			object := objectValue(current)
			if object == nil {
				current = nil
				break
			}
			current = object[key]
		}
		if status := intNumber(current); status != 0 {
			return status
		}
	}
	return 0
}

func failureClassForStatus(status int) string {
	switch {
	case status == http.StatusTooManyRequests:
		return "rate_limited"
	case status >= http.StatusInternalServerError:
		return "upstream_5xx"
	default:
		return "non_retryable"
	}
}

func decodeJSONObject(payload []byte) (map[string]any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, false
	}
	object := objectValue(value)
	return object, object != nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return err
	}
	return nil
}

func objectValue(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func integerValue(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || parsed < 0 || parsed > maxJSONSafeInteger {
		return 0, false
	}
	return parsed, true
}

func intNumber(value any) int {
	parsed, ok := integerValue(value)
	if !ok || parsed > int64(^uint(0)>>1) {
		return 0
	}
	return int(parsed)
}

func firstInteger(value map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		if parsed, ok := integerValue(value[key]); ok {
			return parsed, true
		}
	}
	return 0, false
}

func nestedInteger(value map[string]any, path []string) (int64, bool) {
	current := any(value)
	for _, key := range path {
		object := objectValue(current)
		if object == nil {
			return 0, false
		}
		current = object[key]
	}
	return integerValue(current)
}

func firstNestedInteger(value map[string]any, paths ...[]string) (int64, bool) {
	for _, path := range paths {
		if parsed, ok := nestedInteger(value, path); ok {
			return parsed, true
		}
	}
	return 0, false
}

func parseSSEFrame(frame []byte) (string, []byte) {
	normalized := bytes.ReplaceAll(frame, []byte("\r\n"), []byte("\n"))
	normalized = bytes.ReplaceAll(normalized, []byte("\r"), []byte("\n"))
	var eventName string
	var dataLines [][]byte
	for _, line := range bytes.Split(normalized, []byte("\n")) {
		if len(line) == 0 || line[0] == ':' {
			continue
		}
		field, value, found := bytes.Cut(line, []byte(":"))
		if !found {
			value = nil
		}
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
		switch string(field) {
		case "event":
			eventName = string(value)
		case "data":
			dataLines = append(dataLines, bytes.Clone(value))
		}
	}
	return eventName, bytes.Join(dataLines, []byte("\n"))
}

func takeCompleteSSEFrame(buffer *bytes.Buffer) ([]byte, bool) {
	data := buffer.Bytes()
	start, delimiterLength := sseFrameDelimiter(data)
	if start < 0 {
		return nil, false
	}
	length := start + delimiterLength
	frame := bytes.Clone(data[:length])
	buffer.Next(length)
	return frame, true
}

func sseFrameDelimiter(data []byte) (int, int) {
	var scanner sseDelimiterScanner
	for index, character := range data {
		if delimiterLength := scanner.push(character); delimiterLength > 0 {
			return index + 1 - delimiterLength, delimiterLength
		}
	}
	return -1, 0
}

type sseDelimiterScanner struct {
	tail   [4]byte
	length int
}

func (scanner *sseDelimiterScanner) push(character byte) int {
	if scanner.length < len(scanner.tail) {
		scanner.tail[scanner.length] = character
		scanner.length++
	} else {
		copy(scanner.tail[:], scanner.tail[1:])
		scanner.tail[len(scanner.tail)-1] = character
	}

	length := scanner.length
	if length >= 4 && scanner.tail[length-4] == '\r' && scanner.tail[length-3] == '\n' && scanner.tail[length-2] == '\r' && scanner.tail[length-1] == '\n' {
		return 4
	}
	if length >= 3 {
		first := scanner.tail[length-3]
		second := scanner.tail[length-2]
		third := scanner.tail[length-1]
		if (first == '\r' && second == '\n' && third == '\n') || (first == '\n' && second == '\r' && third == '\n') {
			return 3
		}
	}
	if length >= 2 {
		first := scanner.tail[length-2]
		second := scanner.tail[length-1]
		if (first == '\n' && second == '\n') || (first == '\r' && second == '\r') {
			return 2
		}
	}
	return 0
}

func (scanner *sseDelimiterScanner) reset() {
	scanner.length = 0
}
