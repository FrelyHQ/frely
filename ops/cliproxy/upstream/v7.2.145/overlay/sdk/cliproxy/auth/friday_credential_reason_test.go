package auth

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

type fridayCredentialStatusError struct {
	status int
}

func (e fridayCredentialStatusError) Error() string   { return "upstream authentication failure" }
func (e fridayCredentialStatusError) StatusCode() int { return e.status }

func TestFridayCredentialUnauthorizedClassification(t *testing.T) {
	classified := resultErrorFromError(fridayCredentialStatusError{status: http.StatusUnauthorized})
	if classified == nil {
		t.Fatal("resultErrorFromError returned nil")
	}
	if classified.Code != "auth_unauthorized" || classified.HTTPStatus != http.StatusUnauthorized || classified.Retryable {
		t.Fatalf("classified error = %#v", classified)
	}
	if classified.Message != "provider credential is unauthorized" {
		t.Fatalf("classified message = %q", classified.Message)
	}
	structured := resultErrorFromError(&Error{
		Code:       "upstream_invalid_token",
		Message:    "upstream response must not escape",
		Retryable:  true,
		HTTPStatus: http.StatusUnauthorized,
	})
	if structured.Code != "auth_unauthorized" || structured.Message != "provider credential is unauthorized" || structured.Retryable {
		t.Fatalf("structured error = %#v", structured)
	}
	legacy := refreshErrorFromError(errors.New("refresh failed with status 401 Unauthorized"))
	if legacy.Code != "legacy_unauthorized" || legacy.HTTPStatus != http.StatusUnauthorized || legacy.Retryable {
		t.Fatalf("legacy error = %#v", legacy)
	}
	if promoted := resultErrorFromError(legacy); promoted.Code == "auth_unauthorized" {
		t.Fatalf("legacy message matching promoted typed reason: %#v", promoted)
	}

	var authErr *Error
	if !errors.As(credentialFailureError(fridayCredentialStatusError{status: http.StatusUnauthorized}), &authErr) || authErr == nil {
		t.Fatal("credentialFailureError did not return typed auth error")
	}
	if authErr.Code != "auth_unauthorized" {
		t.Fatalf("credentialFailureError code = %q", authErr.Code)
	}
}

func TestFridaySchedulerPreservesUnauthorizedBeforeCooldown(t *testing.T) {
	nextRetry := time.Now().Add(time.Minute)
	auth := &Auth{
		ID: "friday-auth",
		ModelStates: map[string]*ModelState{
			"model-a": {
				Status:         StatusError,
				Unavailable:    true,
				NextRetryAfter: nextRetry,
				LastError: &Error{
					Code:       "auth_unauthorized",
					Message:    "provider credential is unauthorized",
					HTTPStatus: http.StatusUnauthorized,
				},
			},
		},
	}
	shard := &modelScheduler{
		modelKey: "model-a",
		entries: map[string]*scheduledAuth{
			auth.ID: {auth: auth, state: scheduledStateCooldown, nextRetryAt: nextRetry},
		},
	}
	var authErr *Error
	if err := shard.unavailableErrorLocked("openai", "model-a", nil); !errors.As(err, &authErr) || authErr == nil {
		t.Fatalf("unavailable error = %T %v", err, err)
	}
	if authErr.Code != "auth_unauthorized" || authErr.HTTPStatus != http.StatusUnauthorized {
		t.Fatalf("unavailable error = %#v", authErr)
	}
}
