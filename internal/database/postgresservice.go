package database

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
	"github.com/jackc/pgx/v5/stdlib"
)

// PostgresService manages live database connections and saved local connections.
// Credential-bearing URLs are decrypted only in Go and never sent to the frontend.
type PostgresService struct {
	mu          sync.RWMutex
	connections map[string]*sql.DB
	store       *localConnectionStore
}

type ConnectionInfo struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Host             string `json:"host"`
	Database         string `json:"database"`
	Username         string `json:"username"`
	ShowAllDatabases bool   `json:"showAllDatabases"`
}

type TableInfo struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

type ColumnInfo struct {
	Name                 string `json:"name"`
	DataType             string `json:"dataType"`
	Nullable             bool   `json:"nullable"`
	HasDefault           bool   `json:"hasDefault"`
	Generated            bool   `json:"generated"`
	AutoIncrement        bool   `json:"autoIncrement"`
	DefaultValue         string `json:"defaultValue"`
	GenerationExpression string `json:"generationExpression"`
	IdentityGeneration   string `json:"identityGeneration"`
}

type TableData struct {
	Columns    []ColumnInfo  `json:"columns"`
	Rows       [][]any       `json:"rows"`
	RowCount   int64         `json:"rowCount"`
	Identities []RowIdentity `json:"identities"`
}

// Connect opens and verifies a PostgreSQL URL, then saves it securely on this device.
func (s *PostgresService) Connect(databaseURL, displayName string, showAllDatabases bool) (ConnectionInfo, error) {
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
		ID:               hex.EncodeToString(idBytes),
		Name:             strings.TrimSpace(displayName),
		Host:             parsed.Hostname(),
		Database:         database,
		ShowAllDatabases: showAllDatabases,
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

// UpdateSavedConnection verifies and replaces a saved connection in place.
// An empty URL retains the encrypted URL without exposing its credentials.
func (s *PostgresService) UpdateSavedConnection(connectionID, databaseURL, displayName string, showAllDatabases bool) (ConnectionInfo, error) {
	record, err := s.store.get(connectionID)
	if err != nil {
		return ConnectionInfo{}, err
	}
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		databaseURL = record.DatabaseURL
	}
	db, parsed, database, err := openPostgresDatabase(databaseURL)
	if err != nil {
		return ConnectionInfo{}, err
	}
	info := ConnectionInfo{ID: connectionID, Name: strings.TrimSpace(displayName), Host: parsed.Hostname(), Database: database, ShowAllDatabases: showAllDatabases}
	if info.Name == "" {
		info.Name = database
	}
	if parsed.User != nil {
		info.Username = parsed.User.Username()
	}
	s.mu.Lock()
	// Do not recreate a connection removed while its replacement was opening.
	if _, err := s.store.get(connectionID); err != nil {
		s.mu.Unlock()
		db.Close()
		return ConnectionInfo{}, err
	}
	if err := s.store.save(storedConnection{Info: info, DatabaseURL: databaseURL}); err != nil {
		s.mu.Unlock()
		db.Close()
		return ConnectionInfo{}, fmt.Errorf("Could not save this connection securely: %w", err)
	}
	previous := s.removeConnectionHandles(connectionID)
	s.connections[connectionID] = db
	s.mu.Unlock()
	for _, handle := range previous {
		_ = handle.Close()
	}
	return info, nil
}

// ListDatabases lists connectable user databases, or just the saved database.
func (s *PostgresService) ListDatabases(connectionID string) ([]string, error) {
	info, err := s.OpenSavedConnection(connectionID)
	if err != nil {
		return nil, err
	}
	if !info.ShowAllDatabases {
		return []string{info.Database}, nil
	}
	db, err := s.connection(connectionID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT datname FROM pg_database
		WHERE datallowconn AND NOT datistemplate AND has_database_privilege(oid, 'CONNECT')
		ORDER BY datname`)
	if err != nil {
		return nil, fmt.Errorf("Could not list databases: %w", err)
	}
	defer rows.Close()
	databases := make([]string, 0)
	for rows.Next() {
		var database string
		if err := rows.Scan(&database); err != nil {
			return nil, fmt.Errorf("Could not read the database list: %w", err)
		}
		databases = append(databases, database)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("Could not read the database list: %w", err)
	}
	return databases, nil
}

// OpenDatabase returns a live handle scoped to a database under a saved connection.
// The saved URL and default database are unchanged when browsing other databases.
func (s *PostgresService) OpenDatabase(connectionID, database string) (string, error) {
	if database == "" {
		return "", fmt.Errorf("Choose a database to open")
	}
	info, err := s.OpenSavedConnection(connectionID)
	if err != nil {
		return "", err
	}
	if database == info.Database {
		return connectionID, nil
	}
	if !info.ShowAllDatabases {
		return "", fmt.Errorf("Enable Show all databases to open another database")
	}
	base, err := s.connection(connectionID)
	if err != nil {
		return "", err
	}
	handleID := connectionID + ":" + database
	s.mu.RLock()
	_, alreadyOpen := s.connections[handleID]
	s.mu.RUnlock()
	if alreadyOpen {
		return handleID, nil
	}
	record, err := s.store.get(connectionID)
	if err != nil {
		return "", err
	}
	config, err := pgx.ParseConfig(record.DatabaseURL)
	if err != nil {
		return "", fmt.Errorf("Could not read the saved connection URL")
	}
	// The parsed configuration preserves credentials and URL options without
	// treating database names as SQL or URL syntax.
	config.Database = database
	db := sql.OpenDB(stdlib.GetConnector(*config))
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return "", fmt.Errorf("Could not open database %s: %s", database, safeConnectionError(err))
	}
	s.mu.Lock()
	if s.connections[connectionID] != base {
		s.mu.Unlock()
		db.Close()
		return "", fmt.Errorf("The connection changed; open the database again")
	}
	if _, alreadyOpen := s.connections[handleID]; alreadyOpen {
		s.mu.Unlock()
		db.Close()
	} else {
		s.connections[handleID] = db
		s.mu.Unlock()
	}
	return handleID, nil
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
	current, err := s.store.get(connectionID)
	if err != nil || current.DatabaseURL != record.DatabaseURL {
		s.mu.Unlock()
		db.Close()
		return ConnectionInfo{}, fmt.Errorf("The saved connection changed; open it again")
	}
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
	s.mu.Lock()
	if err := s.store.delete(connectionID); err != nil {
		s.mu.Unlock()
		return err
	}
	handles := s.removeConnectionHandles(connectionID)
	s.mu.Unlock()
	for _, db := range handles {
		_ = db.Close()
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

	columns, err := readTableColumns(ctx, db, schema, tableName)
	if err != nil {
		return TableData{}, err
	}

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
		orderColumns = append(orderColumns, pgx.Identifier{"hyperpg_row", columnName}.Sanitize())
	}
	if err := primaryKeys.Err(); err != nil {
		primaryKeys.Close()
		return TableData{}, fmt.Errorf("Could not inspect table ordering: %w", err)
	}
	primaryKeys.Close()
	orderBy := `"hyperpg_row".tableoid, "hyperpg_row".ctid`
	if len(orderColumns) > 0 {
		orderBy = strings.Join(orderColumns, ", ")
	}
	// Text preserves bigint/numeric precision, PostgreSQL arrays, bytea and time
	// values across the JSON bridge. Only edited values are sent back on save.
	selectColumns := []string{`"hyperpg_row".tableoid::text`, `"hyperpg_row".ctid::text`, `"hyperpg_row".xmin::text`}
	for _, column := range columns {
		selectColumns = append(selectColumns, pgx.Identifier{"hyperpg_row", column.Name}.Sanitize()+"::text")
	}
	rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(selectColumns, ", ")+" FROM "+quotedTable+` AS "hyperpg_row" ORDER BY `+orderBy+" LIMIT $1 OFFSET $2", limit, offset)
	if err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}
	defer rows.Close()

	rowsData := make([][]any, 0)
	identities := make([]RowIdentity, 0)
	for rows.Next() {
		values := make([]any, len(columns)+3)
		scanTargets := make([]any, len(values))
		for i := range values {
			scanTargets[i] = &values[i]
		}
		if err := rows.Scan(scanTargets...); err != nil {
			return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
		}
		identities = append(identities, RowIdentity{TableOID: values[0].(string), CTID: values[1].(string), Version: values[2].(string)})
		row := values[3:]
		for i, column := range columns {
			if column.DataType == "boolean" && row[i] != nil {
				row[i] = row[i] == "true"
			}
		}
		rowsData = append(rowsData, row)
	}
	if err := rows.Err(); err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}

	return TableData{Columns: columns, Rows: rowsData, RowCount: rowCount, Identities: identities}, nil
}

// CloseConnection releases a connection and removes it from the active list.
func (s *PostgresService) CloseConnection(connectionID string) error {
	s.mu.Lock()
	handles := s.removeConnectionHandles(connectionID)
	s.mu.Unlock()
	var firstErr error
	for _, db := range handles {
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// removeConnectionHandles requires s.mu and removes the default and child pools.
func (s *PostgresService) removeConnectionHandles(connectionID string) []*sql.DB {
	var handles []*sql.DB
	for id, db := range s.connections {
		if id == connectionID || strings.HasPrefix(id, connectionID+":") {
			handles = append(handles, db)
			delete(s.connections, id)
		}
	}
	return handles
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
	config, err := pgx.ParseConfig(trimmedURL)
	if err != nil {
		return nil, nil, "", fmt.Errorf("Enter a valid PostgreSQL URL")
	}
	database = config.Database
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
