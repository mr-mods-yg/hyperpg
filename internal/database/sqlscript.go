package database

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

const (
	scriptResultRowLimit = 500
	scriptTimeout        = 5 * time.Minute
	// cancelGracePeriod is how long PostgreSQL gets to honour a cancel request
	// before the connection is closed to stop the script.
	cancelGracePeriod = 3 * time.Second
	cancelledMessage  = "Query cancelled"
	// cancelRetryInterval is how often a cancel request is repeated while the
	// script keeps running.
	cancelRetryInterval = 250 * time.Millisecond
)

type ScriptResult struct {
	Columns   []string    `json:"columns"`
	Rows      [][]*string `json:"rows"`
	Command   string      `json:"command"`
	Truncated bool        `json:"truncated"`
	// DurationMs is the time between the previous statement finishing and this one finishing.
	DurationMs float64 `json:"durationMs"`
}

type ScriptExecution struct {
	Results    []ScriptResult `json:"results"`
	Error      string         `json:"error"`
	RolledBack bool           `json:"rolledBack"`
	// Cancelled is true when CancelSQLScript stopped the script.
	Cancelled bool `json:"cancelled"`
	// StatementCount is the number of statements in the script.
	StatementCount int `json:"statementCount"`
	// FailedStatement is the 1-based statement that failed or was cancelled, or 0.
	FailedStatement int `json:"failedStatement"`
	// ErrorPosition is PostgreSQL's 1-based character offset of the error in the script, or 0.
	ErrorPosition int `json:"errorPosition"`
	// RolledBackFrom is the first statement before FailedStatement whose changes
	// were undone because the failure aborted its transaction, or 0.
	RolledBackFrom int `json:"rolledBackFrom"`
}

type scriptRun struct {
	cancel    context.CancelFunc
	wire      *pgconn.PgConn
	cancelled bool
	// done is closed by finish, which stops cancel requests for the run.
	done chan struct{}
}

// scriptRegistry tracks running scripts by execution ID so they can be cancelled.
// The zero value is ready to use.
type scriptRegistry struct {
	mu   sync.Mutex
	runs map[string]*scriptRun
}

func (r *scriptRegistry) start(id string, cancel context.CancelFunc) (*scriptRun, error) {
	run := &scriptRun{cancel: cancel, done: make(chan struct{})}
	if id == "" {
		return run, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.runs == nil {
		r.runs = make(map[string]*scriptRun)
	}
	if _, exists := r.runs[id]; exists {
		return nil, fmt.Errorf("A script with this execution ID is already running")
	}
	r.runs[id] = run
	return run, nil
}

func (r *scriptRegistry) attach(run *scriptRun, wire *pgconn.PgConn) {
	r.mu.Lock()
	run.wire = wire
	r.mu.Unlock()
}

// finish stops tracking the run, so later cancel requests cannot reach a
// connection that has moved on to other work, and reports whether it was cancelled.
func (r *scriptRegistry) finish(id string, run *scriptRun) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if id != "" && r.runs[id] == run {
		delete(r.runs, id)
	}
	run.wire = nil
	select {
	case <-run.done:
	default:
		close(run.done)
	}
	return run.cancelled
}

func (r *scriptRegistry) cancel(id string) bool {
	r.mu.Lock()
	run := r.runs[id]
	if run == nil {
		r.mu.Unlock()
		return false
	}
	alreadyCancelled := run.cancelled
	run.cancelled = true
	connected := run.wire != nil
	r.mu.Unlock()
	if !alreadyCancelled && !connected {
		// Not connected yet: the cancelled context stops the run before it
		// sends anything to the server.
		run.cancel()
	} else if !alreadyCancelled {
		// The network round trips happen outside the lock so that a slow or
		// unreachable server cannot stall other scripts. This is safe because a
		// cancelled run's connection is never returned to the pool.
		go r.interrupt(run)
	}
	return true
}

// interrupt asks PostgreSQL to stop the run's statement, which keeps the session
// usable and lets PostgreSQL abort the transaction itself. PostgreSQL ignores a
// cancel request that arrives while the backend is still waiting to read the
// query, so requests are repeated until the run finishes; after the grace period
// the run's context is cancelled, which closes the connection.
func (r *scriptRegistry) interrupt(run *scriptRun) {
	grace, stop := context.WithTimeout(context.Background(), cancelGracePeriod)
	defer stop()
	for {
		r.mu.Lock()
		wire := run.wire
		r.mu.Unlock()
		select {
		case <-run.done:
			return
		default:
		}
		if wire == nil {
			// Not connected yet: the cancelled context stops the run before it
			// sends anything to the server.
			run.cancel()
			return
		}
		if err := wire.CancelRequest(grace); err != nil {
			run.cancel()
			return
		}
		select {
		case <-run.done:
			return
		case <-grace.Done():
			run.cancel()
			return
		case <-time.After(cancelRetryInterval):
		}
	}
}

// CancelSQLScript stops the script started with the same execution ID.
// It reports whether that script was still running.
func (s *PostgresService) CancelSQLScript(executionID string) bool {
	if executionID == "" {
		return false
	}
	return s.scripts.cancel(executionID)
}

// ExecuteSQLScript executes the script using PostgreSQL's simple query protocol,
// preserving statement boundaries and PostgreSQL's own transaction semantics.
// A non-empty executionID lets CancelSQLScript stop the script while it runs.
func (s *PostgresService) ExecuteSQLScript(connectionID, script, executionID string) (ScriptExecution, error) {
	if strings.TrimSpace(script) == "" {
		return ScriptExecution{}, fmt.Errorf("Enter a SQL script")
	}
	db, err := s.connection(connectionID)
	if err != nil {
		return ScriptExecution{}, err
	}
	runCtx, cancelRun := context.WithTimeout(context.Background(), scriptTimeout)
	defer cancelRun()
	run, err := s.scripts.start(executionID, cancelRun)
	if err != nil {
		return ScriptExecution{}, err
	}
	finished := false
	finish := func() bool {
		finished = true
		return s.scripts.finish(executionID, run)
	}
	defer func() {
		if !finished {
			finish()
		}
	}()

	spans := splitStatements(script)
	output := ScriptExecution{Results: []ScriptResult{}, StatementCount: len(spans)}
	conn, err := db.Conn(runCtx)
	if err != nil {
		if finish() {
			output.Cancelled, output.Error = true, cancelledMessage
			return output, nil
		}
		return ScriptExecution{}, fmt.Errorf("Could not open a database connection: %w", err)
	}
	defer conn.Close()
	cancelled := false
	err = conn.Raw(func(raw any) error {
		pg, ok := raw.(*stdlib.Conn)
		if !ok {
			return fmt.Errorf("Unexpected database driver")
		}
		wire := pg.Conn().PgConn()
		s.scripts.attach(run, wire)
		var commands []string
		reader := wire.Exec(runCtx, script)
		started := time.Now()
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
			if resultErr == nil {
				result.Command = tag.String()
				result.DurationMs = math.Round(float64(time.Since(started).Microseconds())/100) / 10
				started = time.Now()
				output.Results = append(output.Results, result)
				command := strings.ToUpper(tag.String())
				// ROLLBACK TO SAVEPOINT reports the same tag as ROLLBACK but keeps
				// the transaction open.
				if command == "ROLLBACK" && len(commands) < len(spans) && isRollbackToSavepoint(statementText(script, spans[len(commands)])) {
					command = "ROLLBACK TO SAVEPOINT"
				}
				commands = append(commands, command)
			}
		}
		execErr := reader.Close()
		cancelled = finish()
		if execErr != nil {
			describeScriptError(&output, execErr, script, spans, commands, cancelled)
			if !cancelled && errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				output.Error = fmt.Sprintf("Query timed out after %d minutes", int(scriptTimeout.Minutes()))
			}
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
		// A late cancel request could still reach this session, so a cancelled
		// connection is never reused.
		if wire.IsClosed() || cancelled {
			return driver.ErrBadConn
		}
		return nil
	})
	if err != nil {
		if cancelled {
			// Closing the session also makes PostgreSQL roll back its transaction.
			if output.FailedStatement == 0 {
				describeScriptError(&output, context.Canceled, script, spans, nil, true)
			}
			return output, nil
		}
		if output.Error != "" {
			// The script failed and took its session with it (a timeout, a
			// terminated backend, a lost network): report the script's own error
			// rather than the generic "bad connection" that discarded the session.
			return output, nil
		}
		return output, fmt.Errorf("Could not execute script: %w", err)
	}
	return output, nil
}

// describeScriptError records which statement failed, where, and what the
// failure undid, formatting PostgreSQL errors like psql does.
func describeScriptError(output *ScriptExecution, err error, script string, spans []statementSpan, commands []string, cancelled bool) {
	var pgErr *pgconn.PgError
	isPgErr := errors.As(err, &pgErr)
	completed := len(output.Results)
	output.FailedStatement = completed + 1
	if isPgErr && pgErr.Position > 0 {
		output.ErrorPosition = int(pgErr.Position)
		// A position also identifies parse errors, which stop the whole script before it runs.
		output.FailedStatement = statementAt(spans, output.ErrorPosition-1)
	}
	if output.FailedStatement < 1 {
		output.FailedStatement = 1
	}
	if output.StatementCount < output.FailedStatement {
		output.StatementCount = output.FailedStatement
	}
	output.RolledBackFrom = rolledBackFrom(commands, output.FailedStatement)
	if cancelled {
		output.Cancelled = true
		output.Error = cancelledMessage
		return
	}
	if !isPgErr {
		output.Error = err.Error()
		return
	}
	output.Error = formatPgError(pgErr, script)
}

// rolledBackFrom finds the first completed statement whose transaction the
// failure aborted. Multi-statement simple queries run in one implicit
// transaction unless the script itself issues transaction commands.
func rolledBackFrom(commands []string, failed int) int {
	// BEGIN turns the implicit block into an explicit one without ending it, so
	// only commands that end a transaction move the start of the undone range.
	from := 1
	for index, command := range commands {
		statement := index + 1
		if statement >= failed {
			break
		}
		switch command {
		case "COMMIT", "ROLLBACK", "PREPARE TRANSACTION":
			from = statement + 1
		}
	}
	// Statements after the last completed one never ran: PostgreSQL parses the
	// whole script first, so a syntax error stops everything.
	if from >= failed || from > len(commands) {
		return 0
	}
	return from
}

var rollbackToSavepoint = regexp.MustCompile(`(?i)^ROLLBACK(\s+(WORK|TRANSACTION))?\s+TO\b`)

func isRollbackToSavepoint(statement string) bool {
	return rollbackToSavepoint.MatchString(statement)
}

func statementText(script string, span statementSpan) string {
	src := []rune(script)
	if span.start < 0 || span.end > len(src) || span.start > span.end {
		return ""
	}
	return string(src[span.start:span.end])
}

func formatPgError(pgErr *pgconn.PgError, script string) string {
	severity := pgErr.SeverityUnlocalized
	if severity == "" {
		severity = pgErr.Severity
	}
	if severity == "" {
		severity = "ERROR"
	}
	lines := []string{fmt.Sprintf("%s: %s", severity, pgErr.Message)}
	if pgErr.Position > 0 {
		lines = append(lines, errorLocation(script, int(pgErr.Position)-1)...)
	}
	if pgErr.Detail != "" {
		lines = append(lines, "DETAIL: "+pgErr.Detail)
	}
	if pgErr.Hint != "" {
		lines = append(lines, "HINT: "+pgErr.Hint)
	}
	if pgErr.Where != "" {
		lines = append(lines, "CONTEXT: "+pgErr.Where)
	}
	return strings.Join(lines, "\n")
}

// errorLocation renders psql's "LINE n:" excerpt with a caret under the error.
func errorLocation(script string, offset int) []string {
	src := []rune(script)
	if offset < 0 {
		offset = 0
	}
	if offset > len(src) {
		offset = len(src)
	}
	lineStart, line := 0, 1
	for i := 0; i < offset; i++ {
		if src[i] == '\n' {
			lineStart, line = i+1, line+1
		}
	}
	lineEnd := lineStart
	for lineEnd < len(src) && src[lineEnd] != '\n' && src[lineEnd] != '\r' {
		lineEnd++
	}
	text := []rune(strings.ReplaceAll(string(src[lineStart:lineEnd]), "\t", " "))
	column := offset - lineStart
	const window = 72
	prefix, suffix := "", ""
	if len(text) > window {
		start := max(0, min(column-window/2, len(text)-window))
		end := min(len(text), start+window)
		if start > 0 {
			prefix = "..."
		}
		if end < len(text) {
			suffix = "..."
		}
		column -= start
		text = text[start:end]
	}
	label := fmt.Sprintf("LINE %d: %s", line, prefix)
	return []string{label + string(text) + suffix, strings.Repeat(" ", len([]rune(label))+column) + "^"}
}
