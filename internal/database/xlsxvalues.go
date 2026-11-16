package database

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

const (
	// excelMaxCellChars is Excel's limit on characters (UTF-16 units) in a cell.
	excelMaxCellChars = 32_767
	// excelMaxSheetName is Excel's limit on characters in a sheet name.
	excelMaxSheetName = 31
	// excelMaxExactInteger is the largest integer Excel keeps every digit of:
	// it shows and edits numbers with 15 significant digits, so 16-digit
	// integers (even those below 2^53) would be displayed and saved rounded.
	excelMaxExactInteger = 999_999_999_999_999
	// excelMaxNumber and excelMinNumber bound the magnitudes Excel accepts.
	excelMaxNumber = 9.99999999999999e307
	excelMinNumber = 2.2250738585072014e-308
	// excelMaxNumericDigits is how many significant digits Excel keeps.
	excelMaxNumericDigits = 15
)

type excelValueKind int

const (
	excelText excelValueKind = iota
	excelInteger
	excelFloat
	excelNumeric
	excelBoolean
	excelDate
	excelTimestamp
	excelTimestampTZ
)

// excelKindForType maps a PostgreSQL type name (from format_type) to how the
// value is written. Everything not listed is written as text.
func excelKindForType(typeName string) excelValueKind {
	switch typeName {
	case "smallint", "integer", "bigint":
		return excelInteger
	case "real", "double precision":
		return excelFloat
	case "numeric":
		return excelNumeric
	case "boolean":
		return excelBoolean
	case "date":
		return excelDate
	case "timestamp without time zone":
		return excelTimestamp
	case "timestamp with time zone":
		return excelTimestampTZ
	}
	return excelText
}

// excelCellValue converts PostgreSQL's text output into a spreadsheet value.
// Values that a spreadsheet cannot represent exactly fall back to text. The
// second result is true when text was shortened to fit in a cell.
func excelCellValue(kind excelValueKind, text string) (any, bool) {
	switch kind {
	case excelInteger:
		if value, err := strconv.ParseInt(text, 10, 64); err == nil && value <= excelMaxExactInteger && value >= -excelMaxExactInteger {
			return value, false
		}
	case excelFloat:
		if value, err := strconv.ParseFloat(text, 64); err == nil && excelNumberInRange(value) {
			return value, false
		}
	case excelNumeric:
		if numericFitsExcel(text) {
			// Tiny values such as 1e-400 parse to 0 or a subnormal, so the range
			// check keeps them as text.
			if value, err := strconv.ParseFloat(text, 64); err == nil && excelNumberInRange(value) && (value != 0 || numericIsZero(text)) {
				return value, false
			}
		}
	case excelBoolean:
		switch text {
		case "true", "t":
			return true, false
		case "false", "f":
			return false, false
		}
	case excelDate:
		if value, err := time.Parse("2006-01-02", text); err == nil && excelDateInRange(value) {
			return value, false
		}
	case excelTimestamp:
		if value, err := time.Parse("2006-01-02 15:04:05.999999999", text); err == nil && excelDateInRange(value) {
			return value, false
		}
	case excelTimestampTZ:
		// The export session uses UTC, so PostgreSQL prints a +00 offset.
		if value, err := time.Parse("2006-01-02 15:04:05.999999999Z07", text); err == nil {
			value = value.UTC()
			if excelDateInRange(value) {
				return value, false
			}
		}
	}
	return truncateExcelText(text)
}

// excelNumberInRange reports whether Excel can store the number: NaN, infinities
// and magnitudes beyond Excel's range (including subnormals) are written as text.
func excelNumberInRange(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return false
	}
	magnitude := math.Abs(value)
	return magnitude == 0 || magnitude >= excelMinNumber && magnitude <= excelMaxNumber
}

// numericFitsExcel reports whether a numeric value survives conversion to a
// double without losing digits.
func numericFitsExcel(text string) bool {
	digits := strings.TrimLeft(text, "+-")
	if digits == "" || strings.ContainsAny(digits, "eE") {
		return false
	}
	whole, fraction, _ := strings.Cut(digits, ".")
	for _, r := range whole + fraction {
		if r < '0' || r > '9' {
			return false // NaN, Infinity
		}
	}
	// Leading zeros (0.000123) and trailing fractional zeros (1.50) are not
	// significant; trailing zeros of the whole part are counted to stay safe.
	significant := strings.TrimLeft(whole+strings.TrimRight(fraction, "0"), "0")
	return len(significant) <= excelMaxNumericDigits
}

func numericIsZero(text string) bool {
	return strings.Trim(text, "+-0.") == ""
}

// excelDateInRange limits dates to the range Excel can display (1900 to 9999).
func excelDateInRange(value time.Time) bool {
	return value.Year() >= 1900 && value.Year() <= 9999
}

// truncateExcelText shortens text to Excel's per-cell limit without splitting
// a UTF-16 surrogate pair.
func truncateExcelText(text string) (string, bool) {
	if len(text) <= excelMaxCellChars {
		return text, false // fast path: byte length bounds UTF-16 length
	}
	return truncateUTF16(text, excelMaxCellChars)
}

func truncateUTF16(text string, limit int) (string, bool) {
	units := 0
	for index, r := range text {
		size := utf16.RuneLen(r)
		if size < 0 {
			size = 1
		}
		if units+size > limit {
			return text[:index], true
		}
		units += size
	}
	return text, false
}

// sanitizeSheetName applies Excel's sheet name rules: at most 31 characters,
// none of []:*?/\, and no apostrophe at either end. Inner apostrophes are also
// replaced because sheet references such as 'a”b'!A1 need escaping that not
// every tool applies, and the export relies on such references for filters.
func sanitizeSheetName(name string) string {
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`[]:*?/\`, r) || unicode.IsControl(r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, "' ")
	name = strings.ReplaceAll(name, "'", "_")
	name, _ = truncateUTF16(name, excelMaxSheetName)
	name = strings.TrimRight(name, " ")
	if name == "" {
		return "Sheet"
	}
	return name
}

// assignSheetNames names each table's sheet after the table. Names that clash
// case-insensitively (or with a reserved name) use schema.table instead, and a
// numeric suffix is the last resort. Tables must be sorted by schema and name.
func assignSheetNames(tables []ExcelExportTable, reserved ...string) []string {
	taken := map[string]bool{"history": true} // reserved by Excel
	for _, name := range reserved {
		taken[strings.ToLower(name)] = true
	}
	bases := make([]string, len(tables))
	counts := map[string]int{}
	for i, table := range tables {
		bases[i] = sanitizeSheetName(table.Name)
		counts[strings.ToLower(bases[i])]++
	}
	names := make([]string, len(tables))
	for i, table := range tables {
		candidate := bases[i]
		if key := strings.ToLower(candidate); counts[key] > 1 || taken[key] {
			candidate = sanitizeSheetName(table.Schema + "." + table.Name)
		}
		name := candidate
		for suffix := 2; taken[strings.ToLower(name)]; suffix++ {
			tail := fmt.Sprintf(" (%d)", suffix)
			head, _ := truncateUTF16(candidate, excelMaxSheetName-len(tail))
			name = strings.TrimRight(head, " ") + tail
		}
		taken[strings.ToLower(name)] = true
		names[i] = name
	}
	return names
}
