//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const updaterHelperArgument = "--hyperpg-update-helper"

const updaterHandshakeTimeout = 15 * time.Second

type updaterHandshake struct {
	Ready bool   `json:"ready"`
	Error string `json:"error,omitempty"`
}

func replaceAndRestart(staged string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("Could not locate the current application: %w", err)
	}
	staged, err = filepath.Abs(staged)
	if err != nil {
		return fmt.Errorf("Could not locate the downloaded update: %w", err)
	}
	if !sameWindowsPath(filepath.Dir(staged), filepath.Dir(executable)) {
		return fmt.Errorf("The update must be staged next to the current application")
	}
	if info, statErr := os.Stat(staged); statErr != nil || !info.Mode().IsRegular() {
		if statErr != nil {
			return fmt.Errorf("Could not open the downloaded update: %w", statErr)
		}
		return fmt.Errorf("The downloaded update is not a regular file")
	}

	// Windows locks an executable while it runs. Start a temporary copy of the
	// app in helper mode so it can replace the original after exit.
	current, err := os.Open(executable)
	if err != nil {
		return fmt.Errorf("Could not prepare the update helper: %w", err)
	}
	helper, err := os.CreateTemp(os.TempDir(), "hyperpg-update-*.exe")
	if err != nil {
		_ = current.Close()
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

	cmd := exec.Command(helperPath, updaterHelperArgument, strconv.Itoa(os.Getpid()), "install", staged, executable)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdin = nil
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.Remove(helperPath)
		return fmt.Errorf("Could not connect to the Windows updater: %w", err)
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		_ = os.Remove(helperPath)
		return fmt.Errorf("Could not start the Windows updater: %w", err)
	}
	if err := waitForUpdaterHandshake(stdout, updaterHandshakeTimeout); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.Remove(helperPath)
		return err
	}
	if err := cmd.Process.Release(); err != nil {
		_ = cmd.Process.Kill()
		_ = os.Remove(helperPath)
		return fmt.Errorf("Could not release the Windows updater process: %w", err)
	}
	return nil
}

func waitForUpdaterHandshake(reader io.Reader, timeout time.Duration) error {
	type result struct {
		line string
		err  error
	}
	resultCh := make(chan result, 1)
	go func() {
		line, err := bufio.NewReader(reader).ReadString('\n')
		resultCh <- result{line: line, err: err}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		if result.err != nil {
			return fmt.Errorf("The Windows updater did not become ready: %w", result.err)
		}
		var response updaterHandshake
		if err := json.Unmarshal([]byte(result.line), &response); err != nil {
			return fmt.Errorf("The Windows updater returned an invalid status")
		}
		if !response.Ready {
			if response.Error == "" {
				response.Error = "The updater could not prepare the replacement"
			}
			return fmt.Errorf("Windows update failed: %s", response.Error)
		}
		return nil
	case <-timer.C:
		return fmt.Errorf("The Windows updater did not become ready in time")
	}
}

// runUpdaterHelper handles the private helper mode before the GUI is started.
func runUpdaterHelper(args []string) (bool, error) {
	if len(args) == 0 || args[0] != updaterHelperArgument {
		return false, nil
	}
	failBeforeReady := func(err error) (bool, error) {
		_ = json.NewEncoder(os.Stdout).Encode(updaterHandshake{Error: err.Error()})
		return true, err
	}
	if len(args) != 5 || args[2] != "install" {
		return failBeforeReady(fmt.Errorf("Invalid update helper arguments"))
	}
	helperPath, err := os.Executable()
	if err != nil || !sameWindowsPath(filepath.Dir(helperPath), os.TempDir()) ||
		!strings.HasPrefix(strings.ToLower(filepath.Base(helperPath)), "hyperpg-update-") ||
		!strings.HasSuffix(strings.ToLower(filepath.Base(helperPath)), ".exe") {
		return failBeforeReady(fmt.Errorf("The update helper must run from its temporary copy"))
	}
	defer deleteHelperOnReboot()
	processID, err := strconv.Atoi(args[1])
	if err != nil || processID <= 0 {
		return failBeforeReady(fmt.Errorf("Invalid application process ID"))
	}
	staged, err := filepath.Abs(args[3])
	if err != nil {
		return failBeforeReady(fmt.Errorf("Invalid staged update path"))
	}
	target, err := filepath.Abs(args[4])
	if err != nil {
		return failBeforeReady(fmt.Errorf("Invalid application path"))
	}
	if !sameWindowsPath(filepath.Dir(staged), filepath.Dir(target)) ||
		!strings.EqualFold(filepath.Ext(target), ".exe") ||
		!strings.HasPrefix(strings.ToLower(filepath.Base(staged)), ".hyperpg-update-") ||
		!strings.EqualFold(filepath.Ext(staged), ".exe") {
		return failBeforeReady(fmt.Errorf("The update helper received unexpected paths"))
	}
	stagedInfo, err := os.Stat(staged)
	if err != nil || !stagedInfo.Mode().IsRegular() {
		if err != nil {
			return failBeforeReady(fmt.Errorf("Could not open the downloaded update: %w", err))
		}
		return failBeforeReady(fmt.Errorf("The downloaded update is not a regular file"))
	}
	process, err := openAndValidateParentProcess(processID, target)
	if err != nil {
		return failBeforeReady(err)
	}
	defer windows.CloseHandle(process)
	if err := json.NewEncoder(os.Stdout).Encode(updaterHandshake{Ready: true}); err != nil {
		return true, fmt.Errorf("Could not confirm updater readiness: %w", err)
	}

	clearUpdateError(target)
	if err := waitForProcess(process); err != nil {
		return true, failAfterReady(target, err, false)
	}
	if err := backupCurrentExecutable(target); err != nil {
		return true, failAfterReady(target, err, true)
	}
	if err := runWindowsInstaller(staged, target); err != nil {
		rollbackErr := restoreBackup(target)
		if rollbackErr != nil {
			err = fmt.Errorf("%w; could not restore the previous application: %v", err, rollbackErr)
			return true, failAfterReady(target, err, false)
		}
		return true, failAfterReady(target, err, true)
	}
	if err := startUpdatedApplication(target); err != nil {
		rollbackErr := restoreBackup(target)
		if rollbackErr != nil {
			err = fmt.Errorf("%w; could not restore the previous application: %v", err, rollbackErr)
			return true, failAfterReady(target, err, false)
		}
		return true, failAfterReady(target, err, true)
	}
	_ = os.Remove(target + ".hyperpg-backup")
	clearUpdateError(target)
	return true, nil
}

func openAndValidateParentProcess(processID int, target string) (windows.Handle, error) {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(processID))
	if err != nil {
		return 0, fmt.Errorf("Could not connect to the application process: %w", err)
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		_ = windows.CloseHandle(handle)
		return 0, fmt.Errorf("Could not verify the application process: %w", err)
	}
	processPath := windows.UTF16ToString(buffer[:size])
	if !sameWindowsPath(processPath, target) {
		_ = windows.CloseHandle(handle)
		return 0, fmt.Errorf("The update helper could not verify the application executable")
	}
	return handle, nil
}

func waitForProcess(handle windows.Handle) error {
	result, err := windows.WaitForSingleObject(handle, windows.INFINITE)
	if err != nil {
		return fmt.Errorf("Could not wait for the application to close: %w", err)
	}
	if result != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("Could not confirm the application has closed")
	}
	return nil
}

func backupCurrentExecutable(target string) error {
	backup := target + ".hyperpg-backup"
	if err := os.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("Could not remove an earlier update backup: %w", err)
	}
	source, err := os.Open(target)
	if err != nil {
		return fmt.Errorf("Could not open the current application for backup: %w", err)
	}
	destination, err := os.Create(backup)
	if err != nil {
		_ = source.Close()
		return fmt.Errorf("Could not create the current application backup: %w", err)
	}
	_, copyErr := io.Copy(destination, source)
	sourceCloseErr := source.Close()
	destinationCloseErr := destination.Close()
	if copyErr != nil || sourceCloseErr != nil || destinationCloseErr != nil {
		_ = os.Remove(backup)
		if copyErr != nil {
			return fmt.Errorf("Could not copy the current application backup: %w", copyErr)
		}
		if sourceCloseErr != nil {
			return fmt.Errorf("Could not finish reading the current application backup: %w", sourceCloseErr)
		}
		return fmt.Errorf("Could not finish writing the current application backup: %w", destinationCloseErr)
	}
	return nil
}

func runWindowsInstaller(installer, target string) error {
	cmd := exec.Command(installer, "/S")
	cmd.Env = append(os.Environ(), "HYPERPG_INSTALL_DIR="+filepath.Dir(target))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("The Windows installer could not complete: %w", err)
	}
	return nil
}

func restoreBackup(target string) error {
	backup := target + ".hyperpg-backup"
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(backup, target)
}

func failAfterReady(target string, err error, restartOld bool) error {
	if statusErr := writeUpdateError(target, err.Error()); statusErr != nil {
		err = fmt.Errorf("%w; could not save update error details: %v", err, statusErr)
	}
	if restartOld {
		if _, statErr := os.Stat(target); statErr == nil {
			if startErr := startUpdatedApplication(target); startErr != nil {
				err = fmt.Errorf("%w; could not restart the current application: %v", err, startErr)
			}
		}
	}
	return err
}

func sameWindowsPath(left, right string) bool {
	left = strings.TrimPrefix(filepath.Clean(left), `\\?\`)
	right = strings.TrimPrefix(filepath.Clean(right), `\\?\`)
	return strings.EqualFold(left, right)
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
