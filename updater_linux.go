//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

func replaceAndRestart(staged string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	if filepath.Dir(staged) != filepath.Dir(executable) {
		return fmt.Errorf("The update must be staged next to the current application")
	}
	const waitAndRestart = `
pid="$1"
staged="$2"
target="$3"
backup="${target}.hyperpg-backup"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
if mv -- "$target" "$backup" && mv -- "$staged" "$target"; then
  chmod 755 "$target"
  rm -f -- "$backup"
  exec "$target"
fi
if [ -e "$backup" ]; then mv -- "$backup" "$target"; fi
rm -f -- "$staged"
if [ -x "$target" ]; then exec "$target"; fi
`
	cmd := exec.Command("sh", "-c", waitAndRestart, "hyperpg-updater", strconv.Itoa(os.Getpid()), staged, executable)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Could not start the app updater: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("Could not release the app updater process: %w", err)
	}
	return nil
}
