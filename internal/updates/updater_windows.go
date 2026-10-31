//go:build windows

package updates

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// replaceAndRestart starts the downloaded NSIS setup in interactive mode.
// The setup wizard gives the current app time to exit before replacing files,
// and its finish page launches the newly installed app.
func replaceAndRestart(staged string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	installDir := filepath.Dir(executable)
	staged, err = filepath.Abs(staged)
	if err != nil {
		return fmt.Errorf("Could not locate the downloaded installer: %w", err)
	}
	if !sameWindowsPath(filepath.Dir(staged), os.TempDir()) {
		return fmt.Errorf("The update installer must be staged in the temporary folder")
	}
	if !strings.EqualFold(filepath.Ext(staged), ".exe") || !strings.HasPrefix(strings.ToLower(filepath.Base(staged)), ".hyperpg-update-") {
		return fmt.Errorf("The downloaded update is not a HyperPG Windows installer")
	}
	if info, statErr := os.Stat(staged); statErr != nil || !info.Mode().IsRegular() {
		if statErr != nil {
			return fmt.Errorf("Could not open the downloaded installer: %w", statErr)
		}
		return fmt.Errorf("The downloaded installer is not a regular file")
	}

	cmd := exec.Command(staged)
	cmd.Env = installerEnvironment(installDir)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Could not open the Windows installer: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("Could not release the Windows installer process: %w", err)
	}
	clearUpdateError(executable)
	return nil
}

func sameWindowsPath(left, right string) bool {
	left = strings.TrimPrefix(filepath.Clean(left), `\\?\`)
	right = strings.TrimPrefix(filepath.Clean(right), `\\?\`)
	return strings.EqualFold(left, right)
}

func installerEnvironment(installDir string) []string {
	env := os.Environ()
	filtered := make([]string, 0, len(env)+1)
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(key, "HYPERPG_INSTALL_DIR") {
			continue
		}
		filtered = append(filtered, entry)
	}
	return append(filtered, "HYPERPG_INSTALL_DIR="+installDir)
}
