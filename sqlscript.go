package main

import (
	"context"
	"database/sql/driver"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
)

const scriptResultRowLimit = 500

type ScriptResult struct {
	Columns   []string    `json:"columns"`
	Rows      [][]*string `json:"rows"`
	Command   string      `json:"command"`
	Truncated bool        `json:"truncated"`
}

type ScriptExecution struct {
	Results    []ScriptResult `json:"results"`
	Error      string         `json:"error"`
	RolledBack bool           `json:"rolledBack"`
}

// ExecuteSQLScript executes the script using PostgreSQL's simple query protocol,
// preserving statement boundaries and PostgreSQL's own transaction semantics.
func (s *PostgresService) ExecuteSQLScript(connectionID, script string) (ScriptExecution, error) {
	if strings.TrimSpace(script) == "" {
		return ScriptExecution{}, fmt.Errorf("Enter a SQL script")
	}
	db, err := s.connection(connectionID)
	if err != nil {
		return ScriptExecution{}, err
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		return ScriptExecution{}, fmt.Errorf("Could not open a database connection: %w", err)
	}
	defer conn.Close()
	output := ScriptExecution{Results: []ScriptResult{}}
	err = conn.Raw(func(raw any) error {
		pg, ok := raw.(*stdlib.Conn)
		if !ok {
			return fmt.Errorf("Unexpected database driver")
		}
		wire := pg.Conn().PgConn()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		reader := wire.Exec(ctx, script)
		for reader.NextResult() {
			rr := reader.ResultReader()
			result := ScriptResult{Columns: []string{}, Rows: [][]*string{}}
			for _, col := range rr.FieldDescriptions() {
				result.Columns = append(result.Columns, col.Name)
			}
			for rr.NextRow() {
				if len(result.Rows) >= scriptResultRowLimit {
					result.Truncated = true
					continue
				}
				row := make([]*string, len(rr.Values()))
				for i, value := range rr.Values() {
					if value != nil {
						text := string(value)
						row[i] = &text
					}
				}
				result.Rows = append(result.Rows, row)
			}
			tag, resultErr := rr.Close()
			result.Command = tag.String()
			if resultErr == nil {
				output.Results = append(output.Results, result)
			}
		}
		if err := reader.Close(); err != nil {
			output.Error = err.Error()
		}
		// An unfinished explicit transaction must not leak into the shared pool.
		if wire.TxStatus() != 'I' && !wire.IsClosed() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := wire.Exec(ctx, "ROLLBACK").ReadAll(); err != nil {
				return driver.ErrBadConn
			}
			output.RolledBack = true
		}
		if wire.IsClosed() {
			return driver.ErrBadConn
		}
		return nil
	})
	if err != nil {
		return output, fmt.Errorf("Could not execute script: %w", err)
	}
	return output, nil
}
