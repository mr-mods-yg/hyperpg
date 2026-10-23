package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func connectionTestService(t *testing.T) *PostgresService {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "connections.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE saved_connections (id TEXT PRIMARY KEY, data BLOB NOT NULL, last_used INTEGER NOT NULL)`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	s := &PostgresService{
		connections: make(map[string]*sql.DB),
		store:       &localConnectionStore{db: db, key: bytes.Repeat([]byte{42}, 32)},
	}
	t.Cleanup(func() { s.ServiceShutdown() })
	return s
}

func TestLegacyConnectionVisibility(t *testing.T) {
	s := connectionTestService(t)
	// Existing encrypted records do not have the new visibility field.
	legacy := []byte(`{"info":{"id":"legacy","name":"Local","host":"localhost","database":"app","username":"user"},"databaseUrl":"postgresql://user:private-password@localhost/app"}`)
	protected, err := encryptLocalRecord(s.store.key, []byte("legacy"), legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.db.Exec(`INSERT INTO saved_connections VALUES (?, ?, ?)`, "legacy", protected, 1); err != nil {
		t.Fatal(err)
	}
	connections, err := s.ListSavedConnections()
	if err != nil || len(connections) != 1 || connections[0].ShowAllDatabases {
		t.Fatalf("legacy connection should default to its saved database: %#v, %v", connections, err)
	}
	record, err := s.store.get("legacy")
	if err != nil {
		t.Fatal(err)
	}
	record.Info.ShowAllDatabases = true
	if err := s.store.save(record); err != nil {
		t.Fatal(err)
	}
	connections, err = s.ListSavedConnections()
	if err != nil || !connections[0].ShowAllDatabases {
		t.Fatalf("visibility preference did not persist: %#v, %v", connections, err)
	}
	metadata, err := json.Marshal(connections)
	if err != nil || bytes.Contains(metadata, []byte("private-password")) || bytes.Contains(metadata, []byte("databaseUrl")) {
		t.Fatalf("connection metadata exposed credentials: %s, %v", metadata, err)
	}
}

func TestConnectionSettingsPostgres(t *testing.T) {
	databaseURL := os.Getenv("HYPERPG_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set HYPERPG_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	s := connectionTestService(t)
	info, err := s.Connect(databaseURL, "Original", false)
	if err != nil {
		t.Fatal(err)
	}
	databases, err := s.ListDatabases(info.ID)
	if err != nil || !slices.Equal(databases, []string{info.Database}) {
		t.Fatalf("unexpected default database list: %v, %v", databases, err)
	}
	if _, err := s.OpenDatabase(info.ID, "another-database"); err == nil {
		t.Fatal("other databases must require the visibility setting")
	}
	if _, err := s.OpenDatabase(info.ID, ""); err == nil {
		t.Fatal("empty database names must not fall back to another database")
	}
	updated, err := s.UpdateSavedConnection(info.ID, "", "Renamed", true)
	if err != nil || updated.ID != info.ID || updated.Name != "Renamed" || !updated.ShowAllDatabases {
		t.Fatalf("failed to update the same saved connection: %#v, %v", updated, err)
	}
	record, err := s.store.get(info.ID)
	if err != nil || record.DatabaseURL != databaseURL {
		t.Fatalf("blank edit should keep the original URL: %v", err)
	}
	databases, err = s.ListDatabases(info.ID)
	if err != nil || !slices.Contains(databases, info.Database) || slices.Contains(databases, "template0") || slices.Contains(databases, "template1") || !slices.IsSorted(databases) {
		t.Fatalf("unexpected server database list: %v, %v", databases, err)
	}
	if _, err := s.UpdateSavedConnection(info.ID, "not a postgres URL", "Broken", false); err == nil {
		t.Fatal("invalid replacement URL should fail")
	}
	record, err = s.store.get(info.ID)
	if err != nil || record.Info.Name != "Renamed" || !record.Info.ShowAllDatabases || record.DatabaseURL != databaseURL {
		t.Fatalf("failed update changed the saved settings: %#v, %v", record.Info, err)
	}
	base, err := s.connection(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	var canCreate bool
	if err := base.QueryRow(`SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&canCreate); err != nil {
		t.Fatal(err)
	}
	if !canCreate {
		t.Skip("database isolation checks require a test role with CREATEDB")
	}
	// Include URL and identifier punctuation to exercise database-name handling.
	otherDatabase := fmt.Sprintf("hyperpg /?%%\" %d", time.Now().UnixNano())
	quotedDatabase := pgx.Identifier{otherDatabase}.Sanitize()
	if _, err := base.Exec("CREATE DATABASE " + quotedDatabase); err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.CloseConnection(info.ID)
		if _, err := admin.Exec("DROP DATABASE " + quotedDatabase + " WITH (FORCE)"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	handle, err := s.OpenDatabase(info.ID, otherDatabase)
	if err != nil || handle == info.ID {
		t.Fatalf("could not open a separate database handle: %q, %v", handle, err)
	}
	other, err := s.connection(handle)
	if err != nil {
		t.Fatal(err)
	}
	var actual string
	if err := other.QueryRow("SELECT current_database()").Scan(&actual); err != nil || actual != otherDatabase {
		t.Fatalf("opened the wrong database: %q, %v", actual, err)
	}
	if cached, err := s.OpenDatabase(info.ID, otherDatabase); err != nil || cached != handle {
		t.Fatalf("database handle was not reused: %q, %v", cached, err)
	}
	schema := fmt.Sprintf("hyperpg_connections_%d", time.Now().UnixNano())
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	quotedTable := pgx.Identifier{schema, "items"}.Sanitize()
	if _, err := base.Exec("CREATE SCHEMA " + quotedSchema + "; CREATE TABLE " + quotedTable + " (value text); INSERT INTO " + quotedTable + " VALUES ('base')"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP SCHEMA " + quotedSchema + " CASCADE"); err != nil {
			t.Error(err)
		}
	})
	if _, err := other.Exec("CREATE SCHEMA " + quotedSchema + "; CREATE TABLE " + quotedTable + " (value text); INSERT INTO " + quotedTable + " VALUES ('other')"); err != nil {
		t.Fatal(err)
	}
	data, err := s.GetTableData(handle, schema, "items", 100, 0)
	if err != nil || len(data.Rows) != 1 || data.Rows[0][0] != "other" {
		t.Fatalf("read did not use the selected database: %#v, %v", data, err)
	}
	if err := s.SaveTableChanges(handle, schema, "items", []TableChange{{Kind: "update", Identity: &data.Identities[0], Values: map[string]*string{"value": textValue("edited")}}}); err != nil {
		t.Fatal(err)
	}
	baseData, err := s.GetTableData(info.ID, schema, "items", 100, 0)
	if err != nil || baseData.Rows[0][0] != "base" {
		t.Fatalf("save touched the default database: %#v, %v", baseData, err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + otherDatabase
	parsed.RawPath = ""
	query := parsed.Query()
	query.Del("database")
	query.Del("dbname")
	parsed.RawQuery = query.Encode()
	updated, err = s.UpdateSavedConnection(info.ID, parsed.String(), "Replacement", false)
	if err != nil || updated.Database != otherDatabase || updated.ShowAllDatabases {
		t.Fatalf("replacement URL was not applied: %#v, %v", updated, err)
	}
	if _, err := s.connection(handle); err == nil {
		t.Fatal("URL change retained a stale child handle")
	}
	if err := base.Ping(); err == nil {
		t.Fatal("URL change did not close the old default pool")
	}
	// Open a child after the edit, then delete the connection and all its pools.
	if _, err := s.UpdateSavedConnection(info.ID, "", "Replacement", true); err != nil {
		t.Fatal(err)
	}
	child, err := s.OpenDatabase(info.ID, info.Database)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSavedConnection(info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.connection(child); err == nil {
		t.Fatal("delete retained a child database handle")
	}
	saved, err := s.ListSavedConnections()
	if err != nil || len(saved) != 0 {
		t.Fatalf("delete retained the saved record: %#v, %v", saved, err)
	}
	for id := range s.connections {
		if strings.HasPrefix(id, info.ID) {
			t.Fatalf("delete retained live handle %q", id)
		}
	}
}
