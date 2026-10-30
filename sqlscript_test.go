package main

import (
	"os"
	"strings"
	"testing"
)

func TestExecuteSQLScriptValidation(t *testing.T) {
	s := connectionTestService(t)
	if _, err := s.ExecuteSQLScript("missing", " \n "); err == nil {
		t.Fatal("empty scripts must fail")
	}
	if _, err := s.ExecuteSQLScript("missing", "SELECT 1"); err == nil {
		t.Fatal("unknown connections must fail")
	}
}

func TestExecuteSQLScriptPostgres(t *testing.T) {
	url := os.Getenv("HYPERPG_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set HYPERPG_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	s := connectionTestService(t)
	info, err := s.Connect(url, "SQL test", false)
	if err != nil {
		t.Fatal(err)
	}
	run := func(script string) ScriptExecution {
		t.Helper()
		result, err := s.ExecuteSQLScript(info.ID, script)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := run("SELECT ';' AS value, NULL AS missing; SELECT 2 AS number")
	if result.Error != "" || len(result.Results) != 2 || *result.Results[0].Rows[0][0] != ";" || result.Results[0].Rows[0][1] != nil || *result.Results[1].Rows[0][0] != "2" {
		t.Fatalf("unexpected multi-statement results: %#v", result)
	}
	result = run("SELECT generate_series(1, 501)")
	if len(result.Results) != 1 || len(result.Results[0].Rows) != 500 || !result.Results[0].Truncated {
		t.Fatalf("row limit not applied: %#v", result)
	}
	result = run("SELECT 1; SELECT 1/0; SELECT 2")
	if !strings.Contains(result.Error, "division by zero") || len(result.Results) != 1 {
		t.Fatalf("statement error not reported: %#v", result)
	}
	result = run("BEGIN; SELECT 1")
	if !result.RolledBack {
		t.Fatalf("unfinished transaction not rolled back: %#v", result)
	}
	result = run("SELECT 3")
	if result.Error != "" || *result.Results[0].Rows[0][0] != "3" {
		t.Fatalf("connection unusable after rollback: %#v", result)
	}
}
