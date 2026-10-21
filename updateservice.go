package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const githubReleaseAPI = "https://api.github.com/repos/mr-mods-yg/hyperpg/releases"

const maxUpdateDownloadSize = 512 << 20

//go:embed VERSION
var embeddedVersion string

type UpdateInfo struct {
	Available    bool   `json:"available"`
	Version      string `json:"version"`
	ReleaseURL   string `json:"releaseUrl"`
	InstallError string `json:"installError"`
}

type UpdateService struct {
	mu         sync.Mutex
	app        *application.App
	installing bool
	client     *http.Client
}

type githubRelease struct {
	TagName    string        `json:"tag_name"`
	Name       string        `json:"name"`
	HTMLURL    string        `json:"html_url"`
	Prerelease bool          `json:"prerelease"`
	Draft      bool          `json:"draft"`
	Assets     []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

func NewUpdateService() *UpdateService {
	return &UpdateService{
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (s *UpdateService) setApp(app *application.App) {
	s.mu.Lock()
	s.app = app
	s.mu.Unlock()
}

// CheckForUpdates checks the GitHub release channel selected in Settings.
func (s *UpdateService) CheckForUpdates(channel string) (UpdateInfo, error) {
	if channel != "stable" && channel != "nightly" {
		return UpdateInfo{}, fmt.Errorf("Choose the stable or nightly update channel")
	}
	release, err := s.latestRelease(channel)
	if err != nil {
		if errors.Is(err, errNoPublishedRelease) {
			return addPersistedUpdateError(UpdateInfo{Available: false}), nil
		}
		if persistedError := persistedUpdateError(); persistedError != "" {
			return UpdateInfo{InstallError: persistedError}, nil
		}
		return UpdateInfo{}, err
	}
	if _, ok := findAsset(release, platformAssetName()); !ok {
		return UpdateInfo{}, fmt.Errorf("This release has no build for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	available, version := releaseIsNewer(channel, release.TagName, currentAppVersion())
	return addPersistedUpdateError(UpdateInfo{Available: available, Version: version, ReleaseURL: release.HTMLURL}), nil
}

func addPersistedUpdateError(info UpdateInfo) UpdateInfo {
	info.InstallError = persistedUpdateError()
	return info
}

func persistedUpdateError() string {
	if executable, err := os.Executable(); err == nil {
		return readUpdateError(executable)
	}
	return ""
}

// InstallUpdate downloads and verifies the selected release, starts the
// platform-specific update flow, then closes the app when that flow is ready.
func (s *UpdateService) InstallUpdate(channel string) error {
	s.mu.Lock()
	if s.installing {
		s.mu.Unlock()
		return fmt.Errorf("An update is already being installed")
	}
	s.installing = true
	app := s.app
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.installing = false
		s.mu.Unlock()
	}()
	if app == nil {
		return fmt.Errorf("The updater is not ready yet")
	}
	if channel != "stable" && channel != "nightly" {
		return fmt.Errorf("Choose the stable or nightly update channel")
	}

	release, err := s.latestRelease(channel)
	if err != nil {
		return err
	}
	available, _ := releaseIsNewer(channel, release.TagName, currentAppVersion())
	if !available {
		return fmt.Errorf("You already have the latest %s version", channel)
	}
	asset, ok := findAsset(release, platformAssetName())
	if !ok {
		return fmt.Errorf("This release has no build for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	staged, err := s.downloadAsset(asset)
	if err != nil {
		return err
	}
	if err := replaceAndRestart(staged); err != nil {
		_ = os.Remove(staged)
		return err
	}
	go func() {
		time.Sleep(250 * time.Millisecond)
		app.Quit()
	}()
	return nil
}

var errNoPublishedRelease = errors.New("no published release")

func (s *UpdateService) latestRelease(channel string) (githubRelease, error) {
	endpoint := githubReleaseAPI + "/latest"
	if channel == "nightly" {
		endpoint = githubReleaseAPI + "?per_page=100"
	}
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return githubRelease{}, fmt.Errorf("Could not prepare the update check")
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	req.Header.Set("User-Agent", "hyperpg-updater")
	resp, err := s.client.Do(req)
	if err != nil {
		return githubRelease{}, fmt.Errorf("Could not reach GitHub to check for updates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return githubRelease{}, errNoPublishedRelease
	}
	if resp.StatusCode != http.StatusOK {
		return githubRelease{}, fmt.Errorf("GitHub returned HTTP %d while checking for updates", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return githubRelease{}, fmt.Errorf("Could not read GitHub's update information: %w", err)
	}
	if channel == "stable" {
		var release githubRelease
		if err := json.Unmarshal(body, &release); err != nil {
			return githubRelease{}, fmt.Errorf("GitHub returned invalid release information")
		}
		if release.Draft || release.Prerelease || !strings.HasPrefix(release.TagName, "v") {
			return githubRelease{}, errNoPublishedRelease
		}
		return release, nil
	}
	var releases []githubRelease
	if err := json.Unmarshal(body, &releases); err != nil {
		return githubRelease{}, fmt.Errorf("GitHub returned invalid release information")
	}
	var latest githubRelease
	var latestRun uint64
	for _, release := range releases {
		if release.Draft || !release.Prerelease || !strings.HasPrefix(release.TagName, "nightly-") {
			continue
		}
		run, ok := nightlyRunNumber(release.TagName)
		if ok && run > latestRun {
			latest = release
			latestRun = run
		}
	}
	if latestRun == 0 {
		return githubRelease{}, errNoPublishedRelease
	}
	return latest, nil
}

func (s *UpdateService) downloadAsset(asset githubAsset) (string, error) {
	if !strings.HasPrefix(asset.Digest, "sha256:") {
		return "", fmt.Errorf("GitHub did not provide a SHA-256 digest for this update")
	}
	u, err := http.NewRequest(http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil || u.URL.Scheme != "https" || u.URL.Hostname() != "github.com" {
		return "", fmt.Errorf("GitHub provided an invalid update download URL")
	}
	u.Header.Set("Accept", "application/octet-stream")
	u.Header.Set("User-Agent", "hyperpg-updater")
	downloadClient := &http.Client{Timeout: 5 * time.Minute}
	resp, err := downloadClient.Do(u)
	if err != nil {
		return "", fmt.Errorf("Could not download the update: %w", err)
	}
	defer resp.Body.Close()
	if resp.Request == nil || resp.Request.URL.Scheme != "https" {
		return "", fmt.Errorf("The update download did not use HTTPS")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub returned HTTP %d while downloading the update", resp.StatusCode)
	}
	if resp.ContentLength > maxUpdateDownloadSize || asset.Size > maxUpdateDownloadSize {
		return "", fmt.Errorf("The update file is larger than the allowed download size")
	}
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("Could not locate the current application: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("Could not locate the current application: %w", err)
	}
	stageDir := filepath.Dir(executable)
	if runtime.GOOS == "windows" {
		stageDir = os.TempDir()
	}
	tempPattern := ".hyperpg-update-*"
	if runtime.GOOS == "windows" {
		tempPattern += ".exe"
	}
	staged, err := os.CreateTemp(stageDir, tempPattern)
	if err != nil {
		return "", fmt.Errorf("Could not create a temporary file for the update: %w", err)
	}
	stagePath := staged.Name()
	hash := sha256.New()
	count, copyErr := io.Copy(io.MultiWriter(staged, hash), io.LimitReader(resp.Body, maxUpdateDownloadSize+1))
	closeErr := staged.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(stagePath)
		if copyErr != nil {
			return "", fmt.Errorf("Could not save the downloaded update: %w", copyErr)
		}
		return "", fmt.Errorf("Could not finish saving the downloaded update: %w", closeErr)
	}
	if count > maxUpdateDownloadSize || (asset.Size > 0 && count != asset.Size) {
		_ = os.Remove(stagePath)
		return "", fmt.Errorf("The downloaded update has an unexpected size")
	}
	if hex.EncodeToString(hash.Sum(nil)) != strings.TrimPrefix(asset.Digest, "sha256:") {
		_ = os.Remove(stagePath)
		return "", fmt.Errorf("The update failed its SHA-256 integrity check")
	}
	if runtime.GOOS == "linux" {
		binaryPath, err := extractLinuxBinary(stagePath, filepath.Dir(executable))
		_ = os.Remove(stagePath)
		if err != nil {
			return "", err
		}
		return binaryPath, nil
	}
	return stagePath, nil
}

func extractLinuxBinary(archivePath, targetDir string) (string, error) {
	archive, err := os.Open(archivePath)
	if err != nil {
		return "", fmt.Errorf("Could not open the Linux update archive")
	}
	defer archive.Close()
	gz, err := gzip.NewReader(archive)
	if err != nil {
		return "", fmt.Errorf("The Linux update archive is invalid")
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var stagedPath string
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if stagedPath != "" {
				_ = os.Remove(stagedPath)
			}
			return "", fmt.Errorf("The Linux update archive is invalid")
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			continue
		}
		if filepath.Base(filepath.Clean(header.Name)) != "hyperpg" || filepath.Clean(header.Name) != "hyperpg" || stagedPath != "" || header.Size > maxUpdateDownloadSize {
			if stagedPath != "" {
				_ = os.Remove(stagedPath)
			}
			return "", fmt.Errorf("The Linux update archive contains an unexpected file")
		}
		staged, err := os.CreateTemp(targetDir, ".hyperpg-update-binary-*")
		if err != nil {
			return "", fmt.Errorf("Could not stage the Linux update next to the app: %w", err)
		}
		stagedPath = staged.Name()
		written, err := io.Copy(staged, io.LimitReader(reader, maxUpdateDownloadSize+1))
		if err != nil || written != header.Size {
			staged.Close()
			_ = os.Remove(stagedPath)
			return "", fmt.Errorf("Could not extract the Linux update")
		}
		if err := staged.Close(); err != nil {
			_ = os.Remove(stagedPath)
			return "", fmt.Errorf("Could not finish extracting the Linux update")
		}
	}
	if stagedPath == "" {
		return "", fmt.Errorf("The Linux update archive does not contain hyperpg")
	}
	if err := os.Chmod(stagedPath, 0o755); err != nil {
		_ = os.Remove(stagedPath)
		return "", fmt.Errorf("Could not make the Linux update executable")
	}
	return stagedPath, nil
}

func platformAssetName() string {
	switch {
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		return "hyperpg-windows-amd64-setup.exe"
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return "hyperpg-linux-amd64.tar.gz"
	default:
		return ""
	}
}

func findAsset(release githubRelease, name string) (githubAsset, bool) {
	for _, asset := range release.Assets {
		if asset.Name == name {
			return asset, true
		}
	}
	return githubAsset{}, false
}

func releaseIsNewer(channel, releaseTag, current string) (bool, string) {
	if channel == "nightly" {
		run, ok := nightlyRunNumber(releaseTag)
		if !ok {
			return false, ""
		}
		currentRun, currentOK := nightlyRunNumber(current)
		return !currentOK || run > currentRun, fmt.Sprintf("Nightly %d", run)
	}
	version := strings.TrimPrefix(releaseTag, "v")
	if !strings.HasPrefix(releaseTag, "v") {
		return false, ""
	}
	if strings.HasPrefix(current, "nightly-") || current == "dev" {
		return true, version
	}
	currentParts, currentErr := stableVersionParts(current)
	latestParts, latestErr := stableVersionParts(version)
	if currentErr != nil || latestErr != nil {
		return current == "dev", version
	}
	for index := range currentParts {
		if latestParts[index] != currentParts[index] {
			return latestParts[index] > currentParts[index], version
		}
	}
	return false, version
}

func stableVersionParts(value string) ([3]uint64, error) {
	var parts [3]uint64
	value = strings.TrimPrefix(value, "v")
	value = strings.SplitN(value, "+", 2)[0]
	value = strings.SplitN(value, "-", 2)[0]
	segments := strings.Split(value, ".")
	if len(segments) != 3 {
		return parts, fmt.Errorf("invalid semantic version")
	}
	for index, segment := range segments {
		number, err := strconv.ParseUint(segment, 10, 64)
		if err != nil {
			return parts, fmt.Errorf("invalid semantic version")
		}
		parts[index] = number
	}
	return parts, nil
}

func nightlyRunNumber(tag string) (uint64, bool) {
	if !strings.HasPrefix(tag, "nightly-") {
		return 0, false
	}
	value := strings.TrimPrefix(tag, "nightly-")
	value = strings.SplitN(value, "-", 2)[0]
	run, err := strconv.ParseUint(value, 10, 64)
	return run, err == nil && run > 0
}

func currentAppVersion() string {
	return strings.TrimPrefix(strings.TrimSpace(embeddedVersion), "\ufeff")
}
