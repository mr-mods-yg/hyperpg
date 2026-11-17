package database

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestExecuteSQLScriptValidation(t *testing.T) {
	s := connectionTestService(t)
	if _, err := s.ExecuteSQLScript("missing", " \n ", ""); err == nil {
		t.Fatal("empty scripts must fail")
	}
	if _, err := s.ExecuteSQLScript("missing", "SELECT 1", ""); err == nil {
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
		result, err := s.ExecuteSQLScript(info.ID, script, "")
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
	if !strings.Contains(result.Error, "division by zero") || len(result.Results) != 1 || result.FailedStatement != 2 || result.StatementCount != 3 || result.RolledBackFrom != 1 {
		t.Fatalf("statement error not reported: %#v", result)
	}
	result = run("SELECT 1;\nSELECT missing_column FROM (SELECT 1) AS t;\nSELECT 2")
	if result.FailedStatement != 2 || result.ErrorPosition != 18 || !strings.Contains(result.Error, "LINE 2: SELECT missing_column") || !strings.Contains(result.Error, "\n               ^") {
		t.Fatalf("error position not reported: %#v", result)
	}
	result = run("SELECT 1; SELEC 2; SELECT 3")
	if len(result.Results) != 0 || result.FailedStatement != 2 || result.ErrorPosition != 11 || result.RolledBackFrom != 0 {
		t.Fatalf("syntax error statement not reported: %#v", result)
	}
	// PostgreSQL counts characters, not bytes, and positions span leading comments.
	script := "-- héllo wörld 😀\nSELECT 'é;' AS \"a;\"\"b\";\n  /* ü */ SELECT nope_column FROM (SELECT 1) AS t;\nSELECT 3"
	result = run(script)
	if result.FailedStatement != 2 || result.StatementCount != 3 || result.ErrorPosition < 1 || !strings.HasPrefix(string([]rune(script)[result.ErrorPosition-1:]), "nope_column") || !strings.Contains(result.Error, "LINE 3:   /* ü */ SELECT nope_column") {
		t.Fatalf("multibyte error position not mapped: %#v", result)
	}
	// ROLLBACK TO SAVEPOINT has the same command tag as ROLLBACK but keeps the
	// transaction, so everything since the start of the block is undone.
	result = run("CREATE TEMP TABLE rb (id int); BEGIN; INSERT INTO rb VALUES (1); SAVEPOINT s; INSERT INTO rb VALUES (2); ROLLBACK TO SAVEPOINT s; SELECT 1/0")
	if result.FailedStatement != 7 || result.RolledBackFrom != 1 || !result.RolledBack {
		t.Fatalf("rollback to savepoint treated as the end of the transaction: %#v", result)
	}
	// A script that loses its session reports its own error, not "bad connection".
	result = run("SELECT 1; SELECT pg_terminate_backend(pg_backend_pid())")
	if !strings.Contains(result.Error, "terminating connection") || result.FailedStatement != 2 || len(result.Results) != 1 {
		t.Fatalf("terminated session not reported: %#v", result)
	}
	if result = run("SELECT 4"); result.Error != "" || *result.Results[0].Rows[0][0] != "4" {
		t.Fatalf("pool unusable after a terminated session: %#v", result)
	}
	result = run("CREATE TEMP TABLE t (id int); INSERT INTO t VALUES (1); COMMIT; INSERT INTO t VALUES (2); SELECT 1/0")
	if result.FailedStatement != 5 || result.RolledBackFrom != 4 {
		t.Fatalf("rolled back range not reported: %#v", result)
	}
	result = run("BEGIN; SELECT 1")
	if !result.RolledBack {
		t.Fatalf("unfinished transaction not rolled back: %#v", result)
	}
	result = run("SELECT 3")
	if result.Error != "" || *result.Results[0].Rows[0][0] != "3" {
		t.Fatalf("connection unusable after rollback: %#v", result)
	}

	// waitForSleep waits until the script's pg_sleep is running, so the cancel
	// lands in a known statement.
	waitForSleep := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			probe := run("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND position('" + marker + "' in query) > 0")
			if probe.Error == "" && *probe.Results[0].Rows[0][0] == "1" {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("pg_sleep never started")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	// The first script is cancelled as early as possible, possibly before it
	// reaches the server; the second only once it is inside pg_sleep.
	for index, script := range []string{"SELECT 1; SELECT pg_sleep(30); SELECT 2", "BEGIN; CREATE TABLE hyperpg_cancel_probe (id int); SELECT pg_sleep(30) /* hyperpg_cancel_marker */; COMMIT"} {
		done := make(chan ScriptExecution, 1)
		go func() {
			result, err := s.ExecuteSQLScript(info.ID, script, "cancel-test")
			if err != nil {
				t.Error(err)
			}
			done <- result
		}()
		if index == 1 {
			waitForSleep("hyperpg_cancel_marker")
		}
		deadline := time.Now().Add(5 * time.Second)
		for !s.CancelSQLScript("cancel-test") {
			if time.Now().After(deadline) {
				t.Fatal("script never became cancellable")
			}
			time.Sleep(20 * time.Millisecond)
		}
		started := time.Now()
		select {
		case result = <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("cancelled script did not stop")
		}
		// Finishing before the grace period means PostgreSQL honoured the cancel request.
		if time.Since(started) >= cancelGracePeriod || !result.Cancelled || result.Error != "Query cancelled" {
			t.Fatalf("cancel not reported: %#v", result)
		}
		if strings.HasPrefix(script, "BEGIN") && (result.FailedStatement != 3 || !result.RolledBack) {
			t.Fatalf("cancelled transaction not rolled back: %#v", result)
		}
		if s.CancelSQLScript("cancel-test") {
			t.Fatal("finished scripts must not be cancellable")
		}
	}
	if len(s.scripts.runs) != 0 {
		t.Fatalf("finished scripts left registry entries: %v", s.scripts.runs)
	}
	result = run("SELECT to_regclass('hyperpg_cancel_probe') IS NULL")
	if result.Error != "" || *result.Results[0].Rows[0][0] != "t" {
		t.Fatalf("cancelled transaction leaked changes: %#v", result)
	}
}

func TestSplitStatements(t *testing.T) {
	cases := map[string]int{
		"":                                  0,
		"select 1":                          1,
		"select 1; select 2;":               2,
		"select 1;;  ; -- only a comment\n": 1,
		"select 'a;b'; select \"a;b\"; select $tag$a;b$tag$; select E'a\\';b'; select 1 /* x; /* y; */ z */; select 2": 6,
		// $ inside an identifier does not start a dollar quote.
		"select 1 as x$y$; select 2":    2,
		"select 1 as a$$; select $$;$$": 2,
		// Dollar-quote tags may contain non-ASCII letters.
		"select $é$a;b$é$; select 2": 2,
		"select $1; select $2":       2,
		// Backslashes only escape in E'' strings, and only after a standalone E.
		"select 'a\\'; select 2":      2,
		"select pe'\\'; select 2":     2,
		"select e'it\\'s;'; select 2": 2,
		// Quoted identifiers with doubled quotes and semicolons.
		"select \"a;\"\"b\" from t; select 2": 2,
		// Comments: line comments end at a newline, block comments nest.
		"select 1 -- c;\n; select 2":                      2,
		"/* a; /* b; */ c; */ select 1; select 2 /* ; */": 2,
		// psql meta commands are sent to the server as part of the next statement.
		"\\set x 1\nselect 1; select 2": 2,
	}
	for script, want := range cases {
		if got := len(splitStatements(script)); got != want {
			t.Errorf("%q: got %d statements, want %d", script, got, want)
		}
	}
	spans := splitStatements("-- lead\nselect 'é';\n  select 2")
	if len(spans) != 2 || spans[0] != (statementSpan{8, 19}) || spans[1] != (statementSpan{22, 30}) {
		t.Fatalf("unexpected spans: %#v", spans)
	}
	if statementAt(spans, 0) != 1 || statementAt(spans, 19) != 2 || statementAt(spans, 99) != 2 {
		t.Fatal("offsets map to the wrong statements")
	}
}

func TestRolledBackFrom(t *testing.T) {
	cases := []struct {
		commands []string
		failed   int
		want     int
	}{
		{nil, 1, 0},
		{[]string{"SELECT 1"}, 2, 1},
		{[]string{"INSERT 0 1", "COMMIT", "INSERT 0 1"}, 4, 3},
		{[]string{"INSERT 0 1", "COMMIT"}, 3, 0},
		{[]string{"INSERT 0 1", "BEGIN", "INSERT 0 1"}, 4, 1},
		// A syntax error stops the script before anything runs.
		{nil, 3, 0},
		{[]string{"BEGIN", "INSERT 0 1", "SAVEPOINT", "ROLLBACK TO SAVEPOINT", "INSERT 0 1"}, 6, 1},
	}
	for _, c := range cases {
		if got := rolledBackFrom(c.commands, c.failed); got != c.want {
			t.Errorf("%v failing at %d: got %d, want %d", c.commands, c.failed, got, c.want)
		}
	}
}

func TestStatementAtMultibyte(t *testing.T) {
	script := "/* ü */ SELECT '😀;';\n-- é\nSELECT bad"
	spans := splitStatements(script)
	if len(spans) != 2 {
		t.Fatalf("spans = %#v", spans)
	}
	// PostgreSQL's 1-based character position of "bad".
	position := len([]rune(script[:strings.Index(script, "bad")])) + 1
	if got := statementAt(spans, position-1); got != 2 {
		t.Fatalf("position %d maps to statement %d", position, got)
	}
	// Positions inside the comment before a statement belong to that statement.
	if got := statementAt(spans, len([]rune("/* ü */ SELECT '😀;';\n-- "))); got != 2 {
		t.Fatalf("comment maps to statement %d", got)
	}
	if !isRollbackToSavepoint("rollback work to sp") || !isRollbackToSavepoint("ROLLBACK TO SAVEPOINT a") || isRollbackToSavepoint("ROLLBACK") || isRollbackToSavepoint("ROLLBACK PREPARED 'x'") {
		t.Fatal("ROLLBACK TO SAVEPOINT not recognised")
	}
}

func TestFormatPgError(t *testing.T) {
	got := formatPgError(&pgconn.PgError{Severity: "ERROR", Message: "column \"nme\" does not exist", Position: 18, Hint: "Perhaps you meant \"name\".", Detail: "More detail."}, "SELECT 1;\nSELECT nme FROM users")
	want := "ERROR: column \"nme\" does not exist\nLINE 2: SELECT nme FROM users\n               ^\nDETAIL: More detail.\nHINT: Perhaps you meant \"name\"."
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	long := strings.Repeat("x", 200) + " bad"
	lines := errorLocation(long, 201)
	if !strings.HasPrefix(lines[0], "LINE 1: ...") || len([]rune(lines[1]))-1 != strings.Index(lines[0], "bad") {
		t.Fatalf("long lines are not windowed around the caret: %q", lines)
	}
}

func TestCancelUnknownScript(t *testing.T) {
	s := &PostgresService{}
	if s.CancelSQLScript("") || s.CancelSQLScript("missing") {
		t.Fatal("unknown scripts must not report cancellation")
	}
	cancelled := false
	run, err := s.scripts.start("id", func() { cancelled = true })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.scripts.start("id", func() {}); err == nil {
		t.Fatal("duplicate execution IDs must be rejected")
	}
	if !s.CancelSQLScript("id") || !cancelled {
		t.Fatal("a script without a connection must be cancelled through its context")
	}
	if !s.scripts.finish("id", run) || s.CancelSQLScript("id") {
		t.Fatal("finished scripts must report cancellation once and then be forgotten")
	}
	// Finishing twice is harmless, and the ID can be used again.
	s.scripts.finish("id", run)
	again, err := s.scripts.start("id", func() {})
	if err != nil {
		t.Fatal(err)
	}
	if s.scripts.finish("id", again) || len(s.scripts.runs) != 0 {
		t.Fatal("a reused execution ID was not tracked separately")
	}
}

// TestCancelRetriesWhileIdle covers a cancel request that reaches the server
// before the backend starts the query: PostgreSQL ignores it, so the registry
// must keep asking instead of waiting for the grace period to close the session.
func TestCancelRetriesWhileIdle(t *testing.T) {
	url := os.Getenv("HYPERPG_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set HYPERPG_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	conn, err := pgconn.Connect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var registry scriptRegistry
	runCtx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	run, err := registry.start("idle", cancelRun)
	if err != nil {
		t.Fatal(err)
	}
	registry.attach(run, conn)
	if !registry.cancel("idle") {
		t.Fatal("cancel did not find the run")
	}
	// Let the first cancel request reach the idle backend.
	time.Sleep(100 * time.Millisecond)
	started := time.Now()
	_, err = conn.Exec(context.Background(), "SELECT pg_sleep(10)").ReadAll()
	elapsed := time.Since(started)
	registry.finish("idle", run)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" || elapsed >= cancelGracePeriod {
		t.Fatalf("query was not cancelled by a repeated request: err=%v after %v", err, elapsed)
	}
	if runCtx.Err() != nil {
		t.Fatal("a honoured cancel request must not close the session")
	}
}
