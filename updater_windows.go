//go:build windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf16"
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
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
$processIdToWait = %s
$staged = %s
$target = %s
$backup = "$target.hyperpg-backup"
while (Get-Process -Id $processIdToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
try {
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  Move-Item -LiteralPath $target -Destination $backup -Force
  Move-Item -LiteralPath $staged -Destination $target -Force
  Start-Process -FilePath $target
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
} catch {
  if (Test-Path -LiteralPath $backup) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $target) { Start-Process -FilePath $target }
  Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
}
`, strconv.Itoa(os.Getpid()), quote(staged), quote(executable))
	encoded := encodePowerShellCommand(script)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Could not start the Windows updater: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("Could not release the Windows updater process: %w", err)
	}
	return nil
}

func encodePowerShellCommand(script string) string {
	characters := utf16.Encode([]rune(script))
	encoded := make([]byte, len(characters)*2)
	for index, value := range characters {
		binary.LittleEndian.PutUint16(encoded[index*2:], value)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}
