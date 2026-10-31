package database

import (
	"database/sql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTableQueryParts(t *testing.T) {
	cols := []ColumnInfo{{Name: "id"}, {Name: `na"me`}}
	where, order, args, err := tableQueryParts(cols, TableQueryOptions{Filters: []TableFilter{{Column: `na"me`, Operator: "eq", Value: `x' OR true --`}, {Column: "id", Operator: "between", Value: "1", Value2: "3"}}, Sort: []TableSort{{Column: `na"me`, Direction: "desc"}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(where, "OR true") || !strings.Contains(where, `"na""me" = $1`) || !strings.Contains(where, "BETWEEN $2 AND $3") || len(args) != 3 {
		t.Fatalf("unsafe query: %q %#v", where, args)
	}
	if !strings.Contains(order, `"na""me" DESC`) || !strings.Contains(order, "tableoid") {
		t.Fatal(order)
	}
	for _, o := range []TableQueryOptions{{Filters: []TableFilter{{Column: "missing", Operator: "eq"}}}, {Filters: []TableFilter{{Column: "id", Operator: "injection"}}}, {Sort: []TableSort{{Column: "id", Direction: "asc; drop table x"}}}} {
		if _, _, _, err = tableQueryParts(cols, o); err == nil {
			t.Fatalf("accepted %#v", o)
		}
	}
}

func TestTableFeaturesPostgres(t *testing.T) {
	dsn := os.Getenv("HYPERPG_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set HYPERPG_TEST_DATABASE_URL for PostgreSQL integration")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TEMP TABLE hyperpg_feature_test (id bigint PRIMARY KEY, value text, amount numeric, enabled boolean); CREATE INDEX feature_value_idx ON hyperpg_feature_test(value); INSERT INTO hyperpg_feature_test SELECT i, CASE WHEN i=2 THEN NULL ELSE 'value '||i END, 12345678901234567890.123456789, i%2=0 FROM generate_series(1, 510) i`)
	if err != nil {
		t.Fatal(err)
	}
	// Temporary tables are session-local, so retain one connection for the pool.
	db.SetMaxOpenConns(1)
	var schema string
	if err = db.QueryRow(`SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	svc := &PostgresService{connections: map[string]*sql.DB{"test": db}}
	opts := TableQueryOptions{Filters: []TableFilter{{Column: "id", Operator: "gte", Value: "2"}}, Sort: []TableSort{{Column: "id", Direction: "desc"}}}
	page, err := svc.GetFilteredTableData("test", schema, "hyperpg_feature_test", 10, 0, opts)
	if err != nil {
		t.Fatal(err)
	}
	if page.RowCount != 509 || len(page.Rows) != 10 || page.Rows[0][0] != "510" || len(page.Identities) != 10 {
		t.Fatalf("bad page %#v", page)
	}
	meta, err := svc.GetTableMetadata("test", schema, "hyperpg_feature_test")
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Constraints) != 1 || meta.Constraints[0].Type != "PRIMARY KEY" || !strings.Contains(meta.DDL, "numeric") || !strings.Contains(meta.DDL, "feature_value_idx") || strings.Contains(meta.DDL, "CREATE UNIQUE INDEX") {
		t.Fatalf("bad metadata %#v", meta)
	}
	contains, err := svc.GetFilteredTableData("test", schema, "hyperpg_feature_test", 10, 0, TableQueryOptions{Filters: []TableFilter{{Column: "value", Operator: "contains", Value: "%"}}})
	if err != nil || contains.RowCount != 0 {
		t.Fatalf("literal contains filter: %v %#v", err, contains)
	}
	path := filepath.Join(t.TempDir(), "data.json")
	if err = svc.ExportTableData("test", schema, "hyperpg_feature_test", opts, "json", path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), `"id":`) != 509 || !strings.Contains(string(data), `12345678901234567890.123456789`) || !strings.Contains(string(data), `"value":null`) {
		t.Fatal("export lost rows, precision, or null")
	}
	if _, err = db.Exec(`CREATE TEMP TABLE hyperpg_identity_export (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text, derived text GENERATED ALWAYS AS (upper(label)) STORED); INSERT INTO hyperpg_identity_export (id, label) OVERRIDING SYSTEM VALUE VALUES (42, 'one')`); err != nil {
		t.Fatal(err)
	}
	identityPath := filepath.Join(t.TempDir(), "identity.sql")
	if err = svc.ExportTableData("test", schema, "hyperpg_identity_export", TableQueryOptions{}, "sql", identityPath); err != nil {
		t.Fatal(err)
	}
	identitySQL, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`TRUNCATE hyperpg_identity_export RESTART IDENTITY`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(identitySQL)); err != nil {
		t.Fatalf("invalid SQL export: %v\n%s", err, identitySQL)
	}
	var restoredID int
	var derived string
	if err = db.QueryRow(`SELECT id, derived FROM hyperpg_identity_export`).Scan(&restoredID, &derived); err != nil || restoredID != 42 || derived != "ONE" {
		t.Fatalf("identity/computed column round trip: %v, %d, %s", err, restoredID, derived)
	}

}
