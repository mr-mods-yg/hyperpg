package main

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func textValue(value string) *string { return &value }

// These tests use a disposable schema in the explicitly configured test DB.
func gridTestDatabase(t *testing.T) (*PostgresService, *sql.DB, string) {
	t.Helper()
	url := os.Getenv("HYPERPG_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set HYPERPG_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	schema := fmt.Sprintf("hyperpg_grid_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := db.Exec("CREATE SCHEMA " + quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec("DROP SCHEMA " + quoted + " CASCADE"); err != nil {
			t.Error(err)
		}
	})
	return &PostgresService{connections: map[string]*sql.DB{"test": db}}, db, schema
}

func TestTableChangesValidation(t *testing.T) {
	s := &PostgresService{}
	if err := s.SaveTableChanges("", "", "", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveTableChanges("", "", "", make([]TableChange, 1001)); err == nil {
		t.Fatal("expected batch size limit")
	}
	if err := s.SaveTableChanges("missing", "", "", []TableChange{{Kind: "insert"}}); err == nil {
		t.Fatal("expected missing connection error")
	}
}

func TestTableEditingPostgres(t *testing.T) {
	s, db, schema := gridTestDatabase(t)
	table := `records " quoted`
	quoted := pgx.Identifier{schema, table}.Sanitize()
	_, err := db.Exec("CREATE TABLE " + quoted + ` (
		id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		name text NOT NULL UNIQUE DEFAULT 'default name',
		amount numeric(30,10), enabled boolean DEFAULT true,
		payload jsonb, tags text[], "binary" bytea, happened timestamptz,
		computed text GENERATED ALWAYS AS (upper(name)) STORED);
		INSERT INTO ` + quoted + ` (name, amount) VALUES ('alpha', 9007199254740993.1234567890), ('beta', 2)`)
	if err != nil {
		t.Fatal(err)
	}
	data, err := s.GetTableData("test", schema, table, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Identities) != 2 || data.Rows[0][2] != "9007199254740993.1234567890" {
		t.Fatalf("row identity or numeric precision lost: %#v", data)
	}
	if !data.Columns[0].Generated || !data.Columns[0].HasDefault || data.Columns[1].Nullable || !data.Columns[8].Generated {
		t.Fatalf("wrong column metadata: %#v", data.Columns)
	}
	if data.Rows[0][3] != true {
		t.Fatalf("boolean was not preserved: %#v", data.Rows[0][3])
	}
	alpha, beta := data.Identities[0], data.Identities[1]
	err = s.SaveTableChanges("test", schema, table, []TableChange{
		{Kind: "update", Identity: &alpha, Values: map[string]*string{"name": textValue("edited, \"quoted\"\nline"), "amount": textValue("12345678901234567890.1234567890"), "enabled": textValue("false"), "payload": textValue(`{"x":[1,2]}`), "tags": textValue(`{"a,b","c"}`), "binary": textValue(`\xdeadbeef`), "happened": textValue("2026-10-20T12:34:56.123456Z")}},
		{Kind: "delete", Identity: &beta},
		{Kind: "insert", Values: map[string]*string{"name": textValue("new"), "amount": nil}},
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err = s.GetTableData("test", schema, table, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if data.RowCount != 2 || data.Rows[0][2] != "12345678901234567890.1234567890" || data.Rows[0][3] != false || data.Rows[0][6] != `\xdeadbeef` || data.Rows[1][2] != nil {
		t.Fatalf("wrong saved values: %#v", data.Rows)
	}
	if err := s.SaveTableChanges("test", schema, table, []TableChange{{Kind: "insert"}}); err != nil {
		t.Fatalf("default-only insert failed: %v", err)
	}
	// A constraint error after a valid edit must roll back the valid edit too.
	identity := data.Identities[0]
	err = s.SaveTableChanges("test", schema, table, []TableChange{
		{Kind: "update", Identity: &identity, Values: map[string]*string{"name": textValue("should roll back")}},
		{Kind: "insert", Values: map[string]*string{"name": nil}},
	})
	if err == nil {
		t.Fatal("expected NOT NULL failure")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM " + quoted + " WHERE name = 'should roll back'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("transaction was not rolled back: %d, %v", count, err)
	}
	for _, change := range []TableChange{
		{Kind: "update", Identity: &identity, Values: map[string]*string{"computed": textValue("bad")}},
		{Kind: "update", Identity: &identity, Values: map[string]*string{"unknown": textValue("bad")}},
		{Kind: "update", Values: map[string]*string{"name": textValue("bad")}},
		{Kind: "unknown"},
	} {
		if err := s.SaveTableChanges("test", schema, table, []TableChange{change}); err == nil {
			t.Fatalf("expected invalid change to fail: %#v", change)
		}
	}
}

func TestConcurrentEditsRollback(t *testing.T) {
	s, db, schema := gridTestDatabase(t)
	quoted := pgx.Identifier{schema, "items"}.Sanitize()
	if _, err := db.Exec("CREATE TABLE " + quoted + " (id int PRIMARY KEY, value text); INSERT INTO " + quoted + " VALUES (1, 'one'), (2, 'two')"); err != nil {
		t.Fatal(err)
	}
	data, err := s.GetTableData("test", schema, "items", 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE " + quoted + " SET value = 'external' WHERE id = 2"); err != nil {
		t.Fatal(err)
	}
	err = s.SaveTableChanges("test", schema, "items", []TableChange{
		{Kind: "update", Identity: &data.Identities[0], Values: map[string]*string{"value": textValue("local")}},
		{Kind: "delete", Identity: &data.Identities[1]},
	})
	if err == nil || !strings.Contains(err.Error(), "No changes were saved") {
		t.Fatalf("expected concurrent modification error: %v", err)
	}
	var value string
	if err := db.QueryRow("SELECT value FROM " + quoted + " WHERE id = 1").Scan(&value); err != nil || value != "one" {
		t.Fatalf("earlier update escaped rollback: %q, %v", value, err)
	}
	if err := db.QueryRow("SELECT value FROM " + quoted + " WHERE id = 2").Scan(&value); err != nil || value != "external" {
		t.Fatalf("external edit was lost: %q, %v", value, err)
	}
}

func TestNumericPrimaryKeyPagination(t *testing.T) {
	s, db, schema := gridTestDatabase(t)
	quoted := pgx.Identifier{schema, "ordered"}.Sanitize()
	if _, err := db.Exec("CREATE TABLE " + quoted + " (id int PRIMARY KEY); INSERT INTO " + quoted + " VALUES (10), (2), (1)"); err != nil {
		t.Fatal(err)
	}
	data, err := s.GetTableData("test", schema, "ordered", 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Rows) != 2 || data.Rows[0][0] != "1" || data.Rows[1][0] != "2" {
		t.Fatalf("keys sorted as text instead of numbers: %#v", data.Rows)
	}
	identity := data.Identities[1]
	if err := s.SaveTableChanges("test", schema, "ordered", []TableChange{{Kind: "update", Identity: &identity, Values: map[string]*string{"id": textValue("3")}}}); err != nil {
		t.Fatal(err)
	}
	data, err = s.GetTableData("test", schema, "ordered", 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Rows) != 1 || data.Rows[0][0] != "10" {
		t.Fatalf("wrong second page after key edit: %#v", data.Rows)
	}
}

func TestPartitionAndDuplicateRowIdentity(t *testing.T) {
	s, db, schema := gridTestDatabase(t)
	parent := pgx.Identifier{schema, "parent"}.Sanitize()
	first := pgx.Identifier{schema, "first"}.Sanitize()
	second := pgx.Identifier{schema, "second"}.Sanitize()
	_, err := db.Exec("CREATE TABLE " + parent + " (id int, value text) PARTITION BY RANGE (id); CREATE TABLE " + first + " PARTITION OF " + parent + " FOR VALUES FROM (0) TO (10); CREATE TABLE " + second + " PARTITION OF " + parent + " FOR VALUES FROM (10) TO (20); INSERT INTO " + parent + " VALUES (1, 'same'), (1, 'same'), (11, 'same')")
	if err != nil {
		t.Fatal(err)
	}
	data, err := s.GetTableData("test", schema, "parent", 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Identities) != 3 || data.Identities[0].TableOID == data.Identities[2].TableOID {
		t.Fatalf("missing partition identity: %#v", data.Identities)
	}
	if err := s.SaveTableChanges("test", schema, "parent", []TableChange{{Kind: "update", Identity: &data.Identities[1], Values: map[string]*string{"value": textValue("only one")}}}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM " + parent + " WHERE value = 'only one'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("wrong duplicate row edited: %d, %v", count, err)
	}
}
