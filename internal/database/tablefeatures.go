package database

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type TableFilter struct {
	Column   string `json:"column"`
	Operator string `json:"operator"`
	Value    any    `json:"value"`
	Value2   any    `json:"value2"`
}
type TableSort struct {
	Column    string `json:"column"`
	Direction string `json:"direction"`
}
type TableQueryOptions struct {
	Filters []TableFilter `json:"filters"`
	Sort    []TableSort   `json:"sort"`
}
type TableConstraint struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Definition string `json:"definition"`
}
type TableIndex struct {
	Name       string `json:"name"`
	Definition string `json:"definition"`
}
type TableMetadata struct {
	Constraints []TableConstraint `json:"constraints"`
	Indexes     []TableIndex      `json:"indexes"`
	DDL         string            `json:"ddl"`
}
type SchemaCompletion struct {
	Schema  string   `json:"schema"`
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
}

func tableQueryParts(columns []ColumnInfo, options TableQueryOptions) (string, string, []any, error) {
	allowed := map[string]bool{}
	for _, c := range columns {
		allowed[c.Name] = true
	}
	conditions := []string{}
	args := []any{}
	order := []string{}
	sorted := map[string]bool{}
	for _, f := range options.Filters {
		if !allowed[f.Column] {
			return "", "", nil, fmt.Errorf("Unknown filter column: %s", f.Column)
		}
		col := pgx.Identifier{"hyperpg_row", f.Column}.Sanitize()
		switch f.Operator {
		case "isNull":
			conditions = append(conditions, col+" IS NULL")
		case "isNotNull":
			conditions = append(conditions, col+" IS NOT NULL")
		case "eq", "ne", "gt", "gte", "lt", "lte", "contains", "between":
			if f.Value == nil || (f.Operator == "between" && f.Value2 == nil) {
				return "", "", nil, fmt.Errorf("Filter %s requires a value", f.Operator)
			}
			args = append(args, f.Value)
			p := fmt.Sprintf("$%d", len(args))
			op := map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.Operator]
			switch f.Operator {
			case "contains":
				value, ok := f.Value.(string)
				if !ok {
					return "", "", nil, fmt.Errorf("Contains requires text")
				}
				args[len(args)-1] = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
				conditions = append(conditions, col+"::text ILIKE '%' || "+p+`::text || '%' ESCAPE E'\\'`)
			case "between":
				args = append(args, f.Value2)
				conditions = append(conditions, fmt.Sprintf("%s BETWEEN %s AND $%d", col, p, len(args)))
			default:
				conditions = append(conditions, col+" "+op+" "+p)
			}
		default:
			return "", "", nil, fmt.Errorf("Unknown filter operator: %s", f.Operator)
		}
	}
	for _, v := range options.Sort {
		if !allowed[v.Column] {
			return "", "", nil, fmt.Errorf("Unknown sort column: %s", v.Column)
		}
		dir := strings.ToUpper(v.Direction)
		if dir != "ASC" && dir != "DESC" {
			return "", "", nil, fmt.Errorf("Invalid sort direction: %s", v.Direction)
		}
		if !sorted[v.Column] {
			order = append(order, pgx.Identifier{"hyperpg_row", v.Column}.Sanitize()+" "+dir)
			sorted[v.Column] = true
		}
	}
	// Physical location is unique across partitions and provides a deterministic tie-breaker.
	order = append(order, `"hyperpg_row".tableoid`, `"hyperpg_row".ctid`)
	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}
	return where, strings.Join(order, ", "), args, nil
}

func (s *PostgresService) GetFilteredTableData(connectionID, schema, table string, limit, offset int, options TableQueryOptions) (TableData, error) {
	db, err := s.connection(connectionID)
	if err != nil {
		return TableData{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	columns, err := readTableColumns(ctx, db, schema, table)
	if err != nil {
		return TableData{}, err
	}
	if len(columns) == 0 {
		return TableData{}, fmt.Errorf("That table is no longer available")
	}
	where, order, args, err := tableQueryParts(columns, options)
	if err != nil {
		return TableData{}, err
	}
	target := pgx.Identifier{schema, table}.Sanitize() + ` AS "hyperpg_row"`
	var count int64
	if err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+target+where, args...).Scan(&count); err != nil {
		return TableData{}, fmt.Errorf("Could not count table rows: %w", err)
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
	selectCols := []string{`"hyperpg_row".tableoid::text`, `"hyperpg_row".ctid::text`, `"hyperpg_row".xmin::text`}
	for _, c := range columns {
		selectCols = append(selectCols, pgx.Identifier{"hyperpg_row", c.Name}.Sanitize()+"::text")
	}
	args = append(args, limit, offset)
	query := fmt.Sprintf("SELECT %s FROM %s%s ORDER BY %s LIMIT $%d OFFSET $%d", strings.Join(selectCols, ", "), target, where, order, len(args)-1, len(args))
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return TableData{}, fmt.Errorf("Could not read table rows: %w", err)
	}
	defer rows.Close()
	result := TableData{Columns: columns, Rows: [][]any{}, RowCount: count, Identities: []RowIdentity{}}
	for rows.Next() {
		values := make([]any, len(columns)+3)
		dest := make([]any, len(values))
		for i := range values {
			dest[i] = &values[i]
		}
		if err = rows.Scan(dest...); err != nil {
			return TableData{}, err
		}
		result.Identities = append(result.Identities, RowIdentity{TableOID: values[0].(string), CTID: values[1].(string), Version: values[2].(string)})
		row := values[3:]
		for i, c := range columns {
			if c.DataType == "boolean" && row[i] != nil {
				row[i] = row[i] == "true"
			}
		}
		result.Rows = append(result.Rows, row)
	}
	return result, rows.Err()
}

func (s *PostgresService) GetSchemaCompletions(connectionID string) ([]SchemaCompletion, error) {
	db, err := s.connection(connectionID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg\_%' ESCAPE '\' ORDER BY table_schema,table_name,ordinal_position`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SchemaCompletion{}
	for rows.Next() {
		var schema, table, col string
		if err = rows.Scan(&schema, &table, &col); err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].Schema != schema || out[len(out)-1].Table != table {
			out = append(out, SchemaCompletion{Schema: schema, Table: table, Columns: []string{}})
		}
		out[len(out)-1].Columns = append(out[len(out)-1].Columns, col)
	}
	return out, rows.Err()
}

func (s *PostgresService) GetTableMetadata(connectionID, schema, table string) (TableMetadata, error) {
	db, err := s.connection(connectionID)
	if err != nil {
		return TableMetadata{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	target := pgx.Identifier{schema, table}.Sanitize()
	result := TableMetadata{Constraints: []TableConstraint{}, Indexes: []TableIndex{}}
	rows, err := db.QueryContext(ctx, `SELECT conname, CASE contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' ELSE contype::text END, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname`, target)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var c TableConstraint
		if err = rows.Scan(&c.Name, &c.Type, &c.Definition); err != nil {
			rows.Close()
			return result, err
		}
		result.Constraints = append(result.Constraints, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = db.QueryContext(ctx, `SELECT c.relname, pg_get_indexdef(c.oid), EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid=c.oid AND con.conrelid=i.indrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=to_regclass($1) ORDER BY c.relname`, target)
	if err != nil {
		return result, err
	}
	independentIndexes := []string{}
	for rows.Next() {
		var i TableIndex
		var constraintBacked bool
		if err = rows.Scan(&i.Name, &i.Definition, &constraintBacked); err != nil {
			rows.Close()
			return result, err
		}
		result.Indexes = append(result.Indexes, i)
		if !constraintBacked {
			independentIndexes = append(independentIndexes, i.Definition+";")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = db.QueryContext(ctx, `SELECT a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, target)
	if err != nil {
		return result, err
	}
	defs := []string{}
	for rows.Next() {
		var name, typ, identity, generated string
		var notnull bool
		var def sql.NullString
		if err = rows.Scan(&name, &typ, &notnull, &identity, &generated, &def); err != nil {
			rows.Close()
			return result, err
		}
		line := "    " + pgx.Identifier{name}.Sanitize() + " " + typ
		if identity == "a" {
			line += " GENERATED ALWAYS AS IDENTITY"
		} else if identity == "d" {
			line += " GENERATED BY DEFAULT AS IDENTITY"
		} else if generated != "" && def.Valid {
			line += " GENERATED ALWAYS AS (" + def.String + ") STORED"
		} else if def.Valid {
			line += " DEFAULT " + def.String
		}
		if notnull {
			line += " NOT NULL"
		}
		defs = append(defs, line)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if len(defs) == 0 {
		return result, fmt.Errorf("That table is no longer available")
	}
	for _, c := range result.Constraints {
		defs = append(defs, "    CONSTRAINT "+pgx.Identifier{c.Name}.Sanitize()+" "+c.Definition)
	}
	result.DDL = "-- Table definition: columns, constraints, and indexes. Other PostgreSQL table properties are not included.\nCREATE TABLE " + target + " (\n" + strings.Join(defs, ",\n") + "\n);"
	if len(independentIndexes) > 0 {
		result.DDL += "\n\n" + strings.Join(independentIndexes, "\n")
	}
	return result, nil
}

func (s *PostgresService) GenerateTableSQL(connectionID, schema, table, kind string) (string, error) {
	if strings.EqualFold(kind, "DDL") {
		m, e := s.GetTableMetadata(connectionID, schema, table)
		return m.DDL, e
	}
	db, err := s.connection(connectionID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cols, err := readTableColumns(ctx, db, schema, table)
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("That table is no longer available")
	}
	target := pgx.Identifier{schema, table}.Sanitize()
	names := []string{}
	params := []string{}
	sets := []string{}
	for _, c := range cols {
		if c.Generated || c.AutoIncrement {
			continue
		}
		name := pgx.Identifier{c.Name}.Sanitize()
		names = append(names, name)
		params = append(params, fmt.Sprintf("$%d", len(params)+1))
		sets = append(sets, name+" = "+params[len(params)-1])
	}
	switch strings.ToUpper(kind) {
	case "SELECT":
		return "SELECT *\nFROM " + target + "\nLIMIT 100;", nil
	case "INSERT":
		if len(names) == 0 {
			return "INSERT INTO " + target + " DEFAULT VALUES;", nil
		}
		return "INSERT INTO " + target + " (" + strings.Join(names, ", ") + ")\nVALUES (" + strings.Join(params, ", ") + ");", nil
	case "UPDATE":
		if len(sets) == 0 {
			return "", fmt.Errorf("No editable columns")
		}
		return "UPDATE " + target + "\nSET " + strings.Join(sets, ", ") + "\nWHERE /* add a condition */ FALSE;", nil
	default:
		return "", fmt.Errorf("Unknown SQL template: %s", kind)
	}
}

// ExportTableData streams every matching row into a file selected by the user.
// A temporary file in the destination directory prevents failed exports from
// leaving a partial destination behind.
func (s *PostgresService) ExportTableData(connectionID, schema, table string, options TableQueryOptions, format, path string) (err error) {
	format = strings.ToLower(format)
	if format != "csv" && format != "json" && format != "sql" {
		return fmt.Errorf("Unknown export format: %s", format)
	}
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("Choose a destination file")
	}
	db, err := s.connection(connectionID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	columns, err := readTableColumns(ctx, db, schema, table)
	if err != nil {
		return err
	}
	if len(columns) == 0 {
		return fmt.Errorf("That table is no longer available")
	}
	where, order, args, err := tableQueryParts(columns, options)
	if err != nil {
		return err
	}
	selectCols := []string{}
	names := []string{}
	exportCols := []ColumnInfo{}
	for _, c := range columns {
		if format == "sql" && c.Generated && c.IdentityGeneration == "" {
			continue
		}
		selectCols = append(selectCols, pgx.Identifier{"hyperpg_row", c.Name}.Sanitize()+"::text")
		names = append(names, c.Name)
		exportCols = append(exportCols, c)
	}
	if len(selectCols) == 0 {
		return fmt.Errorf("No exportable columns")
	}
	target := pgx.Identifier{schema, table}.Sanitize()
	rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(selectCols, ", ")+" FROM "+target+` AS "hyperpg_row"`+where+" ORDER BY "+order, args...)
	if err != nil {
		return fmt.Errorf("Could not read table rows: %w", err)
	}
	defer rows.Close()
	file, err := os.CreateTemp(filepath.Dir(path), ".hyperpg-export-*")
	if err != nil {
		return err
	}
	tmp := file.Name()
	defer func() {
		file.Close()
		if err != nil {
			os.Remove(tmp)
		}
	}()
	writer := bufio.NewWriter(file)
	var csvWriter *csv.Writer
	switch format {
	case "csv":
		csvWriter = csv.NewWriter(writer)
		if err = csvWriter.Write(names); err != nil {
			return err
		}
	case "json":
		if _, err = writer.WriteString("[\n"); err != nil {
			return err
		}
	case "sql":
		if _, err = writer.WriteString("-- Exported table data\n"); err != nil {
			return err
		}
	}
	first := true
	for rows.Next() {
		values := make([]sql.NullString, len(exportCols))
		dest := make([]any, len(values))
		for i := range values {
			dest[i] = &values[i]
		}
		if err = rows.Scan(dest...); err != nil {
			return err
		}
		switch format {
		case "csv":
			record := make([]string, len(values))
			for i, v := range values {
				if v.Valid {
					record[i] = v.String
				}
			}
			if err = csvWriter.Write(record); err != nil {
				return err
			}
		case "json":
			obj := make(map[string]any, len(values))
			for i, v := range values {
				if v.Valid {
					if exportCols[i].DataType == "boolean" {
						obj[names[i]] = v.String == "true"
					} else {
						obj[names[i]] = v.String
					}
				} else {
					obj[names[i]] = nil
				}
			}
			var encoded []byte
			encoded, err = json.Marshal(obj)
			if err != nil {
				return err
			}
			if !first {
				if _, err = writer.WriteString(",\n"); err != nil {
					return err
				}
			}
			if _, err = writer.Write(encoded); err != nil {
				return err
			}
		case "sql":
			quotedNames := make([]string, len(names))
			literals := make([]string, len(names))
			for i, v := range values {
				quotedNames[i] = pgx.Identifier{names[i]}.Sanitize()
				if !v.Valid {
					literals[i] = "NULL"
				} else {
					literals[i] = "E'" + strings.ReplaceAll(strings.ReplaceAll(v.String, `\`, `\\`), "'", "''") + "'"
				}
			}
			_, err = fmt.Fprintf(writer, "INSERT INTO %s (%s) OVERRIDING SYSTEM VALUE VALUES (%s);\n", target, strings.Join(quotedNames, ", "), strings.Join(literals, ", "))
			if err != nil {
				return err
			}
		}
		first = false
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if format == "json" {
		if _, err = writer.WriteString("\n]\n"); err != nil {
			return err
		}
	}
	if csvWriter != nil {
		csvWriter.Flush()
		if err = csvWriter.Error(); err != nil {
			return err
		}
	}
	if err = writer.Flush(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	return nil
}
