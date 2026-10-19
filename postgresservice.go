package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// PostgresService manages live database connections and saved local connections.
// Credential-bearing URLs are decrypted only in Go and never sent to the frontend.
type PostgresService struct {
	mu          sync.RWMutex
	connections map[string]*sql.DB
	store       *localConnectionStore
}

type ConnectionInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Database string `json:"database"`
	Username string `json:"username"`
}

type TableInfo struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

type ColumnInfo struct {
	Name     string `json:"name"`
	DataType string `json:"dataType"`
}

type TableData struct {
	Columns  []ColumnInfo `json:"columns"`
	Rows     [][]any      `json:"rows"`
	RowCount int64        `json:"rowCount"`
}

// Connect opens and verifies a PostgreSQL URL, then saves it securely on this device.
func (s *PostgresService) Connect(databaseURL, displayName string) (ConnectionInfo, error) {
	db, parsed, database, err := openPostgresDatabase(databaseURL)
	if err != nil {
		return ConnectionInfo{}, err
	}
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		db.Close()
		return ConnectionInfo{}, fmt.Errorf("Could not create a connection")
	}

	info := ConnectionInfo{
		ID:       hex.EncodeToString(idBytes),
		Name:     strings.TrimSpace(displayName),
		Host:     parsed.Hostname(),
		Database: database,
	}
	if info.Name == "" {
		info.Name = database
	}
	if parsed.User != nil {
		info.Username = parsed.User.Username()
	}
	if err := s.store.save(storedConnection{Info: info, DatabaseURL: strings.TrimSpace(databaseURL)}); err != nil {
		db.Close()
		return ConnectionInfo{}, fmt.Errorf("Could not save this connection securely: %w", err)
	}

	s.mu.Lock()
	s.connections[info.ID] = db
	s.mu.Unlock()

	return info, nil
}

// ListSavedConnections returns saved connection metadata without exposing URLs.
func (s *PostgresService) ListSavedConnections() ([]ConnectionInfo, error) {
	saved, err := s.store.list()
	if err != nil {
		return nil, err
	}
	connections := make([]ConnectionInfo, 0, len(saved))
	for _, record := range saved {
		connections = append(connections, record.Info)
	}
	return connections, nil
}

// OpenSavedConnection decrypts and opens a connection stored on this device.
func (s *PostgresService) OpenSavedConnection(connectionID string) (ConnectionInfo, error) {
	record, err := s.store.get(connectionID)
	if err != nil {
		return ConnectionInfo{}, err
	}

	s.mu.RLock()
	_, alreadyOpen := s.connections[connectionID]
	s.mu.RUnlock()
	if alreadyOpen {
		s.store.touch(connectionID)
		return record.Info, nil
	}

	db, _, _, err := openPostgresDatabase(record.DatabaseURL)
	if err != nil {
		return ConnectionInfo{}, err
	}
	s.mu.Lock()
	if _, alreadyOpen := s.connections[connectionID]; alreadyOpen {
		s.mu.Unlock()
		_ = db.Close()
	} else {
		s.connections[connectionID] = db
		s.mu.Unlock()
	}
	s.store.touch(connectionID)
	return record.Info, nil
}

// DeleteSavedConnection removes a saved record and closes its live connection.
func (s *PostgresService) DeleteSavedConnection(connectionID string) error {
	if err := s.store.delete(connectionID); err != nil {
		return err
	}
	s.mu.Lock()
	db, ok := s.connections[connectionID]
	if ok {
		delete(s.connections, connectionID)
	}
	s.mu.Unlock()
	if ok {
		return db.Close()
	}
	return nil
}

// ListTables returns user tables from the active connection.
func (s *PostgresService) ListTables(connectionID string) ([]TableInfo, error) {
	db, err := s.connection(connectionID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `
		SELECT table_schema, table_name
		FROM information_schema.tables
		WHERE table_type = 'BASE TABLE'
		  AND table_schema NOT IN ('pg_catalog', 'information_schema')
		ORDER BY table_schema, table_name`)
	if err != nil {
		return nil, fmt.Errorf("Could not list tables: %w", err)
	}
	defer rows.Close()

	tables := make([]TableInfo, 0)
	for rows.Next() {
		var table TableInfo
		if err := rows.Scan(&table.Schema, &table.Name); err != nil {
			return nil, fmt.Errorf("Could not read the table list: %w", err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("Could not read the table list: %w", err)
	}
	return tables, nil
}

// GetTableData returns column names and a page of rows from a user table.
func (s *PostgresService) GetTableData(connectionID, schema, tableName string, limit, offset int) (TableData, error) {
	db, err := s.connection(connectionID)
	if err != nil {
		return TableData{}, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
		)`, schema, tableName).Scan(&exists); err != nil {
		return TableData{}, fmt.Errorf("Could not inspect table: %w", err)
	}
	if !exists {
		return TableData{}, fmt.Errorf("That table is no longer available")
	}

	columnRows, err := db.QueryContext(ctx, `
		SELECT column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = $2
		ORDER BY ordinal_position`, schema, tableName)
	if err != nil {
		return TableData{}, fmt.Errorf("Could not read table columns: %w", err)
	}
	columns := make([]ColumnInfo, 0)
	for columnRows.Next() {
		var column ColumnInfo
		if err := columnRows.Scan(&column.Name, &column.DataType); err != nil {
			columnRows.Close()
			return TableData{}, fmt.Errorf("Could not read table columns: %w", err)
		}
		columns = append(columns, column)
	}
	if err := columnRows.Err(); err != nil {
		columnRows.Close()
		return TableData{}, fmt.Errorf("Could not read table columns: %w", err)
	}
	columnRows.Close()

	quotedTable := pgx.Identifier{schema, tableName}.Sanitize()
	var rowCount int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quotedTable).Scan(&rowCount); err != nil {
		return TableData{}, fmt.Errorf("Could not count table rows: %w", err)
	}

	// Use the primary key to keep page boundaries stable. Tables without a
	// primary key fall back to their physical row location for this read.
	primaryKeys, err := db.QueryContext(ctx, `
		SELECT a.attname
		FROM pg_index i
		CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE i.indrelid = to_regclass($1) AND i.indisprimary
		ORDER BY k.ord`, quotedTable)
	if err != nil {
		return TableData{}, fmt.Errorf("Could not inspect table ordering: %w", err)
	}
	orderColumns := make([]string, 0)
	for primaryKeys.Next() {
		var columnName string
		if err := primaryKeys.Scan(&columnName); err != nil {
			primaryKeys.Close()
			return TableData{}, fmt.Errorf("Could not inspect table ordering: %w", err)
		}
		orderColumns = append(orderColumns, pgx.Identifier{columnName}.Sanitize())
	}
	if err := primaryKeys.Err(); err != nil {
		primaryKeys.Close()
		return TableData{}, fmt.Errorf("Could not inspect table ordering: %w", err)
	}
	primaryKeys.Close()
	orderBy := "ctid"
	if len(orderColumns) > 0 {
		orderBy = strings.Join(orderColumns, ", ")
	}
	rows, err := db.QueryContext(ctx, "SELECT * FROM "+quotedTable+" ORDER BY "+orderBy+" LIMIT $1 OFFSET $2", limit, offset)
	if err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}
	defer rows.Close()

	rowsData := make([][]any, 0)
	columnNames, err := rows.Columns()
	if err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}
	for rows.Next() {
		values := make([]any, len(columnNames))
		scanTargets := make([]any, len(columnNames))
		for i := range values {
			scanTargets[i] = &values[i]
		}
		if err := rows.Scan(scanTargets...); err != nil {
			return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
		}
		for i, value := range values {
			if bytes, ok := value.([]byte); ok {
				values[i] = string(bytes)
			} else if timestamp, ok := value.(time.Time); ok {
				values[i] = timestamp.Format(time.RFC3339Nano)
			}
		}
		rowsData = append(rowsData, values)
	}
	if err := rows.Err(); err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}

	return TableData{Columns: columns, Rows: rowsData, RowCount: rowCount}, nil
}

// CloseConnection releases a connection and removes it from the active list.
func (s *PostgresService) CloseConnection(connectionID string) error {
	s.mu.Lock()
	db, ok := s.connections[connectionID]
	if ok {
		delete(s.connections, connectionID)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return db.Close()
}

// ServiceShutdown closes all remaining database handles when the app exits.
func (s *PostgresService) ServiceShutdown() error {
	s.mu.Lock()
	connections := s.connections
	s.connections = make(map[string]*sql.DB)
	s.mu.Unlock()

	var firstErr error
	for _, db := range connections {
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if s.store != nil {
		if err := s.store.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *PostgresService) connection(connectionID string) (*sql.DB, error) {
	s.mu.RLock()
	db, ok := s.connections[connectionID]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("The database connection is no longer active")
	}
	return db, nil
}

func openPostgresDatabase(databaseURL string) (*sql.DB, *url.URL, string, error) {
	trimmedURL := strings.TrimSpace(databaseURL)
	parsed, err := url.Parse(trimmedURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Hostname() == "" {
		return nil, nil, "", fmt.Errorf("Enter a valid PostgreSQL URL")
	}
	database := strings.TrimPrefix(parsed.Path, "/")
	if database == "" {
		return nil, nil, "", fmt.Errorf("The connection URL needs a database name")
	}
	db, err := sql.Open("pgx", trimmedURL)
	if err != nil {
		return nil, nil, "", fmt.Errorf("Could not open the database connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, nil, "", fmt.Errorf("Could not connect to %s: %s", parsed.Hostname(), safeConnectionError(err))
	}
	return db, parsed, database, nil
}

func safeConnectionError(err error) string {
	message := err.Error()
	// Driver error strings can include credential-bearing DSNs. Never return one
	// to the frontend; keep only a short, generic description.
	lower := strings.ToLower(message)
	if strings.Contains(lower, "password") || strings.Contains(lower, "user=") || strings.Contains(lower, "postgres://") || strings.Contains(lower, "postgresql://") {
		return "check the URL and network access"
	}
	if len(message) > 180 {
		return "check the URL and network access"
	}
	return message
}
