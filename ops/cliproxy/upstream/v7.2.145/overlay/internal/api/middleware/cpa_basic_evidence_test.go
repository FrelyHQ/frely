package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const testProviderAttemptRef = "provider_attempt_exact_1"

func TestCPABasicEvidenceWrapsNonStreamingJSON(t *testing.T) {
	publicBody := ` {"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13,"input_tokens_details":{"cached_tokens":2,"cache_write_tokens":0}}} `
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		_, _ = c.Writer.Write([]byte(publicBody))
	})

	if got := recorder.Header().Get("X-Request-Id"); got != testProviderAttemptRef {
		t.Fatalf("X-Request-Id = %q, want exact %q", got, testProviderAttemptRef)
	}
	var envelope struct {
		Contract string           `json:"contract"`
		Version  int              `json:"version"`
		Response json.RawMessage  `json:"response"`
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v; body=%s", err, recorder.Body.String())
	}
	if envelope.Contract != cpaBasicJSONContract || envelope.Version != 1 {
		t.Fatalf("envelope contract/version = %q/%d", envelope.Contract, envelope.Version)
	}
	if !jsonEqual(envelope.Response, []byte(publicBody)) {
		t.Fatalf("public response changed: got=%s want=%s", envelope.Response, publicBody)
	}
	assertEvidence(t, envelope.Evidence, "stopped", "final", "")
	wantUsage := cpaTrustedUsage{
		InputTokens:       9,
		CachedInputTokens: 2,
		CacheWriteTokens:  0,
		OutputTokens:      4,
		TotalTokens:       13,
		Source:            "provider",
	}
	if envelope.Evidence.TrustedUsage == nil || *envelope.Evidence.TrustedUsage != wantUsage {
		t.Fatalf("trusted usage = %+v, want %+v", envelope.Evidence.TrustedUsage, wantUsage)
	}
}

func TestCPABasicEvidenceWrapsNonStreamingErrorAsPending(t *testing.T) {
	publicBody := `{"error":{"type":"server_error","message":"upstream unavailable"}}`
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		c.Status(http.StatusBadGateway)
		_, _ = c.Writer.Write([]byte(publicBody))
	})

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadGateway)
	}
	var envelope struct {
		Response json.RawMessage  `json:"response"`
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope: %v; body=%s", err, recorder.Body.String())
	}
	if !jsonEqual(envelope.Response, []byte(publicBody)) {
		t.Fatalf("public error changed: got=%s want=%s", envelope.Response, publicBody)
	}
	assertEvidence(t, envelope.Evidence, "accruing", "pending", "upstream_5xx")
	if envelope.Evidence.TrustedUsage != nil {
		t.Fatalf("HTTP error invented usage: %+v", envelope.Evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceInjectsBeforeSSETerminal(t *testing.T) {
	created := "event: response.created\r\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\r\n\r\n"
	terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"service_tier\":\"priority\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3,\"total_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":1,\"cache_write_tokens\":0}}}}\n\n"
	done := "data: [DONE]\n\n"
	publicBody := created + terminal + done

	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(created[:31]))
		c.Writer.Flush()
		_, _ = c.Writer.Write([]byte(created[31:] + terminal[:43]))
		_, _ = c.Writer.Write([]byte(terminal[43:] + done))
	})

	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	if len(frames) != 4 {
		t.Fatalf("frame count = %d, want 4; body=%q", len(frames), recorder.Body.String())
	}
	evidence, ok := evidenceFromFrame(frames[1])
	if !ok {
		t.Fatalf("second frame is not generated evidence: %q", frames[1])
	}
	assertEvidence(t, evidence, "stopped", "final", "")
	if evidence.ServiceTier != "priority" {
		t.Fatalf("service tier = %q, want priority", evidence.ServiceTier)
	}
	if evidence.TrustedUsage == nil || evidence.TrustedUsage.TotalTokens != 10 || evidence.TrustedUsage.CachedInputTokens != 1 {
		t.Fatalf("trusted usage = %+v", evidence.TrustedUsage)
	}
	publicFrames := []string{frames[0], frames[2], frames[3]}
	if got := strings.Join(publicFrames, ""); got != publicBody {
		t.Fatalf("public SSE bytes/framing changed:\ngot  %q\nwant %q", got, publicBody)
	}
}

func TestCPABasicEvidenceNormalizesCanonicalAnthropicSSEUsageAtMessageStop(t *testing.T) {
	t.Run("split usage becomes final", func(t *testing.T) {
		start := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":3,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":7,\"output_tokens\":1}}}\n\n"
		delta := "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":11}}\n\n"
		stop := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
		publicBody := start + delta + stop

		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			_, _ = c.Writer.Write([]byte(start[:37]))
			_, _ = c.Writer.Write([]byte(start[37:] + delta + stop[:19]))
			_, _ = c.Writer.Write([]byte(stop[19:]))
		})

		frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
		if len(frames) != 4 {
			t.Fatalf("frame count = %d, want start + delta + evidence + stop", len(frames))
		}
		evidence, ok := evidenceFromFrame(frames[2])
		if !ok {
			t.Fatalf("missing evidence before message_stop: %q", frames[2])
		}
		assertEvidence(t, evidence, "stopped", "final", "")
		wantUsage := cpaTrustedUsage{
			InputTokens:       15,
			CachedInputTokens: 5,
			CacheWriteTokens:  7,
			OutputTokens:      11,
			TotalTokens:       26,
			Source:            "provider",
		}
		if evidence.TrustedUsage == nil || *evidence.TrustedUsage != wantUsage {
			t.Fatalf("Anthropic trusted usage = %+v, want %+v", evidence.TrustedUsage, wantUsage)
		}
		if got := frames[0] + frames[1] + frames[3]; got != publicBody {
			t.Fatalf("Anthropic public bytes changed: got=%q want=%q", got, publicBody)
		}
	})

	t.Run("omitted cache dimension remains pending", func(t *testing.T) {
		start := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":3,\"cache_read_input_tokens\":5}}}\n\n"
		delta := "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":11}}\n\n"
		stop := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			_, _ = c.Writer.Write([]byte(start + delta + stop))
		})
		frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
		if len(frames) != 4 {
			t.Fatalf("frame count = %d, want 4", len(frames))
		}
		evidence, ok := evidenceFromFrame(frames[2])
		if !ok {
			t.Fatalf("missing pending evidence: %q", frames[2])
		}
		assertEvidence(t, evidence, "stopped", "pending", "")
		if evidence.TrustedUsage != nil {
			t.Fatalf("omitted Anthropic dimension was defaulted: %+v", evidence.TrustedUsage)
		}
	})

	t.Run("message_start output is not final without message_delta usage", func(t *testing.T) {
		start := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":3,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0,\"output_tokens\":0}}}\n\n"
		stop := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			_, _ = c.Writer.Write([]byte(start + stop))
		})
		frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
		evidence, ok := evidenceFromFrame(frames[1])
		if !ok {
			t.Fatalf("missing pending evidence: %#v", frames)
		}
		assertEvidence(t, evidence, "stopped", "pending", "")
	})
}

func TestCPABasicEvidenceFailedStreamSettlesCompleteUsage(t *testing.T) {
	failed := "event: response.failed\ndata: {\"type\":\"response.failed\",\"status\":500,\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":0,\"cache_write_tokens\":0}}}}\n\n"
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(failed))
	})
	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	evidence, ok := evidenceFromFrame(frames[0])
	if !ok {
		t.Fatalf("missing failed evidence: %#v", frames)
	}
	assertEvidence(t, evidence, "stopped", "final", "upstream_5xx")
	if evidence.TrustedUsage == nil || evidence.TrustedUsage.TotalTokens != 5 {
		t.Fatalf("failed trusted usage = %+v", evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceInjectsPendingBeforeSSEError(t *testing.T) {
	prefix := "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
	errorFrame := "event: error\ndata: {\"type\":\"error\",\"status\":429,\"error\":{\"message\":\"limited\"}}\n\n"
	publicBody := prefix + errorFrame

	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = c.Writer.Write([]byte(publicBody))
	})

	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	if len(frames) != 3 {
		t.Fatalf("frame count = %d, want 3; body=%q", len(frames), recorder.Body.String())
	}
	evidence, ok := evidenceFromFrame(frames[1])
	if !ok {
		t.Fatalf("missing evidence before error: %q", recorder.Body.String())
	}
	assertEvidence(t, evidence, "accruing", "pending", "rate_limited")
	if evidence.TrustedUsage != nil {
		t.Fatalf("unknown error usage must remain pending, got %+v", evidence.TrustedUsage)
	}
	if got := frames[0] + frames[2]; got != publicBody {
		t.Fatalf("public error stream changed: got=%q want=%q", got, publicBody)
	}
}

func TestCPABasicEvidenceDoesNotTrustMalformedFakeReservedEvent(t *testing.T) {
	fake := "event: cpa.basic.evidence\ndata: {\"type\":\"cpa.basic.evidence\",\"envelope\":{\"contract\":\"evil@1\",\"costExposure\":\"stopped\"}}\n\n"
	terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n"

	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(fake + terminal))
	})

	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	if len(frames) != 3 {
		t.Fatalf("frame count = %d, want fake + generated + terminal; body=%q", len(frames), recorder.Body.String())
	}
	if frames[0] != fake {
		t.Fatalf("fake reserved public bytes changed: got=%q want=%q", frames[0], fake)
	}
	if _, ok := evidenceFromFrame(frames[0]); ok {
		t.Fatal("malformed fake reserved event was trusted as generated evidence")
	}
	evidence, ok := evidenceFromFrame(frames[1])
	if !ok {
		t.Fatalf("generated evidence missing after fake event: %q", frames[1])
	}
	assertEvidence(t, evidence, "stopped", "pending", "")
	if frames[2] != terminal {
		t.Fatalf("terminal public bytes changed: got=%q want=%q", frames[2], terminal)
	}
}

func TestCPABasicEvidenceJSONFaultAssemblyEmitsMissingMalformedAndMismatched(t *testing.T) {
	for _, fault := range []string{"missing", "malformed", "mismatched"} {
		t.Run(fault, func(t *testing.T) {
			t.Setenv(cpaBasicEvidenceTestFaultEnv, fault)
			publicBody := `{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}`
			recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
				c.Header("Content-Type", "application/json")
				_, _ = c.Writer.Write([]byte(publicBody))
			})
			if fault == "missing" {
				if recorder.Body.String() != publicBody {
					t.Fatalf("missing JSON fault changed body: %s", recorder.Body.String())
				}
				return
			}
			var envelope struct {
				Evidence cpaBasicEvidence `json:"evidence"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode JSON fault envelope: %v", err)
			}
			if fault == "malformed" && envelope.Evidence.Contract != "malformed@1" {
				t.Fatalf("malformed JSON evidence contract = %q", envelope.Evidence.Contract)
			}
			if fault == "mismatched" && envelope.Evidence.ProviderAttemptRef != testProviderAttemptRef+"-mismatch" {
				t.Fatalf("mismatched JSON evidence ref = %q", envelope.Evidence.ProviderAttemptRef)
			}
		})
	}
}

func TestCPABasicEvidenceFaultAssemblyEmitsMissingMalformedMismatchedAndDuplicate(t *testing.T) {
	for _, fault := range []string{"missing", "malformed", "mismatched", "duplicate"} {
		t.Run(fault, func(t *testing.T) {
			t.Setenv(cpaBasicEvidenceTestFaultEnv, fault)
			terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":0,\"cache_write_tokens\":0}}}}\n\n"
			recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
				c.Header("Content-Type", "text/event-stream")
				_, _ = c.Writer.Write([]byte(terminal))
			})
			frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
			switch fault {
			case "missing":
				if len(frames) != 1 || frames[0] != terminal {
					t.Fatalf("missing fault frames = %#v", frames)
				}
			case "malformed":
				if len(frames) != 2 {
					t.Fatalf("malformed fault frame count = %d", len(frames))
				}
				_, data := parseSSEFrame([]byte(frames[0]))
				if !bytes.Contains(data, []byte(`"contract":"malformed@1"`)) {
					t.Fatalf("malformed fault evidence = %s", data)
				}
			case "mismatched":
				if len(frames) != 2 {
					t.Fatalf("mismatched fault frame count = %d", len(frames))
				}
				_, data := parseSSEFrame([]byte(frames[0]))
				if !bytes.Contains(data, []byte(testProviderAttemptRef+"-mismatch")) {
					t.Fatalf("mismatched fault evidence = %s", data)
				}
			case "duplicate":
				if len(frames) != 3 {
					t.Fatalf("duplicate fault frame count = %d", len(frames))
				}
				first, firstOK := evidenceFromFrame(frames[0])
				second, secondOK := evidenceFromFrame(frames[1])
				if !firstOK || !secondOK || !valuesEqual(first, second) {
					t.Fatalf("duplicate evidence mismatch: %#v / %#v", first, second)
				}
			}
		})
	}
}

func TestCPABasicEvidenceUnknownUsageRemainsPending(t *testing.T) {
	publicBody := `{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		_, _ = c.Writer.Write([]byte(publicBody))
	})
	var envelope struct {
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode unknown usage envelope: %v", err)
	}
	assertEvidence(t, envelope.Evidence, "stopped", "pending", "")
	if envelope.Evidence.TrustedUsage != nil {
		t.Fatalf("unknown cache usage was defaulted: %+v", envelope.Evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceRequiresCompleteCacheDimensionsAndAcceptsExplicitAnthropicUsage(t *testing.T) {
	t.Run("missing cache write remains pending", func(t *testing.T) {
		publicBody := `{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}`
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "application/json")
			_, _ = c.Writer.Write([]byte(publicBody))
		})
		var envelope struct {
			Evidence cpaBasicEvidence `json:"evidence"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode incomplete cache envelope: %v", err)
		}
		assertEvidence(t, envelope.Evidence, "stopped", "pending", "")
	})

	t.Run("explicit Anthropic cache dimensions become final", func(t *testing.T) {
		publicBody := `{"id":"msg_1","type":"message","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "application/json")
			_, _ = c.Writer.Write([]byte(publicBody))
		})
		var envelope struct {
			Evidence cpaBasicEvidence `json:"evidence"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode Anthropic envelope: %v", err)
		}
		assertEvidence(t, envelope.Evidence, "stopped", "final", "")
		if envelope.Evidence.TrustedUsage == nil || envelope.Evidence.TrustedUsage.TotalTokens != 2 {
			t.Fatalf("Anthropic trusted usage = %+v", envelope.Evidence.TrustedUsage)
		}
	})
}

func TestCPABasicEvidenceAcceptsTranslatedChatCachedCreationTokens(t *testing.T) {
	publicBody := `{"id":"chatcmpl_1","object":"chat.completion","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":5,"cached_creation_tokens":3}}}`
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		_, _ = c.Writer.Write([]byte(publicBody))
	})
	var envelope struct {
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode translated Chat envelope: %v", err)
	}
	assertEvidence(t, envelope.Evidence, "stopped", "final", "")
	wantUsage := cpaTrustedUsage{
		InputTokens:       12,
		CachedInputTokens: 5,
		CacheWriteTokens:  3,
		OutputTokens:      4,
		TotalTokens:       16,
		Source:            "provider",
	}
	if envelope.Evidence.TrustedUsage == nil || *envelope.Evidence.TrustedUsage != wantUsage {
		t.Fatalf("translated Chat trusted usage = %+v, want %+v", envelope.Evidence.TrustedUsage, wantUsage)
	}
}

func TestCPABasicEvidenceWaitsForCanonicalChatUsageOnlyChunk(t *testing.T) {
	finish := "data: {\"id\":\"chat_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n"
	usage := "data: {\"id\":\"chat_1\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6,\"prompt_tokens_details\":{\"cached_tokens\":1,\"cached_creation_tokens\":0}}}\n\n"
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(finish + usage))
	})
	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	if len(frames) != 3 || frames[0] != finish || frames[2] != usage {
		t.Fatalf("chat frames = %#v", frames)
	}
	evidence, ok := evidenceFromFrame(frames[1])
	if !ok {
		t.Fatalf("missing chat evidence: %q", frames[1])
	}
	assertEvidence(t, evidence, "stopped", "final", "")
	if evidence.TrustedUsage == nil || evidence.TrustedUsage.TotalTokens != 6 {
		t.Fatalf("chat trusted usage = %+v", evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceRejectsUnknownBillableDimensionsAndNonTerminalJSON(t *testing.T) {
	t.Run("unknown billable dimension remains pending", func(t *testing.T) {
		body := `{"id":"msg_1","type":"message","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":1}}}`
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "application/json")
			_, _ = c.Writer.Write([]byte(body))
		})
		var envelope struct {
			Evidence cpaBasicEvidence `json:"evidence"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode unknown dimension envelope: %v", err)
		}
		assertEvidence(t, envelope.Evidence, "stopped", "pending", "")
	})

	t.Run("accepted in-progress response remains accruing", func(t *testing.T) {
		body := `{"id":"resp_1","object":"response","status":"in_progress","usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}`
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "application/json")
			_, _ = c.Writer.Write([]byte(body))
		})
		var envelope struct {
			Evidence cpaBasicEvidence `json:"evidence"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode in-progress envelope: %v", err)
		}
		assertEvidence(t, envelope.Evidence, "accruing", "pending", "")
	})
}

func TestCPABasicEvidenceStreamsOversizedJSONInsideEnvelopeAsPending(t *testing.T) {
	writer, recorder := newDirectCPABasicTestWriter("application/json")
	publicBody := `{"id":"resp_large","output":"` + strings.Repeat("x", maxJSONInspectionBytes+4096) + `","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13,"input_tokens_details":{"cached_tokens":2,"cache_write_tokens":0}}}`
	for offset := 0; offset < len(publicBody); {
		end := offset + 8191
		if end > len(publicBody) {
			end = len(publicBody)
		}
		if _, err := writer.Write([]byte(publicBody[offset:end])); err != nil {
			t.Fatalf("write oversized JSON: %v", err)
		}
		offset = end
	}
	if !writer.inspectionClosed || writer.inspection.Len() != maxJSONInspectionBytes {
		t.Fatalf("JSON inspection state = closed:%t bytes:%d, want closed and %d", writer.inspectionClosed, writer.inspection.Len(), maxJSONInspectionBytes)
	}
	if got, want := recorder.Body.String(), cpaBasicJSONPrefix+publicBody; got != want {
		t.Fatalf("JSON was not raw-streamed before finish: got bytes=%d want bytes=%d", len(got), len(want))
	}
	if err := writer.finish(); err != nil {
		t.Fatalf("finish oversized JSON: %v", err)
	}
	var envelope struct {
		Response json.RawMessage  `json:"response"`
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode oversized JSON envelope: %v", err)
	}
	if !bytes.Equal(envelope.Response, []byte(publicBody)) {
		t.Fatalf("oversized public JSON changed: got bytes=%d want bytes=%d", len(envelope.Response), len(publicBody))
	}
	assertEvidence(t, envelope.Evidence, "accruing", "pending", "")
	if envelope.Evidence.TrustedUsage != nil {
		t.Fatalf("oversized usage was trusted: %+v", envelope.Evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceBoundsOversizedSSEInspectionAndPreservesBytes(t *testing.T) {
	t.Run("multi-MiB unfinished comment", func(t *testing.T) {
		writer, recorder := newDirectCPABasicTestWriter("text/event-stream")
		publicBody := []byte(":" + strings.Repeat("x", 3*1024*1024))
		for offset := 0; offset < len(publicBody); {
			end := offset + 7919
			if end > len(publicBody) {
				end = len(publicBody)
			}
			if _, err := writer.Write(publicBody[offset:end]); err != nil {
				t.Fatalf("write unfinished comment: %v", err)
			}
			if writer.sseFrame.Len() > maxSSEFrameInspectionBytes {
				t.Fatalf("SSE inspection retained %d bytes, max %d", writer.sseFrame.Len(), maxSSEFrameInspectionBytes)
			}
			offset = end
		}
		if !writer.sseFrameOversize || writer.sseFrame.Len() != 0 {
			t.Fatalf("unfinished comment state = oversized:%t buffered:%d", writer.sseFrameOversize, writer.sseFrame.Len())
		}
		if err := writer.finish(); err != nil {
			t.Fatalf("finish unfinished comment: %v", err)
		}
		if !bytes.Equal(recorder.Body.Bytes(), publicBody) {
			t.Fatalf("unfinished comment bytes changed: got=%d want=%d", recorder.Body.Len(), len(publicBody))
		}
		if bytes.Contains(recorder.Body.Bytes(), []byte(`"contract":"cpa-basic@1"`)) {
			t.Fatal("unfinished comment produced evidence")
		}
	})

	t.Run("multi-MiB frame followed by inspectable terminal", func(t *testing.T) {
		writer, recorder := newDirectCPABasicTestWriter("text/event-stream")
		largeFrame := "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"" + strings.Repeat("x", 3*1024*1024) + "\"}\r\n\r\n"
		terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n"
		publicBody := []byte(largeFrame + terminal)
		for offset := 0; offset < len(publicBody); {
			end := offset + 16381
			if end > len(publicBody) {
				end = len(publicBody)
			}
			if _, err := writer.Write(publicBody[offset:end]); err != nil {
				t.Fatalf("write large SSE frame: %v", err)
			}
			if writer.sseFrame.Len() > maxSSEFrameInspectionBytes {
				t.Fatalf("SSE inspection retained %d bytes, max %d", writer.sseFrame.Len(), maxSSEFrameInspectionBytes)
			}
			offset = end
		}
		if err := writer.finish(); err != nil {
			t.Fatalf("finish large SSE frame: %v", err)
		}
		frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
		if len(frames) != 3 || frames[0] != largeFrame || frames[2] != terminal {
			t.Fatalf("large SSE public framing changed: frame count=%d", len(frames))
		}
		evidence, ok := evidenceFromFrame(frames[1])
		if !ok {
			t.Fatalf("missing evidence before inspectable terminal: %q", frames[1])
		}
		assertEvidence(t, evidence, "stopped", "pending", "")
		if got := frames[0] + frames[2]; got != string(publicBody) {
			t.Fatalf("large SSE public bytes changed: got=%d want=%d", len(got), len(publicBody))
		}
	})
}

func TestCPABasicEvidenceIgnoresUsageOnUnknownSSEEvents(t *testing.T) {
	unknown := "event: response.future\ndata: {\"type\":\"response.future\",\"usage\":{\"input_tokens\":99,\"output_tokens\":99,\"total_tokens\":198,\"input_tokens_details\":{\"cached_tokens\":0,\"cache_write_tokens\":0}}}\n\n"
	terminal := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n"
	recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(unknown + terminal))
	})
	frames := splitCompleteSSEFrames(t, recorder.Body.Bytes())
	if len(frames) != 3 || frames[0] != unknown || frames[2] != terminal {
		t.Fatalf("unknown event framing changed: %#v", frames)
	}
	evidence, ok := evidenceFromFrame(frames[1])
	if !ok {
		t.Fatalf("generated evidence missing: %q", frames[1])
	}
	assertEvidence(t, evidence, "stopped", "pending", "")
	if evidence.TrustedUsage != nil {
		t.Fatalf("unknown event injected usage: %+v", evidence.TrustedUsage)
	}
}

func TestCPABasicEvidenceFinalizesRecoveredPanicsAsSafePendingErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CPABasicEvidenceMiddleware())
	router.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		c.AbortWithStatus(http.StatusInternalServerError)
	}))
	router.POST("/v1/responses", func(*gin.Context) { panic("private panic sentinel") })
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set("X-Friday-CPA-Evidence-Contract", cpaBasicEvidenceContract)
	request.Header.Set("X-Request-Id", testProviderAttemptRef)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError || strings.Contains(recorder.Body.String(), "sentinel") {
		t.Fatalf("panic response = %d %q", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Evidence cpaBasicEvidence `json:"evidence"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode panic envelope: %v", err)
	}
	assertEvidence(t, envelope.Evidence, "accruing", "pending", "upstream_5xx")
}

func TestCPABasicEvidenceDoesNotTreatCleanEOForCancelAsTerminal(t *testing.T) {
	nonTerminal := "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"

	t.Run("clean EOF", func(t *testing.T) {
		recorder := serveCPABasicTestRequest(t, context.Background(), func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			_, _ = c.Writer.Write([]byte(nonTerminal))
		})
		assertNoEvidenceAndExactBody(t, recorder.Body.String(), nonTerminal)
	})

	t.Run("request cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		recorder := serveCPABasicTestRequest(t, ctx, func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			_, _ = c.Writer.Write([]byte(nonTerminal))
			c.Writer.Flush()
			cancel()
		})
		assertNoEvidenceAndExactBody(t, recorder.Body.String(), nonTerminal)
	})
}

func TestCPABasicEvidenceRequiresExactNegotiationHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name      string
		contract  string
		requestID string
	}{
		{name: "wrong contract", contract: "cpa-basic@2", requestID: testProviderAttemptRef},
		{name: "missing request id", contract: cpaBasicEvidenceContract},
		{name: "unsafe request id", contract: cpaBasicEvidenceContract, requestID: "provider attempt secret"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			router := gin.New()
			router.Use(CPABasicEvidenceMiddleware())
			router.POST("/v1/responses", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"id": "resp_passthrough"})
			})
			request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
			request.Header.Set("X-Friday-CPA-Evidence-Contract", testCase.contract)
			if testCase.requestID != "" {
				request.Header.Set("X-Request-Id", testCase.requestID)
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if strings.Contains(recorder.Body.String(), cpaBasicJSONContract) {
				t.Fatalf("inexact negotiation was adapted: %s", recorder.Body.String())
			}
		})
	}
}

func newDirectCPABasicTestWriter(contentType string) (*cpaBasicEvidenceWriter, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	writer := newCPABasicEvidenceWriter(ginContext.Writer, context.Background(), testProviderAttemptRef)
	writer.Header().Set("Content-Type", contentType)
	return writer, recorder
}

func serveCPABasicTestRequest(t *testing.T, ctx context.Context, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(CPABasicEvidenceMiddleware())
	router.POST("/v1/responses", handler)
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil).WithContext(ctx)
	request.Header.Set("X-Friday-CPA-Evidence-Contract", cpaBasicEvidenceContract)
	request.Header.Set("X-Request-Id", testProviderAttemptRef)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func splitCompleteSSEFrames(t *testing.T, payload []byte) []string {
	t.Helper()
	buffer := bytes.NewBuffer(bytes.Clone(payload))
	var frames []string
	for buffer.Len() > 0 {
		frame, ok := takeCompleteSSEFrame(buffer)
		if !ok {
			t.Fatalf("incomplete SSE bytes: %q", buffer.String())
		}
		frames = append(frames, string(frame))
	}
	return frames
}

func evidenceFromFrame(frame string) (cpaBasicEvidence, bool) {
	_, data := parseSSEFrame([]byte(frame))
	var event cpaBasicEvidenceEvent
	if err := json.Unmarshal(data, &event); err != nil || event.Type != "cpa.basic.evidence" {
		return cpaBasicEvidence{}, false
	}
	if event.Envelope.Contract != cpaBasicEvidenceContract || event.Envelope.Version != 1 || event.Envelope.ProviderAttemptRef != testProviderAttemptRef {
		return cpaBasicEvidence{}, false
	}
	return event.Envelope, true
}

func assertEvidence(t *testing.T, evidence cpaBasicEvidence, costExposure, finalUsage, failureClass string) {
	t.Helper()
	if evidence.Contract != cpaBasicEvidenceContract || evidence.Version != 1 || evidence.ProviderAttemptRef != testProviderAttemptRef {
		t.Fatalf("evidence identity = %+v", evidence)
	}
	if evidence.CostExposure != costExposure || evidence.FinalUsageEvidence != finalUsage || evidence.FailureClass != failureClass {
		t.Fatalf("evidence state = %s/%s/%s, want %s/%s/%s", evidence.CostExposure, evidence.FinalUsageEvidence, evidence.FailureClass, costExposure, finalUsage, failureClass)
	}
}

func assertNoEvidenceAndExactBody(t *testing.T, got, want string) {
	t.Helper()
	if strings.Contains(got, `"contract":"cpa-basic@1"`) {
		t.Fatalf("EOF/cancel emitted terminal evidence: %q", got)
	}
	if got != want {
		t.Fatalf("public body changed: got=%q want=%q", got, want)
	}
}

func jsonEqual(left, right []byte) bool {
	var leftValue any
	var rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil && valuesEqual(leftValue, rightValue)
}

func valuesEqual(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}
