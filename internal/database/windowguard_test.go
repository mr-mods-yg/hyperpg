package database

import "testing"

func TestWindowGuardBlocksCloseOnlyWithUnsavedChanges(t *testing.T) {
	s := &PostgresService{}
	if s.guard.shouldBlockClose() {
		t.Fatal("close blocked without unsaved changes")
	}
	s.SetUnsavedChanges(true)
	if !s.guard.shouldBlockClose() {
		t.Fatal("close not blocked with unsaved changes")
	}
	s.SetUnsavedChanges(false)
	if s.guard.shouldBlockClose() {
		t.Fatal("close still blocked after changes were saved")
	}
	s.SetUnsavedChanges(true)
	s.CloseWindow() // no window attached: only allows the next close
	if s.guard.shouldBlockClose() {
		t.Fatal("close blocked after the user confirmed quitting")
	}
}
