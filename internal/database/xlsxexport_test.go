package database

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
	"github.com/xuri/excelize/v2"
)

func TestSanitizeSheetName(t *testing.T) {
	cases := map[string]string{
		"orders":                          "orders",
		"a[b]c:d*e?f/g\\h":                "a_b_c_d_e_f_g_h",
		"'quoted'":                        "quoted",
		"it's":                            "it_s",
		"":                                "Sheet",
		"'''":                             "Sheet",
		"line\nbreak":                     "line_break",
		strings.Repeat("x", 40):           strings.Repeat("x", 31),
		strings.Repeat("x", 30) + "'tail": strings.Repeat("x", 30) + "_",
		"表" + strings.Repeat("y", 40):     "表" + strings.Repeat("y", 30),
		strings.Repeat("y", 30) + "😀":     strings.Repeat("y", 30),
		strings.Repeat("y", 29) + "😀" + "zzzzz": strings.Repeat("y", 29) + "😀",
	}
	for input, want := range cases {
		got := sanitizeSheetName(input)
		if got != want {
			t.Errorf("sanitizeSheetName(%q) = %q, want %q", input, got, want)
		}
		if n := len(utf16.Encode([]rune(got))); n > 31 {
			t.Errorf("sanitizeSheetName(%q) is %d UTF-16 units long", input, n)
		}
	}
}

func TestAssignSheetNames(t *testing.T) {
	tables := []ExcelExportTable{
		{Schema: "audit", Name: "Users"},
		{Schema: "public", Name: "History"},
		{Schema: "public", Name: "orders"},
		{Schema: "public", Name: "summary"},
		{Schema: "public", Name: "users"},
		{Schema: "sales", Name: "a:b"},
		{Schema: "sales", Name: "a?b"},
		{Schema: "x", Name: strings.Repeat("long_table_name_", 3)},
		{Schema: "y", Name: strings.Repeat("long_table_name_", 3)},
	}
	got := assignSheetNames(tables, excelSummarySheet)
	want := []string{
		"audit.Users",
		"public.History",
		"orders",
		"public.summary",
		"public.users",
		"sales.a_b",
		"sales.a_b (2)",
		"x.long_table_name_long_table_na",
		"y.long_table_name_long_table_na",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("assignSheetNames:\n got %q\nwant %q", got, want)
	}
	seen := map[string]bool{"summary": true}
	for _, name := range got {
		key := strings.ToLower(name)
		if seen[key] {
			t.Errorf("duplicate sheet name %q", name)
		}
		seen[key] = true
		if len(utf16.Encode([]rune(name))) > 31 {
			t.Errorf("sheet name %q is too long", name)
		}
	}
}

func TestAssignSheetNamesSuffixFitsLimit(t *testing.T) {
	long := strings.Repeat("n", 40)
	tables := []ExcelExportTable{{Schema: "s", Name: long + "1"}, {Schema: "s", Name: long + "2"}, {Schema: "s", Name: long + "3"}}
	got := assignSheetNames(tables)
	want := []string{"s." + strings.Repeat("n", 29), "s." + strings.Repeat("n", 25) + " (2)", "s." + strings.Repeat("n", 25) + " (3)"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestExcelCellValue(t *testing.T) {
	timestamp := time.Date(2024, 3, 9, 14, 5, 6, 789000000, time.UTC)
	cases := []struct {
		kind excelValueKind
		text string
		want any
	}{
		{excelInteger, "42", int64(42)},
		{excelInteger, "-999999999999999", int64(-999999999999999)},
		// Excel keeps 15 significant digits, so 16-digit integers stay text
		// even below 2^53.
		{excelInteger, "1234567890123456", "1234567890123456"},
		{excelInteger, "-9007199254740991", "-9007199254740991"},
		{excelInteger, "9007199254740993", "9007199254740993"},
		{excelFloat, "1.5", 1.5},
		{excelFloat, "NaN", "NaN"},
		{excelFloat, "-Infinity", "-Infinity"},
		{excelFloat, "0", 0.0},
		{excelFloat, "-1.5e+307", -1.5e307},
		// Beyond Excel's number range.
		{excelFloat, "1.7976931348623157e+308", "1.7976931348623157e+308"},
		{excelFloat, "1e-310", "1e-310"},
		{excelNumeric, "123.4500", 123.45},
		{excelNumeric, "0.000123", 0.000123},
		{excelNumeric, "-99999999999999.9", -99999999999999.9},
		{excelNumeric, "12345678901234567.89", "12345678901234567.89"},
		{excelNumeric, "0.1234567890123456", "0.1234567890123456"},
		{excelNumeric, "NaN", "NaN"},
		{excelNumeric, "0.000", 0.0},
		// Parses to 0 as a double, so it must stay text.
		{excelNumeric, "0." + strings.Repeat("0", 400) + "1", "0." + strings.Repeat("0", 400) + "1"},
		{excelBoolean, "true", true},
		{excelBoolean, "false", false},
		{excelDate, "2024-03-09", time.Date(2024, 3, 9, 0, 0, 0, 0, time.UTC)},
		{excelDate, "infinity", "infinity"},
		{excelDate, "1800-01-01", "1800-01-01"},
		{excelDate, "0044-03-15 BC", "0044-03-15 BC"},
		{excelTimestamp, "2024-03-09 14:05:06.789", timestamp},
		{excelTimestampTZ, "2024-03-09 14:05:06.789+00", timestamp},
		{excelTimestampTZ, "2024-03-09 16:05:06.789+02", timestamp},
		{excelText, `{"a": 1}`, `{"a": 1}`},
		{excelText, "{1,2,3}", "{1,2,3}"},
	}
	for _, c := range cases {
		got, truncated := excelCellValue(c.kind, c.text)
		if truncated {
			t.Errorf("excelCellValue(%v, %q) reported truncation", c.kind, c.text)
		}
		if gotTime, ok := got.(time.Time); ok {
			if wantTime, ok := c.want.(time.Time); !ok || !gotTime.Equal(wantTime) {
				t.Errorf("excelCellValue(%v, %q) = %v, want %v", c.kind, c.text, got, c.want)
			}
			continue
		}
		if got != c.want {
			t.Errorf("excelCellValue(%v, %q) = %#v, want %#v", c.kind, c.text, got, c.want)
		}
	}
}

func TestExcelCellValueTruncation(t *testing.T) {
	short := strings.Repeat("a", excelMaxCellChars)
	if got, truncated := excelCellValue(excelText, short); truncated || got != short {
		t.Fatal("a value at the limit must not be truncated")
	}
	got, truncated := excelCellValue(excelText, short+"b")
	if !truncated || got != short {
		t.Fatalf("expected truncation to %d characters", excelMaxCellChars)
	}
	// A surrogate pair straddling the limit is dropped, not split.
	emoji := strings.Repeat("a", excelMaxCellChars-1) + "😀"
	got, truncated = excelCellValue(excelText, emoji)
	if !truncated || got != strings.Repeat("a", excelMaxCellChars-1) {
		t.Fatal("expected the straddling surrogate pair to be dropped")
	}
	// Multi-byte text below the limit in UTF-16 units is kept.
	wide := strings.Repeat("é", excelMaxCellChars)
	if _, truncated := excelCellValue(excelText, wide); truncated {
		t.Fatal("UTF-16 length, not byte length, decides truncation")
	}
}

func TestExcelKindForType(t *testing.T) {
	cases := map[string]excelValueKind{
		"integer": excelInteger, "bigint": excelInteger, "double precision": excelFloat, "numeric": excelNumeric,
		"boolean": excelBoolean, "date": excelDate, "timestamp with time zone": excelTimestampTZ,
		"jsonb": excelText, "uuid": excelText, "interval": excelText, "bytea": excelText, "integer[]": excelText,
	}
	for name, want := range cases {
		if got := excelKindForType(name); got != want {
			t.Errorf("excelKindForType(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestSelectExcelTables(t *testing.T) {
	available := []ExcelExportTable{
		{Schema: "public", Name: "a", Kind: "table", Readable: true},
		{Schema: "public", Name: "secret", Kind: "table", Readable: false},
		{Schema: "public", Name: "v", Kind: "view", Readable: true},
	}
	all, warnings := selectExcelTables(available, ExcelExportOptions{})
	if len(all) != 1 || all[0].Name != "a" || len(warnings) != 0 {
		t.Fatalf("default selection = %v, %v", all, warnings)
	}
	withViews, _ := selectExcelTables(available, ExcelExportOptions{IncludeViews: true})
	if len(withViews) != 2 {
		t.Fatalf("selection with views = %v", withViews)
	}
	chosen, warnings := selectExcelTables(available, ExcelExportOptions{Tables: []TableInfo{{Schema: "public", Name: "v"}, {Schema: "public", Name: "secret"}, {Schema: "public", Name: "gone"}}})
	if len(chosen) != 1 || chosen[0].Name != "v" || len(warnings) != 2 {
		t.Fatalf("explicit selection = %v, %v", chosen, warnings)
	}
}

func TestExcelFileName(t *testing.T) {
	if got := excelFileName("shop"); got != "shop.xlsx" {
		t.Fatal(got)
	}
	if got := excelFileName("a/b:c"); got != "a_b_c.xlsx" {
		t.Fatal(got)
	}
}

func TestExcelDestinationPath(t *testing.T) {
	dir := t.TempDir()
	// A name the dialog returned with the extension is used as is, even when it
	// exists: the dialog already confirmed replacing it.
	confirmed := filepath.Join(dir, "confirmed.XLSX")
	if err := os.WriteFile(confirmed, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := excelDestinationPath(confirmed); err != nil || got != confirmed {
		t.Fatalf("confirmed path: %q, %v", got, err)
	}
	// A bare name gets the extension when nothing is there yet.
	fresh := filepath.Join(dir, "fresh")
	if got, err := excelDestinationPath(fresh); err != nil || got != fresh+".xlsx" {
		t.Fatalf("fresh path: %q, %v", got, err)
	}
	// A bare name whose .xlsx sibling exists was never confirmed, so it is refused
	// and the existing workbook is left alone.
	existing := filepath.Join(dir, "report")
	if err := os.WriteFile(existing+".xlsx", []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := excelDestinationPath(existing)
	if err == nil || got != "" || !strings.Contains(err.Error(), "report.xlsx already exists") {
		t.Fatalf("existing sibling: %q, %v", got, err)
	}
	if data, _ := os.ReadFile(existing + ".xlsx"); string(data) != "keep" {
		t.Fatal("existing workbook changed")
	}
	// A dangling symlink at the extended path is not silently followed either.
	dangling := filepath.Join(dir, "link")
	if err := os.Symlink(filepath.Join(dir, "missing-target"), dangling+".xlsx"); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if _, err := excelDestinationPath(dangling); err == nil {
		t.Fatal("accepted an existing symlink")
	}
}

func TestExportDatabaseToExcelPostgres(t *testing.T) {
	_, db, _ := gridTestDatabase(t)
	// Short schema names keep schema.table sheet names under 31 characters.
	suffix := time.Now().UnixNano() % 1_000_000
	schema, other := fmt.Sprintf("xa%06d", suffix), fmt.Sprintf("xb%06d", suffix)
	quoted, quotedOther := pgx.Identifier{schema}.Sanitize(), pgx.Identifier{other}.Sanitize()
	for _, name := range []string{quoted, quotedOther} {
		if _, err := db.Exec("CREATE SCHEMA " + name); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Exec("DROP SCHEMA " + name + " CASCADE") })
	}
	statements := []string{
		`CREATE TABLE ` + quoted + `.orders (
			id bigint PRIMARY KEY, label text, amount numeric(12,2), precise numeric, ratio double precision,
			paid boolean, placed date, created timestamp, seen timestamptz, tags text[], meta jsonb, ident uuid, huge text)`,
		`INSERT INTO ` + quoted + `.orders VALUES
			(2, 'second', 10.50, 12345678901234567890.123, 0.25, false, '2024-01-02', '2024-01-02 03:04:05', '2024-01-02 03:04:05+02', '{a,b}', '{"k": 1}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', NULL),
			(1, 'first', NULL, 1.5, NULL, true, NULL, NULL, NULL, NULL, NULL, NULL, repeat('x', 40000))`,
		`CREATE TABLE ` + quoted + `.users (id int PRIMARY KEY, name text)`,
		`INSERT INTO ` + quoted + `.users VALUES (1, 'Ada')`,
		`CREATE TABLE ` + quotedOther + `.users (id int PRIMARY KEY, email text)`,
		`CREATE TABLE ` + quoted + `."Summary" (note text)`,
		`CREATE VIEW ` + quoted + `.order_labels AS SELECT label FROM ` + quoted + `.orders`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	tables := []TableInfo{{Schema: schema, Name: "orders"}, {Schema: schema, Name: "users"}, {Schema: other, Name: "users"}, {Schema: schema, Name: "Summary"}, {Schema: schema, Name: "order_labels"}}

	listed, err := listExcelExportTables(context.Background(), db, true)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, table := range listed {
		if table.Schema == schema {
			kinds[table.Name] = table.Kind
		}
	}
	if kinds["orders"] != "table" || kinds["order_labels"] != "view" {
		t.Fatalf("listed kinds = %v", kinds)
	}

	path := filepath.Join(t.TempDir(), "export.xlsx")
	run := &excelExportRun{cancel: func() {}}
	result, err := exportDatabaseToExcel(context.Background(), db, "testdb", path, ExcelExportOptions{Tables: tables}, run)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != path || result.Cancelled || len(result.Sheets) != 5 || result.TotalRows != 5 {
		t.Fatalf("result = %+v", result)
	}
	if run.progress.TotalRows != 5 || run.progress.TableCount != 5 {
		t.Fatalf("progress = %+v", run.progress)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "shortened") || result.Sheets[sheetIndex(result.Sheets, "orders")].TruncatedCells != 1 {
		t.Fatalf("warnings = %v, sheets = %+v", result.Warnings, result.Sheets)
	}

	file, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	// Tables within a schema follow the database collation, so compare sets.
	sheetList := file.GetSheetList()
	got := append([]string(nil), sheetList[1:]...)
	sort.Strings(got)
	wantSheets := []string{"order_labels", "orders", schema + ".Summary", schema + ".users", other + ".users"}
	sort.Strings(wantSheets)
	if sheetList[0] != "Summary" || fmt.Sprint(got) != fmt.Sprint(wantSheets) || sheetList[len(sheetList)-1] != other+".users" {
		t.Fatalf("sheets = %q, want Summary then %q", sheetList, wantSheets)
	}

	rows, err := file.GetRows("orders", excelize.Options{RawCellValue: true})
	if err != nil {
		t.Fatal(err)
	}
	header := []string{"id", "label", "amount", "precise", "ratio", "paid", "placed", "created", "seen", "tags", "meta", "ident", "huge"}
	if fmt.Sprint(rows[0]) != fmt.Sprint(header) {
		t.Fatalf("header = %q", rows[0])
	}
	if len(rows) != 3 || rows[1][0] != "1" || rows[2][0] != "2" {
		t.Fatalf("rows must follow the primary key: %q", rows)
	}
	if len(rows[1][12]) != excelMaxCellChars {
		t.Fatalf("huge value has %d characters", len(rows[1][12]))
	}
	second := rows[2]
	if second[2] != "10.5" || second[3] != "12345678901234567890.123" || second[4] != "0.25" || second[9] != "{a,b}" || second[10] != `{"k": 1}` || second[11] != "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" {
		t.Fatalf("second row = %q", second)
	}
	// Numbers (and dates) are stored without a type attribute.
	number := excelize.CellTypeUnset
	types := map[string]excelize.CellType{"A3": number, "C3": number, "D3": excelize.CellTypeInlineString, "F3": excelize.CellTypeBool, "G3": number, "J3": excelize.CellTypeInlineString}
	for cell, want := range types {
		if got, err := file.GetCellType("orders", cell); err != nil || got != want {
			t.Errorf("%s type = %v, want %v (%v)", cell, got, want, err)
		}
	}
	formatted := map[string]string{"G3": "2024-01-02", "H3": "2024-01-02 03:04:05", "I3": "2024-01-02 01:04:05", "F3": "FALSE"}
	for cell, want := range formatted {
		if got, _ := file.GetCellValue("orders", cell); got != want {
			t.Errorf("%s = %q, want %q", cell, got, want)
		}
	}
	if empty, _ := file.GetCellValue("orders", "C2"); empty != "" {
		t.Errorf("NULL must be an empty cell, got %q", empty)
	}
	panes, err := file.GetPanes("orders")
	if err != nil || !panes.Freeze || panes.YSplit != 1 {
		t.Errorf("header row must be frozen: %+v %v", panes, err)
	}
	if names := file.GetDefinedName(); len(names) == 0 || !strings.Contains(fmt.Sprint(names), "_xlnm._FilterDatabase") {
		t.Errorf("expected autofilters, got %+v", names)
	}
	if width, _ := file.GetColWidth("orders", "M"); width != excelMaxColumnWidth {
		t.Errorf("long column width = %v, want the cap", width)
	}
	assertExcelColsAscending(t, path)

	summary, _ := file.GetRows("Summary")
	if summary[2][1] != "testdb" || !strings.Contains(fmt.Sprint(summary), "shortened") {
		t.Errorf("summary = %q", summary)
	}
}

func TestExportDatabaseToExcelCancelled(t *testing.T) {
	_, db, schema := gridTestDatabase(t)
	if _, err := db.Exec(`CREATE TABLE ` + pgx.Identifier{schema, "numbers"}.Sanitize() + ` AS SELECT generate_series(1, 10) AS n`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &excelExportRun{cancel: cancel}
	cancel()
	run.cancelled = true
	path := filepath.Join(t.TempDir(), "cancelled.xlsx")
	result, err := exportDatabaseToExcel(ctx, db, "testdb", path, ExcelExportOptions{Tables: []TableInfo{{Schema: schema, Name: "numbers"}}}, run)
	if err != nil || !result.Cancelled {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 0 {
		t.Fatalf("cancelled export left files behind: %v", entries)
	}
}

func TestExcelExportRegistry(t *testing.T) {
	var registry excelExportRegistry
	cancelled := false
	run, err := registry.start("x", func() { cancelled = true })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.start("x", func() {}); err == nil {
		t.Fatal("duplicate export IDs must be rejected")
	}
	if !registry.cancel("x") || !cancelled || !run.cancelled {
		t.Fatal("cancel must reach the running export")
	}
	registry.finish("x", run)
	if registry.cancel("x") || registry.get("x") != nil {
		t.Fatal("finished exports must be forgotten")
	}
}

func sheetIndex(sheets []ExcelSheetResult, table string) int {
	for i, sheet := range sheets {
		if sheet.Table == table {
			return i
		}
	}
	return 0
}

func TestExportDatabaseToExcelCancelWhileStreaming(t *testing.T) {
	_, db, schema := gridTestDatabase(t)
	if _, err := db.Exec(`CREATE TABLE ` + pgx.Identifier{schema, "big"}.Sanitize() + ` AS SELECT n, md5(n::text) AS label FROM generate_series(1, 400000) AS n`); err != nil {
		t.Fatal(err)
	}
	var registry excelExportRegistry
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run, err := registry.start("big", cancel)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "big.xlsx")
	done := make(chan ExcelExportResult, 1)
	go func() {
		result, err := exportDatabaseToExcel(ctx, db, "testdb", path, ExcelExportOptions{Tables: []TableInfo{{Schema: schema, Name: "big"}}}, run)
		if err != nil {
			t.Error(err)
		}
		done <- result
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		run.mu.Lock()
		progress := run.progress
		run.mu.Unlock()
		if progress.TableRows > 0 {
			if progress.Phase != "exporting" || progress.Table != "big" || progress.TableIndex != 1 || progress.TableCount != 1 {
				t.Fatalf("progress = %+v", progress)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the export never reported progress")
		}
		time.Sleep(5 * time.Millisecond)
	}
	registry.cancel("big")
	select {
	case result := <-done:
		if !result.Cancelled {
			t.Fatalf("result = %+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the export did not stop after cancel")
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 0 {
		t.Fatalf("cancelled export left files behind: %v", entries)
	}
}

func TestExportDatabaseToExcelSkipsUnreadableRelations(t *testing.T) {
	_, db, schema := gridTestDatabase(t)
	quoted := pgx.Identifier{schema}.Sanitize()
	statements := []string{
		`CREATE FUNCTION ` + quoted + `.boom() RETURNS int LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'boom'; END$$`,
		`CREATE VIEW ` + quoted + `.a_broken AS SELECT ` + quoted + `.boom() AS value`,
		`CREATE MATERIALIZED VIEW ` + quoted + `.b_unpopulated AS SELECT 1 AS value WITH NO DATA`,
		// Fails after more rows than the width sample, so the sheet already exists.
		`CREATE VIEW ` + quoted + `.c_partial AS SELECT CASE WHEN n = 450 THEN 1 / (n - 450) ELSE n END AS n FROM generate_series(1, 1000) AS n`,
		`CREATE TABLE ` + quoted + `.d_after (id int PRIMARY KEY)`,
		`INSERT INTO ` + quoted + `.d_after SELECT generate_series(1, 3)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	tables := []TableInfo{{Schema: schema, Name: "a_broken"}, {Schema: schema, Name: "b_unpopulated"}, {Schema: schema, Name: "c_partial"}, {Schema: schema, Name: "d_after"}}
	path := filepath.Join(t.TempDir(), "partial.xlsx")
	run := &excelExportRun{cancel: func() {}}
	result, err := exportDatabaseToExcel(context.Background(), db, "testdb", path, ExcelExportOptions{Tables: tables}, run)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != path || len(result.Sheets) != 2 || result.Sheets[0].Table != "c_partial" || result.Sheets[0].Rows != 449 || result.Sheets[1].Table != "d_after" || result.Sheets[1].Rows != 3 || result.TotalRows != 452 {
		t.Fatalf("result = %+v", result)
	}
	warnings := strings.Join(result.Warnings, "\n")
	for _, want := range []string{"Skipped " + schema + ".a_broken: boom", "Skipped " + schema + ".b_unpopulated: materialized view", "c_partial: Incomplete: reading stopped after 449 rows: division by zero"} {
		if !strings.Contains(warnings, want) {
			t.Errorf("warnings %q do not mention %q", result.Warnings, want)
		}
	}
	if run.progress.TotalRows != result.TotalRows {
		t.Errorf("progress total %d, result total %d", run.progress.TotalRows, result.TotalRows)
	}
	file, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if sheets := file.GetSheetList(); fmt.Sprint(sheets) != fmt.Sprint([]string{"Summary", "c_partial", "d_after"}) {
		t.Fatalf("sheets = %q", sheets)
	}
	if rows, _ := file.GetRows("c_partial"); len(rows) != 450 || rows[449][0] != "449" {
		t.Fatalf("partial sheet has %d rows", len(rows))
	}
	if rows, _ := file.GetRows("d_after"); len(rows) != 4 {
		t.Fatalf("table after the failures has %d rows", len(rows))
	}
	if summary, _ := file.GetRows("Summary"); !strings.Contains(fmt.Sprint(summary), "Incomplete") {
		t.Errorf("summary does not flag the incomplete sheet: %q", summary)
	}
}

func TestSaveExcelFileCleansUpAndReplaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.xlsx")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := excelize.NewFile()
	defer file.Close()
	if err := saveExcelFile(context.Background(), file, path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() < 100 || info.Mode().Perm() != 0o600 {
		t.Fatalf("existing file not replaced in place: %v %v", info, err)
	}
	original := excelWorkbookWriter
	defer func() { excelWorkbookWriter = original }()
	excelWorkbookWriter = func(*excelize.File, *os.File) (int64, error) { return 0, fmt.Errorf("disk full") }
	if err := saveExcelFile(context.Background(), file, path); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("err = %v", err)
	}
	excelWorkbookWriter = func(*excelize.File, *os.File) (int64, error) { panic("writer bug") }
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected the panic to propagate")
			}
		}()
		_ = saveExcelFile(context.Background(), file, path)
	}()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "out.xlsx" {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	if info, _ := os.Stat(path); info.Size() < 100 {
		t.Fatal("a failed save damaged the existing file")
	}
}

// assertExcelColsAscending checks every worksheet's <col> elements: Excel
// reports a corrupt file when they are not sorted by column.
func assertExcelColsAscending(t *testing.T, path string) {
	t.Helper()
	archive, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	pattern := regexp.MustCompile(`<col min="(\d+)"`)
	checked := 0
	for _, entry := range archive.File {
		if !strings.HasPrefix(entry.Name, "xl/worksheets/sheet") {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		previous := 0
		for _, match := range pattern.FindAllSubmatch(data, -1) {
			column, _ := strconv.Atoi(string(match[1]))
			if column <= previous {
				t.Errorf("%s: <col> elements are not in ascending order", entry.Name)
				break
			}
			previous = column
			checked++
		}
	}
	if checked == 0 {
		t.Error("no <col> elements found")
	}
}
