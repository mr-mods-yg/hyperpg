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
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const updaterHelperArgument = "--hyperpg-update-helper"

const updaterHandshakeTimeout = 15 * time.Second

const (
	updaterWindowWidth   = 480
	updaterWindowHeight  = 190
	windowStylePopup     = 0x80000000
	windowStyleCaption   = 0x00C00000
	windowStyleVisible   = 0x10000000
	windowStyleChild     = 0x40000000
	staticStyleCenter    = 0x00000001
	staticStyleNoPrefix  = 0x00000080
	progressStyleMarquee = 0x00000008
	progressSetMarquee   = 0x040A
	windowMessageClose   = 0x0010
	windowMessageQuit    = 0x0012
	messageBoxIconError  = 0x00000010
	messageBoxSetFocus   = 0x00010000
	messageBoxTopmost    = 0x00040000
)

var updaterUser32 = syscall.NewLazyDLL("user32.dll")

type updaterMessage struct {
	window  windows.Handle
	message uint32
	padding uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pointX  int32
	pointY  int32
	private uint32
}

type windowsUpdateWindow struct {
	handle   windows.Handle
	progress windows.Handle
	threadID uint32
	done     chan struct{}
}

type updaterHandshake struct {
	Ready bool   `json:"ready"`
	Error string `json:"error,omitempty"`
}

func newWindowsUpdateWindow() (*windowsUpdateWindow, error) {
	window := &windowsUpdateWindow{done: make(chan struct{})}
	ready := make(chan error, 1)
	go window.run(ready)
	select {
	case err := <-ready:
		if err != nil {
			return nil, err
		}
		return window, nil
	case <-time.After(5 * time.Second):
		return nil, fmt.Errorf("The update progress window did not open in time")
	}
}

func (w *windowsUpdateWindow) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(w.done)
	w.threadID = windows.GetCurrentThreadId()

	className, _ := windows.UTF16PtrFromString("STATIC")
	initialText, _ := windows.UTF16PtrFromString("HyperPG is preparing to update.\r\n\r\nThis window will close when the update finishes.")
	getModuleHandle := syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")
	module, _, _ := getModuleHandle.Call(0)
	createWindow := updaterUser32.NewProc("CreateWindowExW")
	style := uintptr(windowStylePopup | windowStyleCaption | staticStyleCenter | staticStyleNoPrefix)
	hwnd, _, callErr := createWindow.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(initialText)),
		style,
		uintptr(0x80000000), uintptr(0x80000000), updaterWindowWidth, updaterWindowHeight,
		0, 0, module, 0,
	)
	if hwnd == 0 {
		ready <- fmt.Errorf("Could not open the Windows update progress window: %w", callErr)
		return
	}
	w.handle = windows.Handle(hwnd)
	w.createProgressBar(module)
	updaterUser32.NewProc("ShowWindow").Call(hwnd, 5)
	updaterUser32.NewProc("UpdateWindow").Call(hwnd)
	updaterUser32.NewProc("SetForegroundWindow").Call(hwnd)
	ready <- nil

	var message updaterMessage
	for {
		result, _, _ := updaterUser32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		updaterUser32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&message)))
		updaterUser32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&message)))
	}
}

func (w *windowsUpdateWindow) createProgressBar(module uintptr) {
	controls := struct {
		size uint32
		icc  uint32
	}{size: uint32(unsafe.Sizeof(uint32(0)) * 2), icc: 0x00000020}
	initControls := syscall.NewLazyDLL("comctl32.dll").NewProc("InitCommonControlsEx")
	if initialized, _, _ := initControls.Call(uintptr(unsafe.Pointer(&controls))); initialized == 0 {
		return
	}
	className, _ := windows.UTF16PtrFromString("msctls_progress32")
	createWindow := updaterUser32.NewProc("CreateWindowExW")
	style := uintptr(windowStyleChild | windowStyleVisible | progressStyleMarquee)
	hwnd, _, _ := createWindow.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		0,
		style,
		32, 112, updaterWindowWidth-64, 18,
		uintptr(w.handle), 0, module, 0,
	)
	if hwnd == 0 {
		return
	}
	w.progress = windows.Handle(hwnd)
	updaterUser32.NewProc("SendMessageW").Call(hwnd, progressSetMarquee, 1, 40)
}

func (w *windowsUpdateWindow) setStatus(status string) {
	if w == nil || w.handle == 0 {
		return
	}
	text, err := windows.UTF16PtrFromString(status)
	if err != nil {
		return
	}
	updaterUser32.NewProc("SetWindowTextW").Call(uintptr(w.handle), uintptr(unsafe.Pointer(text)))
}

func (w *windowsUpdateWindow) showError(err error) {
	message := "The update could not be installed.\r\n\r\n" + err.Error() + "\r\n\r\nYou can close this message and try the update again."
	w.setStatus("Update failed. See the error message for details.")
	body, bodyErr := windows.UTF16PtrFromString(message)
	title, titleErr := windows.UTF16PtrFromString("HyperPG update failed")
	if bodyErr != nil || titleErr != nil {
		return
	}
	flags := uintptr(messageBoxIconError | messageBoxSetFocus | messageBoxTopmost)
	updaterUser32.NewProc("MessageBoxW").Call(uintptr(w.handle), uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
}

func (w *windowsUpdateWindow) close() {
	if w == nil || w.handle == 0 {
		return
	}
	updaterUser32.NewProc("PostMessageW").Call(uintptr(w.handle), windowMessageClose, 0, 0)
	updaterUser32.NewProc("PostThreadMessageW").Call(uintptr(w.threadID), windowMessageQuit, 0, 0)
	select {
	case <-w.done:
	case <-time.After(2 * time.Second):
	}
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
	updateWindow, err := newWindowsUpdateWindow()
	if err != nil {
		return failBeforeReady(fmt.Errorf("Could not show update progress: %w", err))
	}
	defer updateWindow.close()
	if err := json.NewEncoder(os.Stdout).Encode(updaterHandshake{Ready: true}); err != nil {
		return true, fmt.Errorf("Could not confirm updater readiness: %w", err)
	}

	clearUpdateError(target)
	updateWindow.setStatus("Waiting for HyperPG to close...\r\n\r\nThe update will continue automatically.")
	if err := waitForProcess(process); err != nil {
		return true, failAfterReady(target, err, false, updateWindow)
	}
	updateWindow.setStatus("Preparing to install the update...\r\n\r\nSaving a copy of your current version.")
	if err := backupCurrentExecutable(target); err != nil {
		return true, failAfterReady(target, err, true, updateWindow)
	}
	updateWindow.setStatus("Installing the update...\r\n\r\nThis may take a few minutes. HyperPG will reopen when the update is complete.")
	if err := runWindowsInstaller(staged, target); err != nil {
		rollbackErr := restoreBackup(target)
		if rollbackErr != nil {
			err = fmt.Errorf("%w; could not restore the previous application: %v", err, rollbackErr)
			return true, failAfterReady(target, err, false, updateWindow)
		}
		return true, failAfterReady(target, err, true, updateWindow)
	}
	updateWindow.setStatus("Starting the updated version of HyperPG...")
	if err := startUpdatedApplication(target); err != nil {
		rollbackErr := restoreBackup(target)
		if rollbackErr != nil {
			err = fmt.Errorf("%w; could not restore the previous application: %v", err, rollbackErr)
			return true, failAfterReady(target, err, false, updateWindow)
		}
		return true, failAfterReady(target, err, true, updateWindow)
	}
	_ = os.Remove(target + ".hyperpg-backup")
	clearUpdateError(target)
	updateWindow.setStatus("Update complete.\r\n\r\nHyperPG has reopened.")
	time.Sleep(800 * time.Millisecond)
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

func failAfterReady(target string, err error, restartOld bool, updateWindow *windowsUpdateWindow) error {
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
	updateWindow.showError(err)
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
