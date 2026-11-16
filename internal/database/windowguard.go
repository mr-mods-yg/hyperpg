package database

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// CloseRequestedEvent asks the frontend to confirm closing the window while
// table edits are still unsaved.
const CloseRequestedEvent = "hyperpg:close-requested"

// windowGuard keeps the main window open while the frontend reports unsaved
// table edits. Those edits live only in the frontend, and a native window close
// never fires the webview's beforeunload handler.
type windowGuard struct {
	mu         sync.Mutex
	unsaved    bool
	allowClose bool
	window     *application.WebviewWindow
}

// shouldBlockClose reports whether a close request must wait for confirmation.
func (g *windowGuard) shouldBlockClose() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.unsaved && !g.allowClose
}

// SetUnsavedChanges records whether the frontend has unsaved table edits.
func (s *PostgresService) SetUnsavedChanges(unsaved bool) {
	s.guard.mu.Lock()
	s.guard.unsaved = unsaved
	s.guard.mu.Unlock()
}

// CloseWindow closes the main window without asking again. The frontend calls it
// after the user confirms quitting without saving.
func (s *PostgresService) CloseWindow() {
	s.guard.mu.Lock()
	s.guard.allowClose = true
	window := s.guard.window
	s.guard.mu.Unlock()
	if window != nil {
		window.Close()
	}
}

// GuardWindowClose cancels close requests for window while edits are unsaved and
// emits CloseRequestedEvent so the frontend can ask the user what to do.
func GuardWindowClose(s *PostgresService, window *application.WebviewWindow) {
	s.guard.mu.Lock()
	s.guard.window = window
	s.guard.mu.Unlock()
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !s.guard.shouldBlockClose() {
			return
		}
		event.Cancel()
		window.EmitEvent(CloseRequestedEvent)
	})
}
