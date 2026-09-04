package middleware

import (
	"crypto/subtle"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	handlers "github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
)

const (
	fridayProbeAuthIDHeader = "X-Friday-CPA-Probe-Auth-ID"
	fridayProbeKeyHeader    = "X-Friday-CPA-Probe-Key"
)

var fridayProbeAuthIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)

// FridayCredentialProbePinMiddleware permits exact credential selection only
// across the management-authenticated Friday Control boundary. Ordinary
// inference callers do not possess MANAGEMENT_PASSWORD and cannot select an
// auth record even if they know its safe opaque identifier.
func FridayCredentialProbePinMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authID := strings.TrimSpace(c.GetHeader(fridayProbeAuthIDHeader))
		probeKey := c.GetHeader(fridayProbeKeyHeader)
		// Never forward the internal selector or authentication material to an
		// upstream Provider, including empty or rejected header values.
		c.Request.Header.Del(fridayProbeAuthIDHeader)
		c.Request.Header.Del(fridayProbeKeyHeader)
		if authID == "" && probeKey == "" {
			c.Next()
			return
		}

		managementKey := os.Getenv("MANAGEMENT_PASSWORD")
		if !fridayProbeAuthIDPattern.MatchString(authID) || managementKey == "" || !constantTimeEqual(probeKey, managementKey) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": gin.H{
				"code": "friday_credential_probe_unauthorized", "type": "authentication_error", "message": "credential probe authorization failed",
			}})
			return
		}
		c.Request = c.Request.WithContext(handlers.WithPinnedAuthID(c.Request.Context(), authID))
		c.Next()
	}
}

func constantTimeEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
