package updates

import (
	"fmt"
	"os"
	"strings"
)

const updateErrorSuffix = ".hyperpg-update-error"

func readUpdateError(executable string) string {
	content, err := os.ReadFile(executable + updateErrorSuffix)
	if err != nil {
		return ""
	}
	if len(content) > 16*1024 {
		content = content[:16*1024]
	}
	return strings.TrimSpace(string(content))
}

func writeUpdateError(executable, message string) error {
	if strings.TrimSpace(message) == "" {
		return fmt.Errorf("update error details are empty")
	}
	if len(message) > 16*1024 {
		message = message[:16*1024]
	}
	if err := os.WriteFile(executable+updateErrorSuffix, []byte(message+"\n"), 0600); err != nil {
		return fmt.Errorf("write update error details: %w", err)
	}
	return nil
}

func clearUpdateError(executable string) {
	_ = os.Remove(executable + updateErrorSuffix)
}
