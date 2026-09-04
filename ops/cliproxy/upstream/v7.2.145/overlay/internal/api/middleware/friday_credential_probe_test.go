package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFridayCredentialProbeRequiresManagementBoundary(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "management-secret-value")
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(FridayCredentialProbePinMiddleware())
	engine.POST("/v1/chat/completions", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	for _, testCase := range []struct {
		name       string
		authID     string
		probeKey   string
		wantStatus int
	}{
		{name: "missing key", authID: "auth-safe", wantStatus: http.StatusForbidden},
		{name: "wrong key", authID: "auth-safe", probeKey: "wrong", wantStatus: http.StatusForbidden},
		{name: "invalid auth id", authID: "auth secret", probeKey: "management-secret-value", wantStatus: http.StatusForbidden},
		{name: "management authenticated", authID: "auth-safe", probeKey: "management-secret-value", wantStatus: http.StatusNoContent},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			if testCase.authID != "" {
				request.Header.Set(fridayProbeAuthIDHeader, testCase.authID)
			}
			if testCase.probeKey != "" {
				request.Header.Set(fridayProbeKeyHeader, testCase.probeKey)
			}
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, testCase.wantStatus)
			}
			if request.Header.Get(fridayProbeAuthIDHeader) != "" || request.Header.Get(fridayProbeKeyHeader) != "" {
				t.Fatal("internal probe headers reached the downstream handler")
			}
		})
	}
}
