//go:build !linux && !windows

package updates

import "fmt"

func replaceAndRestart(string) error {
	return fmt.Errorf("Automatic updates are currently supported on Windows and Linux")
}
