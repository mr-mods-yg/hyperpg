//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const updaterHelperArgument = "--hyperpg-update-helper"

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

	// Windows locks an executable while it runs. Start a temporary copy of the
	// app in helper mode so it can replace the original after exit.
	current, err := os.Open(executable)
	if err != nil {
		return fmt.Errorf("Could not prepare the update helper: %w", err)
	}
	helper, err := os.CreateTemp(os.TempDir(), "hyperpg-update-*.exe")
	if err != nil {
		current.Close()
		return fmt.Errorf("Could not prepare the update helper: %w", err)
	}
	helperPath := helper.Name()
	_, copyErr := io.Copy(helper, current)
	currentCloseErr := current.Close()
	helperCloseErr := helper.Close()
	if copyErr != nil || currentCloseErr != nil || helperCloseErr != nil {
		_ = os.Remove(helperPath)
		if copyErr != nil {
			return fmt.Errorf("Could not copy the update helper: %w", copyErr)
		}
		if currentCloseErr != nil {
			return fmt.Errorf("Could not finish reading the update helper: %w", currentCloseErr)
		}
		return fmt.Errorf("Could not finish writing the update helper: %w", helperCloseErr)
	}

	cmd := exec.Command(helperPath, updaterHelperArgument, strconv.Itoa(os.Getpid()), staged, executable)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		_ = os.Remove(helperPath)
		return fmt.Errorf("Could not start the Windows updater: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		_ = cmd.Process.Kill()
		_ = os.Remove(helperPath)
		return fmt.Errorf("Could not release the Windows updater process: %w", err)
	}
	return nil
}

// runUpdaterHelper handles the private helper mode before the GUI is started.
func runUpdaterHelper(args []string) (bool, error) {
	if len(args) == 0 || args[0] != updaterHelperArgument {
		return false, nil
	}
	if len(args) != 4 {
		return true, fmt.Errorf("Invalid update helper arguments")
	}
	helperPath, err := os.Executable()
	if err != nil || !strings.EqualFold(filepath.Dir(helperPath), os.TempDir()) ||
		!strings.HasPrefix(strings.ToLower(filepath.Base(helperPath)), "hyperpg-update-") ||
		!strings.HasSuffix(strings.ToLower(filepath.Base(helperPath)), ".exe") {
		return true, fmt.Errorf("The update helper must run from its temporary copy")
	}
	defer deleteHelperOnReboot()
	processID, err := strconv.Atoi(args[1])
	if err != nil || processID <= 0 {
		return true, fmt.Errorf("Invalid application process ID")
	}
	staged, err := filepath.Abs(args[2])
	if err != nil {
		return true, fmt.Errorf("Invalid staged update path")
	}
	target, err := filepath.Abs(args[3])
	if err != nil {
		return true, fmt.Errorf("Invalid application path")
	}
	if !strings.EqualFold(filepath.Dir(staged), filepath.Dir(target)) ||
		!strings.EqualFold(filepath.Base(target), "hyperpg.exe") ||
		!strings.HasPrefix(strings.ToLower(filepath.Base(staged)), ".hyperpg-update-") {
		return true, fmt.Errorf("The update helper received unexpected paths")
	}
	if err := waitForProcess(processID); err != nil {
		return true, err
	}
	if err := applyUpdate(staged, target); err != nil {
		if _, statErr := os.Stat(target); statErr == nil {
			_ = startUpdatedApplication(target)
		}
		return true, err
	}
	if err := startUpdatedApplication(target); err != nil {
		backup := target + ".hyperpg-backup"
		_ = os.Remove(target)
		_ = os.Rename(backup, target)
		_ = startUpdatedApplication(target)
		return true, err
	}
	_ = os.Remove(target + ".hyperpg-backup")
	return true, nil
}

func waitForProcess(processID int) error {
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(processID))
	if err != nil {
		return fmt.Errorf("Could not wait for the application to close: %w", err)
	}
	defer syscall.CloseHandle(handle)
	result, err := syscall.WaitForSingleObject(handle, syscall.INFINITE)
	if err != nil {
		return fmt.Errorf("Could not wait for the application to close: %w", err)
	}
	if result != syscall.WAIT_OBJECT_0 {
		return fmt.Errorf("Could not confirm the application has closed")
	}
	return nil
}

func applyUpdate(staged, target string) error {
	backup := target + ".hyperpg-backup"
	_ = os.Remove(backup)
	if err := os.Rename(target, backup); err != nil {
		return fmt.Errorf("Could not move the current application: %w", err)
	}
	if err := os.Rename(staged, target); err != nil {
		_ = os.Rename(backup, target)
		return fmt.Errorf("Could not install the downloaded update: %w", err)
	}
	return nil
}

func startUpdatedApplication(path string) error {
	cmd := exec.Command(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Could not restart hyperpg: %w", err)
	}
	return cmd.Process.Release()
}

func deleteHelperOnReboot() {
	helperPath, err := os.Executable()
	if err != nil {
		return
	}
	path, err := syscall.UTF16PtrFromString(helperPath)
	if err != nil {
		return
	}
	moveFileEx := syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")
	_, _, _ = moveFileEx.Call(uintptr(unsafe.Pointer(path)), 0, 0x4) // MOVEFILE_DELAY_UNTIL_REBOOT
}
