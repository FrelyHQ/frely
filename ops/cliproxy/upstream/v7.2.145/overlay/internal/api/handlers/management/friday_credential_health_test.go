package management

import (
	"net/http"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestFridaySafeAuthFailureReason(t *testing.T) {
	now := time.Now()
	auth := &coreauth.Auth{
		Unavailable: true,
		LastError: &coreauth.Error{
			Code:       "auth_unauthorized",
			Message:    "secret upstream response must not be projected",
			HTTPStatus: http.StatusUnauthorized,
		},
		NextRetryAfter: now.Add(time.Minute),
	}
	if got := safeAuthFailureReason(auth, now); got != "auth_unauthorized" {
		t.Fatalf("safeAuthFailureReason = %q", got)
	}

	auth.LastError = nil
	if got := safeAuthFailureReason(auth, now); got != "model_cooldown" {
		t.Fatalf("cooldown reason = %q", got)
	}

	auth.NextRetryAfter = time.Time{}
	if got := safeAuthFailureReason(auth, now); got != "auth_unavailable" {
		t.Fatalf("unavailable reason = %q", got)
	}
}
