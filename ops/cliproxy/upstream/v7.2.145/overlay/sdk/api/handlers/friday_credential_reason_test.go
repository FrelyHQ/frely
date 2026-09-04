package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestFridayCredentialErrorResponsePreservesSafeTypedCode(t *testing.T) {
	for _, testCase := range []struct {
		code      string
		status    int
		message   string
		errorType string
	}{
		{code: "auth_unauthorized", status: http.StatusUnauthorized, message: "provider credential is unauthorized", errorType: "authentication_error"},
		{code: "auth_unavailable", status: http.StatusServiceUnavailable, message: "provider credential is temporarily unavailable", errorType: "server_error"},
		{code: "auth_not_found", status: http.StatusServiceUnavailable, message: "provider credential was not found", errorType: "server_error"},
		{code: "model_cooldown", status: http.StatusTooManyRequests, message: "provider credential is cooling down", errorType: "server_error"},
	} {
		t.Run(testCase.code, func(t *testing.T) {
			msg := executionErrorMessage(&coreauth.Error{
				Code:       testCase.code,
				Message:    "secret upstream response must not escape",
				HTTPStatus: testCase.status,
			})
			if msg == nil || msg.StatusCode != testCase.status || msg.Error == nil {
				t.Fatalf("error message = %#v", msg)
			}
			body := BuildErrorResponseBody(msg.StatusCode, msg.Error.Error())
			var payload struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
					Type    string `json:"type"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatalf("response body is invalid JSON: %v", err)
			}
			if payload.Error.Code != testCase.code || payload.Error.Type != testCase.errorType {
				t.Fatalf("response error = %#v", payload.Error)
			}
			if payload.Error.Message != testCase.message {
				t.Fatalf("response message = %q", payload.Error.Message)
			}
		})
	}
}
