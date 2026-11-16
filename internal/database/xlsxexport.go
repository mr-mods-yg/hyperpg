package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/xuri/excelize/v2"
)

const (
	// excelMaxDataRows is Excel's row limit (1,048,576) minus the header row.
	excelMaxDataRows = 1_048_575
	// excelWidthSampleRows is how many rows are buffered to size the columns.
	excelWidthSampleRows = 200
	excelMinColumnWidth  = 6
	excelMaxColumnWidth  = 60
	excelSummarySheet    = "Summary"
	// excelProgressEvery is how often (in rows) the progress counters move.
	excelProgressEvery = 500
)

// ExcelExportTable is a relation that can be exported as a worksheet.
type ExcelExportTable struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	// Kind is "table", "view" or "materialized view".
	Kind string `json:"kind"`
	// EstimatedRows is PostgreSQL's planner estimate, or -1 when unknown.
	EstimatedRows int64 `json:"estimatedRows"`
	// Readable is false when the current role cannot SELECT from the relation.
	Readable bool `json:"readable"`
}

type ExcelExportOptions struct {
	// ExportID lets the frontend poll GetExcelExportProgress and call CancelExcelExport.
	ExportID string `json:"exportId"`
	// Tables lists the relations to export. Empty exports every base table
	// (and every view when IncludeViews is set).
	Tables       []TableInfo `json:"tables"`
	IncludeViews bool        `json:"includeViews"`
}

type ExcelSheetResult struct {
	Sheet  string `json:"sheet"`
	Schema string `json:"schema"`
	Table  string `json:"table"`
	Kind   string `json:"kind"`
	Rows   int64  `json:"rows"`
	// RowsTruncated is true when the relation had more rows than fit in a sheet.
	RowsTruncated bool `json:"rowsTruncated"`
	// TruncatedCells counts values cut to Excel's 32,767-character cell limit.
	TruncatedCells int64 `json:"truncatedCells"`
}

type ExcelExportResult struct {
	// Path is empty when the user dismissed the save dialog.
	Path      string             `json:"path"`
	Sheets    []ExcelSheetResult `json:"sheets"`
	TotalRows int64              `json:"totalRows"`
	Warnings  []string           `json:"warnings"`
	Cancelled bool               `json:"cancelled"`
}

type ExcelExportProgress struct {
	// Active is false before the export starts and after it finishes.
	Active bool `json:"active"`
	// Phase is "preparing", "exporting" or "saving".
	Phase      string `json:"phase"`
	TableIndex int    `json:"tableIndex"`
	TableCount int    `json:"tableCount"`
	Schema     string `json:"schema"`
	Table      string `json:"table"`
	TableRows  int64  `json:"tableRows"`
	TotalRows  int64  `json:"totalRows"`
}

type excelExportRun struct {
	mu        sync.Mutex
	cancel    context.CancelFunc
	cancelled bool
	progress  ExcelExportProgress
}

func (r *excelExportRun) update(change func(*ExcelExportProgress)) {
	if r == nil {
		return
	}
	r.mu.Lock()
	change(&r.progress)
	r.mu.Unlock()
}

// excelExportRegistry tracks running exports by ID. The zero value is ready to use.
type excelExportRegistry struct {
	mu   sync.Mutex
	runs map[string]*excelExportRun
}

func (r *excelExportRegistry) start(id string, cancel context.CancelFunc) (*excelExportRun, error) {
	run := &excelExportRun{cancel: cancel, progress: ExcelExportProgress{Active: true, Phase: "preparing"}}
	if id == "" {
		return run, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.runs == nil {
		r.runs = make(map[string]*excelExportRun)
	}
	if _, exists := r.runs[id]; exists {
		return nil, fmt.Errorf("An export with this ID is already running")
	}
	r.runs[id] = run
	return run, nil
}

func (r *excelExportRegistry) finish(id string, run *excelExportRun) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if id != "" && r.runs[id] == run {
		delete(r.runs, id)
	}
}

func (r *excelExportRegistry) get(id string) *excelExportRun {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runs[id]
}

func (r *excelExportRegistry) cancel(id string) bool {
	run := r.get(id)
	if run == nil {
		return false
	}
	run.mu.Lock()
	run.cancelled = true
	run.mu.Unlock()
	run.cancel()
	return true
}

// ListExcelExportTables lists the tables and views that can be exported from a database.
func (s *PostgresService) ListExcelExportTables(connectionID, database string) ([]ExcelExportTable, error) {
	db, err := s.excelExportDatabase(connectionID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	return listExcelExportTables(ctx, db, true)
}

// GetExcelExportProgress reports the progress of a running export.
func (s *PostgresService) GetExcelExportProgress(exportID string) ExcelExportProgress {
	run := s.excelExports.get(exportID)
	if run == nil {
		return ExcelExportProgress{}
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	return run.progress
}

// CancelExcelExport stops a running export; its partial file is deleted.
func (s *PostgresService) CancelExcelExport(exportID string) bool {
	return s.excelExports.cancel(exportID)
}

// ExportDatabaseToExcel asks for a destination and writes one worksheet per
// table. All sheets are read from one read-only, repeatable-read transaction.
func (s *PostgresService) ExportDatabaseToExcel(connectionID, database string, options ExcelExportOptions) (ExcelExportResult, error) {
	db, err := s.excelExportDatabase(connectionID, database)
	if err != nil {
		return ExcelExportResult{}, err
	}
	path, err := application.Get().Dialog.SaveFile().
		SetMessage("Export database to Excel").
		SetFilename(excelFileName(database)).
		AddFilter("Excel workbook", "*.xlsx").
		PromptForSingleSelection()
	if err != nil {
		return ExcelExportResult{}, fmt.Errorf("Could not open the save dialog: %w", err)
	}
	if path == "" {
		return ExcelExportResult{}, nil
	}
	if path, err = excelDestinationPath(path); err != nil {
		return ExcelExportResult{}, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run, err := s.excelExports.start(options.ExportID, cancel)
	if err != nil {
		return ExcelExportResult{}, err
	}
	defer s.excelExports.finish(options.ExportID, run)
	return exportDatabaseToExcel(ctx, db, database, path, options, run)
}

func (s *PostgresService) excelExportDatabase(connectionID, database string) (*sql.DB, error) {
	if strings.TrimSpace(database) == "" {
		return nil, fmt.Errorf("Choose a database to export")
	}
	handle, err := s.OpenDatabase(connectionID, database)
	if err != nil {
		return nil, err
	}
	return s.connection(handle)
}

// excelDestinationPath adds the .xlsx extension when the save dialog returned
// a name without one. The Windows dialog adds it itself (from the filter) and
// confirms overwrites; the GTK and macOS dialogs return the name as typed and
// only confirmed an overwrite of that exact path. A file already at the
// extended path was never confirmed, so it is refused rather than replaced.
func excelDestinationPath(path string) (string, error) {
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		return path, nil
	}
	extended := path + ".xlsx"
	if _, err := os.Lstat(extended); err == nil {
		return "", fmt.Errorf("%s already exists. Export again and choose that file to replace it, or enter a different name", filepath.Base(extended))
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("Could not check %s: %s. Choose a different name or folder", filepath.Base(extended), excelFileError(err))
	}
	return extended, nil
}

func excelFileName(database string) string {
	name := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) || r < 32 {
			return '_'
		}
		return r
	}, strings.TrimSpace(database))
	if name == "" {
		name = "database"
	}
	return name + ".xlsx"
}

type excelQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func listExcelExportTables(ctx context.Context, db excelQuerier, includeViews bool) ([]ExcelExportTable, error) {
	kinds := `('r', 'p')`
	if includeViews {
		kinds = `('r', 'p', 'v', 'm')`
	}
	// Partitions are left out: their rows are exported with the partitioned table.
	rows, err := db.QueryContext(ctx, `
		SELECT n.nspname, c.relname,
		       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END,
		       CASE WHEN c.reltuples < 0 THEN -1 ELSE c.reltuples::bigint END,
		       has_table_privilege(c.oid, 'SELECT')
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN `+kinds+`
		  AND NOT c.relispartition
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
		  AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
		ORDER BY n.nspname, c.relname`)
	if err != nil {
		return nil, fmt.Errorf("Could not list tables: %s", excelDatabaseError(err))
	}
	defer rows.Close()
	tables := make([]ExcelExportTable, 0)
	for rows.Next() {
		var table ExcelExportTable
		if err := rows.Scan(&table.Schema, &table.Name, &table.Kind, &table.EstimatedRows, &table.Readable); err != nil {
			return nil, fmt.Errorf("Could not read the table list: %s", excelDatabaseError(err))
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("Could not read the table list: %s", excelDatabaseError(err))
	}
	return tables, nil
}

// exportDatabaseToExcel writes the workbook to path. A cancelled or failed
// export leaves no file behind and never replaces an existing file.
func exportDatabaseToExcel(ctx context.Context, db *sql.DB, database, path string, options ExcelExportOptions, run *excelExportRun) (result ExcelExportResult, err error) {
	result = ExcelExportResult{Sheets: []ExcelSheetResult{}, Warnings: []string{}}
	cancelled := func() bool {
		if run != nil {
			run.mu.Lock()
			defer run.mu.Unlock()
			if run.cancelled {
				return true
			}
		}
		return errors.Is(ctx.Err(), context.Canceled)
	}
	defer func() {
		if err != nil && cancelled() {
			result, err = ExcelExportResult{Cancelled: true, Sheets: []ExcelSheetResult{}, Warnings: []string{}}, nil
		}
	}()

	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return result, fmt.Errorf("Could not start a read-only transaction: %s", excelDatabaseError(err))
	}
	defer tx.Rollback()
	// Fixed output formats make text values predictable to parse. Excel has no
	// time zones, so timestamptz values are written in UTC.
	for _, setting := range []string{
		"SET LOCAL DateStyle = 'ISO, YMD'",
		"SET LOCAL TimeZone = 'UTC'",
		"SET LOCAL IntervalStyle = 'postgres'",
		"SET LOCAL extra_float_digits = 3",
	} {
		if _, err = tx.ExecContext(ctx, setting); err != nil {
			return result, fmt.Errorf("Could not prepare the export: %s", excelDatabaseError(err))
		}
	}

	available, err := listExcelExportTables(ctx, tx, true)
	if err != nil {
		return result, err
	}
	tables, warnings := selectExcelTables(available, options)
	result.Warnings = append(result.Warnings, warnings...)
	if len(tables) == 0 {
		if len(options.Tables) > 0 {
			return result, fmt.Errorf("None of the selected tables can be exported. Refresh the table list and try again")
		}
		return result, fmt.Errorf("Database %s has no tables to export", database)
	}

	sheetNames := assignSheetNames(tables, excelSummarySheet)
	file := excelize.NewFile()
	defer file.Close()
	if err = file.SetSheetName("Sheet1", excelSummarySheet); err != nil {
		return result, err
	}
	styles, err := newExcelStyles(file)
	if err != nil {
		return result, err
	}

	run.update(func(p *ExcelExportProgress) { p.Phase = "exporting"; p.TableCount = len(tables) })
	notes := map[string]string{}
	for index, table := range tables {
		if err = ctx.Err(); err != nil {
			return result, err
		}
		base := result.TotalRows
		run.update(func(p *ExcelExportProgress) {
			p.TableIndex, p.Schema, p.Table, p.TableRows, p.TotalRows = index+1, table.Schema, table.Name, 0, base
		})
		sheet, written, readErr, sheetErr := exportExcelTable(ctx, tx, file, styles, sheetNames[index], table, run, base)
		if sheetErr != nil {
			return result, sheetErr
		}
		if readErr != nil && !written {
			// A relation that cannot be read (a broken view, an unpopulated
			// materialized view, a missing privilege on a view's base table)
			// is skipped instead of failing the whole export.
			result.Warnings = append(result.Warnings, fmt.Sprintf("Skipped %s.%s: %s", table.Schema, table.Name, excelDatabaseError(readErr)))
			run.update(func(p *ExcelExportProgress) { p.TableRows, p.TotalRows = 0, base })
			continue
		}
		if readErr != nil {
			note := fmt.Sprintf("Incomplete: reading stopped after %s %s: %s", formatCount(sheet.Rows), plural(sheet.Rows, "row", "rows"), excelDatabaseError(readErr))
			notes[sheet.Sheet] = note
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s.%s: %s", table.Schema, table.Name, note))
		}
		result.Sheets = append(result.Sheets, sheet)
		result.TotalRows += sheet.Rows
		if sheet.RowsTruncated {
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s.%s has more than %s rows; only the first %s were exported.", table.Schema, table.Name, formatCount(excelMaxDataRows), formatCount(excelMaxDataRows)))
		}
		if sheet.TruncatedCells > 0 {
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s.%s: %s %s longer than 32,767 characters %s shortened.", table.Schema, table.Name, formatCount(sheet.TruncatedCells), plural(sheet.TruncatedCells, "value", "values"), plural(sheet.TruncatedCells, "was", "were")))
		}
	}
	if err = writeExcelSummary(file, styles, database, result, notes); err != nil {
		return result, fmt.Errorf("Could not write the summary sheet: %w", err)
	}
	file.SetActiveSheet(0)
	_ = tx.Rollback()

	run.update(func(p *ExcelExportProgress) { p.Phase = "saving" })
	if err = saveExcelFile(ctx, file, path); err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return result, err
	}
	result.Path = path
	return result, nil
}

func selectExcelTables(available []ExcelExportTable, options ExcelExportOptions) ([]ExcelExportTable, []string) {
	warnings := []string{}
	selected := make([]ExcelExportTable, 0)
	if len(options.Tables) == 0 {
		for _, table := range available {
			if (table.Kind == "table" || options.IncludeViews) && table.Readable {
				selected = append(selected, table)
			}
		}
		return selected, warnings
	}
	wanted := make(map[TableInfo]bool, len(options.Tables))
	for _, table := range options.Tables {
		wanted[table] = true
	}
	for _, table := range available {
		key := TableInfo{Schema: table.Schema, Name: table.Name}
		if !wanted[key] {
			continue
		}
		delete(wanted, key)
		if !table.Readable {
			warnings = append(warnings, fmt.Sprintf("Skipped %s.%s: you do not have permission to read it.", table.Schema, table.Name))
			continue
		}
		selected = append(selected, table)
	}
	// Report missing tables in the order they were requested.
	for _, table := range options.Tables {
		if wanted[table] {
			delete(wanted, table)
			warnings = append(warnings, fmt.Sprintf("Skipped %s.%s: it no longer exists.", table.Schema, table.Name))
		}
	}
	return selected, warnings
}

type excelStyles struct {
	header, integer, date, timestamp, bold, title int
}

func newExcelStyles(file *excelize.File) (excelStyles, error) {
	var styles excelStyles
	var err error
	formats := []struct {
		target *int
		style  *excelize.Style
	}{
		{&styles.header, &excelize.Style{
			Font:   &excelize.Font{Bold: true},
			Fill:   excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"EEF1F4"}},
			Border: []excelize.Border{{Type: "bottom", Color: "A6ADB4", Style: 1}},
		}},
		{&styles.integer, &excelize.Style{NumFmt: 1}},
		{&styles.date, &excelize.Style{CustomNumFmt: stringPointer("yyyy-mm-dd")}},
		{&styles.timestamp, &excelize.Style{CustomNumFmt: stringPointer("yyyy-mm-dd hh:mm:ss")}},
		{&styles.bold, &excelize.Style{Font: &excelize.Font{Bold: true}}},
		{&styles.title, &excelize.Style{Font: &excelize.Font{Bold: true, Size: 14}}},
	}
	for _, format := range formats {
		if *format.target, err = file.NewStyle(format.style); err != nil {
			return styles, err
		}
	}
	return styles, nil
}

func stringPointer(value string) *string { return &value }

type excelColumn struct {
	name string
	kind excelValueKind
}

func readExcelColumns(ctx context.Context, tx *sql.Tx, table ExcelExportTable) ([]excelColumn, error) {
	// Domains are classified by their base type.
	rows, err := tx.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE a.atttypid END, NULL)
		FROM pg_attribute a
		JOIN pg_type t ON t.oid = a.atttypid
		WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, pgx.Identifier{table.Schema, table.Name}.Sanitize())
	if err != nil {
		return nil, excelDBError(fmt.Sprintf("Could not read the columns of %s.%s", table.Schema, table.Name), err)
	}
	defer rows.Close()
	columns := make([]excelColumn, 0)
	for rows.Next() {
		var name, typeName string
		if err := rows.Scan(&name, &typeName); err != nil {
			return nil, excelDBError(fmt.Sprintf("Could not read the columns of %s.%s", table.Schema, table.Name), err)
		}
		columns = append(columns, excelColumn{name: name, kind: excelKindForType(typeName)})
	}
	if err := rows.Err(); err != nil {
		return nil, excelDBError(fmt.Sprintf("Could not read the columns of %s.%s", table.Schema, table.Name), err)
	}
	return columns, nil
}

func excelPrimaryKey(ctx context.Context, tx *sql.Tx, table ExcelExportTable) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT a.attname
		FROM pg_index i
		CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		WHERE i.indrelid = to_regclass($1) AND i.indisprimary
		ORDER BY k.ord`, pgx.Identifier{table.Schema, table.Name}.Sanitize())
	if err != nil {
		return nil, excelDBError(fmt.Sprintf("Could not inspect %s.%s", table.Schema, table.Name), err)
	}
	defer rows.Close()
	order := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, excelDBError(fmt.Sprintf("Could not inspect %s.%s", table.Schema, table.Name), err)
		}
		order = append(order, pgx.Identifier{name}.Sanitize())
	}
	if err := rows.Err(); err != nil {
		return nil, excelDBError(fmt.Sprintf("Could not inspect %s.%s", table.Schema, table.Name), err)
	}
	return order, nil
}

const excelTableSavepoint = "hyperpg_export_table"

// exportExcelTable writes one table inside a savepoint, so that a PostgreSQL
// error while reading it does not abort the export's transaction. readErr is
// the PostgreSQL error that stopped the table; written reports whether its
// sheet was added (with the rows read before the error). err aborts the export.
func exportExcelTable(ctx context.Context, tx *sql.Tx, file *excelize.File, styles excelStyles, sheetName string, table ExcelExportTable, run *excelExportRun, base int64) (sheet ExcelSheetResult, written bool, readErr error, err error) {
	if _, err = tx.ExecContext(ctx, "SAVEPOINT "+excelTableSavepoint); err != nil {
		return sheet, false, nil, excelDBError(fmt.Sprintf("Could not read %s.%s", table.Schema, table.Name), err)
	}
	sheet, written, readErr = writeExcelTableSheet(ctx, tx, file, styles, sheetName, table, run, base)
	var pgErr *pgconn.PgError
	if readErr != nil && (ctx.Err() != nil || !errors.As(readErr, &pgErr)) {
		// Cancellation, a lost connection or a workbook error ends the export.
		if ctx.Err() != nil {
			return sheet, written, nil, ctx.Err()
		}
		return sheet, written, nil, readErr
	}
	statements := []string{"RELEASE SAVEPOINT " + excelTableSavepoint}
	if readErr != nil {
		statements = append([]string{"ROLLBACK TO SAVEPOINT " + excelTableSavepoint}, statements...)
	}
	for _, statement := range statements {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			break
		}
	}
	if err != nil {
		if readErr != nil {
			return sheet, written, nil, readErr
		}
		return sheet, written, nil, excelDBError(fmt.Sprintf("Could not read %s.%s", table.Schema, table.Name), err)
	}
	return sheet, written, readErr, nil
}

// excelReadError keeps the underlying error for errors.As while showing a
// message that never includes connection details.
type excelReadError struct {
	message string
	cause   error
}

func (e *excelReadError) Error() string { return e.message }
func (e *excelReadError) Unwrap() error { return e.cause }

func excelDBError(what string, err error) error {
	return &excelReadError{message: what + ": " + excelDatabaseError(err), cause: err}
}

// writeExcelTableSheet streams a table into a new sheet. The sheet is only
// added once the first rows were read, so a table that cannot be read leaves
// no sheet behind; written reports whether it was added. If reading fails
// after that, the sheet is finished with the rows read so far.
func writeExcelTableSheet(ctx context.Context, tx *sql.Tx, file *excelize.File, styles excelStyles, sheetName string, table ExcelExportTable, run *excelExportRun, base int64) (sheet ExcelSheetResult, written bool, err error) {
	sheet = ExcelSheetResult{Sheet: sheetName, Schema: table.Schema, Table: table.Name, Kind: table.Kind}
	columns, err := readExcelColumns(ctx, tx, table)
	if err != nil {
		return sheet, false, err
	}
	var writer *excelize.StreamWriter
	addSheet := func() error {
		if _, err := file.NewSheet(sheetName); err != nil {
			return fmt.Errorf("Could not add sheet %s: %w", sheetName, err)
		}
		written = true
		var streamErr error
		writer, streamErr = file.NewStreamWriter(sheetName)
		return streamErr
	}
	if len(columns) == 0 {
		if err := addSheet(); err != nil {
			return sheet, written, err
		}
		return sheet, written, writer.Flush()
	}

	order := []string{}
	if table.Kind == "table" {
		if order, err = excelPrimaryKey(ctx, tx, table); err != nil {
			return sheet, false, err
		}
	}
	selectColumns := make([]string, len(columns))
	for i, column := range columns {
		// Values longer than a cell holds are cut on the server, so a huge value
		// is never transferred or held in memory in full. One character more
		// than the limit still marks the value as truncated.
		selectColumns[i] = fmt.Sprintf("left(%s::text, %d)", pgx.Identifier{column.name}.Sanitize(), excelMaxCellChars+1)
	}
	query := "SELECT " + strings.Join(selectColumns, ", ") + " FROM " + pgx.Identifier{table.Schema, table.Name}.Sanitize()
	if len(order) > 0 {
		query += " ORDER BY " + strings.Join(order, ", ")
	}
	// One extra row reveals whether the sheet had to be truncated, without
	// reading the rest of a large table.
	query += fmt.Sprintf(" LIMIT %d", excelMaxDataRows+1)
	// pgx streams result rows from the connection, so only the width sample is
	// held in memory; excelize spills sheet data to a temporary file.
	readFailure := func(err error) error {
		return excelDBError(fmt.Sprintf("Could not read %s.%s", table.Schema, table.Name), err)
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return sheet, false, readFailure(err)
	}
	defer rows.Close()

	raw := make([]sql.NullString, len(columns))
	targets := make([]any, len(columns))
	for i := range raw {
		targets[i] = &raw[i]
	}
	sample := make([][]any, 0, excelWidthSampleRows)
	headerWritten := false
	writeHeader := func() error {
		headerWritten = true
		if err := addSheet(); err != nil {
			return err
		}
		widths := estimateExcelColumnWidths(columns, sample)
		for i, column := range columns {
			if style := styles.forKind(column.kind); style != 0 {
				if err := writer.SetColStyle(i+1, i+1, style); err != nil {
					return err
				}
			}
		}
		// The stream writer emits <col> elements in the order they were last
		// touched, newest first, and Excel requires them in ascending order. Every
		// column gets a width, so setting them last to first sorts the list.
		for i := len(columns) - 1; i >= 0; i-- {
			if err := writer.SetColWidth(i+1, i+1, widths[i]); err != nil {
				return err
			}
		}
		if err := writer.SetPanes(&excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); err != nil {
			return err
		}
		header := make([]any, len(columns))
		for i, column := range columns {
			header[i] = excelize.Cell{StyleID: styles.header, Value: column.name}
		}
		if err := writer.SetRow("A1", header); err != nil {
			return err
		}
		for i, values := range sample {
			if err := writeExcelRow(writer, i+2, values); err != nil {
				return err
			}
		}
		sample = nil
		return nil
	}

	var rowCount int64
	for rows.Next() {
		if rowCount == excelMaxDataRows {
			sheet.RowsTruncated = true
			break
		}
		if err := rows.Scan(targets...); err != nil {
			return sheet, written, readFailure(err)
		}
		values := make([]any, len(columns))
		for i, value := range raw {
			if !value.Valid {
				continue
			}
			converted, truncated := excelCellValue(columns[i].kind, value.String)
			if truncated {
				sheet.TruncatedCells++
			}
			values[i] = converted
		}
		rowCount++
		if !headerWritten && len(sample) < excelWidthSampleRows {
			sample = append(sample, values)
		} else {
			if !headerWritten {
				if err := writeHeader(); err != nil {
					return sheet, written, err
				}
			}
			if err := writeExcelRow(writer, int(rowCount)+1, values); err != nil {
				return sheet, written, err
			}
		}
		if rowCount%excelProgressEvery == 0 {
			count := rowCount
			run.update(func(p *ExcelExportProgress) { p.TableRows, p.TotalRows = count, base+count })
		}
	}
	var readErr error
	if err := rows.Err(); err != nil {
		readErr = readFailure(err)
	}
	if err := ctx.Err(); err != nil {
		return sheet, written, err
	}
	if readErr != nil {
		if !headerWritten {
			return sheet, false, readErr
		}
		// Keep the rows already streamed: the sample rows were written with
		// the header, so rowCount rows are in the sheet.
	} else if !headerWritten {
		if err := writeHeader(); err != nil {
			return sheet, written, err
		}
	}
	lastColumn, _ := excelize.ColumnNumberToName(len(columns))
	if err := file.AutoFilter(sheetName, fmt.Sprintf("A1:%s%d", lastColumn, max(rowCount+1, 2)), nil); err != nil {
		return sheet, written, err
	}
	if err := writer.Flush(); err != nil {
		return sheet, written, err
	}
	sheet.Rows = rowCount
	run.update(func(p *ExcelExportProgress) { p.TableRows, p.TotalRows = rowCount, base+rowCount })
	return sheet, written, readErr
}

func writeExcelRow(writer *excelize.StreamWriter, row int, values []any) error {
	cell, err := excelize.CoordinatesToCellName(1, row)
	if err != nil {
		return err
	}
	return writer.SetRow(cell, values)
}

func (styles excelStyles) forKind(kind excelValueKind) int {
	switch kind {
	case excelInteger:
		return styles.integer
	case excelDate:
		return styles.date
	case excelTimestamp, excelTimestampTZ:
		return styles.timestamp
	}
	return 0
}

func estimateExcelColumnWidths(columns []excelColumn, sample [][]any) []float64 {
	widths := make([]float64, len(columns))
	for i, column := range columns {
		// Bold header text and the filter button need a little extra room.
		width := float64(excelDisplayWidth(column.name)) + 4
		for _, row := range sample {
			var length int
			switch value := row[i].(type) {
			case nil:
				continue
			case string:
				for _, line := range strings.Split(value, "\n") {
					length = max(length, excelDisplayWidth(line))
				}
			case time.Time:
				length = 10
				if column.kind != excelDate {
					length = 19
				}
			case bool:
				length = 5
			default:
				length = len(fmt.Sprint(value))
			}
			width = max(width, float64(length)+2)
		}
		widths[i] = min(max(width, excelMinColumnWidth), excelMaxColumnWidth)
	}
	return widths
}

// excelDisplayWidth approximates column units: wide (CJK) characters take two.
func excelDisplayWidth(value string) int {
	width := 0
	for _, r := range value {
		if r >= 0x1100 && (r <= 0x115f || (r >= 0x2e80 && r <= 0xa4cf) || (r >= 0xac00 && r <= 0xd7a3) || (r >= 0xf900 && r <= 0xfaff) || (r >= 0xff00 && r <= 0xff60) || (r >= 0x1f300 && r <= 0x1faff)) {
			width += 2
		} else {
			width++
		}
		if width > excelMaxColumnWidth {
			break
		}
	}
	return width
}

func writeExcelSummary(file *excelize.File, styles excelStyles, database string, result ExcelExportResult, extraNotes map[string]string) error {
	const sheet = excelSummarySheet
	now := time.Now()
	exported := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute(), now.Second(), 0, time.UTC)
	cells := []struct {
		cell  string
		value any
		style int
	}{
		{"A1", "Database export", styles.title},
		{"A3", "Database", styles.bold}, {"B3", database, 0},
		{"A4", "Exported", styles.bold}, {"B4", exported, styles.timestamp},
		{"A5", "Sheets", styles.bold}, {"B5", len(result.Sheets), styles.integer},
		{"A6", "Rows", styles.bold}, {"B6", result.TotalRows, styles.integer},
		{"A7", "Notes", styles.bold}, {"B7", "All sheets come from one consistent snapshot. Timestamps with time zone are shown in UTC.", 0},
	}
	for _, item := range cells {
		if err := file.SetCellValue(sheet, item.cell, item.value); err != nil {
			return err
		}
		if item.style != 0 {
			if err := file.SetCellStyle(sheet, item.cell, item.cell, item.style); err != nil {
				return err
			}
		}
	}
	header := []any{"Sheet", "Schema", "Table", "Type", "Rows", "Notes"}
	if err := file.SetSheetRow(sheet, "A9", &header); err != nil {
		return err
	}
	if err := file.SetCellStyle(sheet, "A9", "F9", styles.header); err != nil {
		return err
	}
	row := 10
	for _, item := range result.Sheets {
		notes := []string{}
		if note := extraNotes[item.Sheet]; note != "" {
			notes = append(notes, note)
		}
		if item.RowsTruncated {
			notes = append(notes, fmt.Sprintf("Only the first %s rows fit in a sheet", formatCount(excelMaxDataRows)))
		}
		if item.TruncatedCells > 0 {
			notes = append(notes, fmt.Sprintf("%s long %s shortened to 32,767 characters", formatCount(item.TruncatedCells), plural(item.TruncatedCells, "value", "values")))
		}
		values := []any{item.Sheet, item.Schema, item.Table, item.Kind, item.Rows, strings.Join(notes, "; ")}
		cell := fmt.Sprintf("A%d", row)
		if err := file.SetSheetRow(sheet, cell, &values); err != nil {
			return err
		}
		location := "'" + strings.ReplaceAll(item.Sheet, "'", "''") + "'!A1"
		if err := file.SetCellHyperLink(sheet, cell, location, "Location"); err != nil {
			return err
		}
		if err := file.SetCellStyle(sheet, fmt.Sprintf("E%d", row), fmt.Sprintf("E%d", row), styles.integer); err != nil {
			return err
		}
		row++
	}
	if len(result.Warnings) > 0 {
		row++
		if err := file.SetCellValue(sheet, fmt.Sprintf("A%d", row), "Warnings"); err != nil {
			return err
		}
		if err := file.SetCellStyle(sheet, fmt.Sprintf("A%d", row), fmt.Sprintf("A%d", row), styles.bold); err != nil {
			return err
		}
		for _, warning := range result.Warnings {
			row++
			if err := file.SetCellValue(sheet, fmt.Sprintf("A%d", row), warning); err != nil {
				return err
			}
		}
	}
	for column, width := range map[string]float64{"A": 24, "B": 20, "C": 28, "D": 18, "E": 12, "F": 48} {
		if err := file.SetColWidth(sheet, column, column, width); err != nil {
			return err
		}
	}
	return nil
}

// saveExcelFile writes the workbook beside its destination and renames it into
// place, so a failure or cancellation never leaves a partial file.
func saveExcelFile(ctx context.Context, file *excelize.File, path string) (err error) {
	if info, statErr := os.Lstat(path); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		if resolved, resolveErr := filepath.EvalSymlinks(path); resolveErr == nil {
			path = resolved
		}
	}
	directory := filepath.Dir(path)
	output, err := os.CreateTemp(directory, ".hyperpg-*.xlsx")
	if err != nil {
		return fmt.Errorf("Could not create a file in %s: %s. Choose a folder you can write to", directory, excelFileError(err))
	}
	temporary := output.Name()
	saved := false
	defer func() {
		// Also runs when writing the workbook panics, so no temporary file is left.
		if !saved {
			output.Close()
			os.Remove(temporary)
		}
	}()
	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err = output.Chmod(mode); err != nil {
		return fmt.Errorf("Could not save %s: %s", filepath.Base(path), excelFileError(err))
	}
	if _, err = excelWorkbookWriter(file, output); err != nil {
		return fmt.Errorf("Could not save %s: %s. Check that the disk has free space", filepath.Base(path), excelFileError(err))
	}
	if err = output.Sync(); err != nil {
		return fmt.Errorf("Could not save %s: %s", filepath.Base(path), excelFileError(err))
	}
	if err = output.Close(); err != nil {
		return fmt.Errorf("Could not save %s: %s", filepath.Base(path), excelFileError(err))
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// os.Rename replaces an existing file on every platform (MoveFileEx with
	// MOVEFILE_REPLACE_EXISTING on Windows); it fails there while another app
	// has the file open, which leaves the existing file untouched.
	if err = os.Rename(temporary, path); err != nil {
		return fmt.Errorf("Could not replace %s: %s. Close it in other apps and try again", filepath.Base(path), excelFileError(err))
	}
	saved = true
	return nil
}

// excelWorkbookWriter writes the workbook; tests replace it to simulate failures.
var excelWorkbookWriter = func(file *excelize.File, output *os.File) (int64, error) {
	return file.WriteTo(output)
}

func excelFileError(err error) string {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}

func excelDatabaseError(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		message := pgErr.Message
		if pgErr.Hint != "" {
			message += " (" + pgErr.Hint + ")"
		}
		return message
	}
	return safeConnectionError(err)
}

func formatCount(value int64) string {
	digits := fmt.Sprint(value)
	if value < 0 {
		return "-" + formatCount(-value)
	}
	for i := len(digits) - 3; i > 0; i -= 3 {
		digits = digits[:i] + "," + digits[i:]
	}
	return digits
}

func plural(count int64, one, many string) string {
	if count == 1 {
		return one
	}
	return many
}
