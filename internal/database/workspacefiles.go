package database

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type SQLFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

func (s *PostgresService) OpenSQLFile() (SQLFile, error) {
	path, err := application.Get().Dialog.OpenFile().SetTitle("Open SQL script").AddFilter("SQL files", "*.sql").PromptForSingleSelection()
	if err != nil || path == "" {
		return SQLFile{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return SQLFile{}, err
	}
	return SQLFile{Path: path, Name: filepath.Base(path), Content: string(content)}, nil
}

func (s *PostgresService) SaveSQLFile(path, name, content string) (SQLFile, error) {
	var err error
	if path == "" {
		if !strings.HasSuffix(strings.ToLower(name), ".sql") {
			name += ".sql"
		}
		path, err = application.Get().Dialog.SaveFile().SetMessage("Save SQL script").SetFilename(name).AddFilter("SQL files", "*.sql").PromptForSingleSelection()
		if err != nil || path == "" {
			return SQLFile{}, err
		}
	}
	if err = writeWorkspaceFile(path, []byte(content)); err != nil {
		return SQLFile{}, err
	}
	return SQLFile{Path: path, Name: filepath.Base(path), Content: content}, nil
}

func (s *PostgresService) ChooseExportPath(defaultName string) (string, error) {
	return application.Get().Dialog.SaveFile().SetMessage("Export data").SetFilename(filepath.Base(defaultName)).PromptForSingleSelection()
}

func (s *PostgresService) WriteExportFile(path, contents string) error {
	return writeWorkspaceFile(path, []byte(contents))
}

// writeWorkspaceFile keeps the original intact until the replacement is complete.
func writeWorkspaceFile(path string, content []byte) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		resolved, resolveErr := filepath.EvalSymlinks(path)
		if resolveErr != nil {
			return resolveErr
		}
		path = resolved
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".hyperpg-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if info, statErr := os.Stat(path); statErr == nil {
		if err = file.Chmod(info.Mode().Perm()); err != nil {
			file.Close()
			return err
		}
	}
	if _, err = file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
