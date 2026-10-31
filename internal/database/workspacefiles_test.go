package database

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteWorkspaceFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "script.sql")
	if err := os.WriteFile(path, []byte("old"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := writeWorkspaceFile(path, []byte("select 1;")); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "select 1;" {
		t.Fatalf("unexpected content %q", content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0640 {
		t.Fatalf("permissions changed: %v", info.Mode())
	}
	if err := writeWorkspaceFile(filepath.Join(dir, "missing", "script.sql"), []byte("new")); err == nil {
		t.Fatal("expected error for missing directory")
	}
	content, err = os.ReadFile(path)
	if err != nil || string(content) != "select 1;" {
		t.Fatalf("existing file changed: %q, %v", content, err)
	}
}

func TestWriteWorkspaceFilePreservesSymbolicLink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "target.sql"), filepath.Join(dir, "link.sql")
	if err := os.WriteFile(target, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.sql", link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if err := writeWorkspaceFile(link, []byte("after")); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("save replaced the symbolic link")
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "after" {
		t.Fatalf("target not saved: %s %v", content, err)
	}
}
