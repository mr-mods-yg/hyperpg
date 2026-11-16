package database

import "unicode"

// statementSpan is a statement's code range in runes, from its first token
// through its terminating semicolon. Leading whitespace and comments are excluded.
type statementSpan struct {
	start int
	end   int
}

// splitStatements mirrors frontend/src/sql-statements.ts: semicolons inside
// literals, quoted identifiers, comments and dollar-quoted bodies do not end a
// statement, and segments containing only whitespace or comments are skipped,
// matching how PostgreSQL counts statements in a simple query.
func splitStatements(script string) []statementSpan {
	src := []rune(script)
	var spans []statementSpan
	codeStart, codeEnd := -1, -1
	mark := func(from, to int) {
		if codeStart < 0 {
			codeStart = from
		}
		codeEnd = to
	}
	flush := func() {
		if codeStart >= 0 {
			spans = append(spans, statementSpan{start: codeStart, end: codeEnd})
		}
		codeStart, codeEnd = -1, -1
	}
	i := 0
	for i < len(src) {
		c := src[i]
		var next rune
		if i+1 < len(src) {
			next = src[i+1]
		}
		switch {
		case c == '\'' || c == '"':
			start := i
			quote := c
			escaped := c == '\'' && i > 0 && (src[i-1] == 'e' || src[i-1] == 'E') && (i < 2 || !isIdentifierRune(src[i-2]))
			i++
			for i < len(src) {
				if src[i] == quote && i+1 < len(src) && src[i+1] == quote {
					i += 2
					continue
				}
				if src[i] == quote {
					i++
					break
				}
				// PostgreSQL escape strings use backslashes to escape quotes.
				if escaped && src[i] == '\\' && i+1 < len(src) {
					i += 2
				} else {
					i++
				}
			}
			mark(start, i)
		case c == '-' && next == '-':
			i += 2
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '/' && next == '*':
			i += 2
			depth := 1
			for i < len(src) && depth > 0 {
				switch {
				case src[i] == '/' && i+1 < len(src) && src[i+1] == '*':
					depth++
					i += 2
				case src[i] == '*' && i+1 < len(src) && src[i+1] == '/':
					depth--
					i += 2
				default:
					i++
				}
			}
		case c == '$':
			start := i
			if tag := dollarTag(src[i:]); tag != "" {
				tagRunes := []rune(tag)
				end := indexRunes(src, tagRunes, i+len(tagRunes))
				if end < 0 {
					i = len(src)
				} else {
					i = end + len(tagRunes)
				}
			} else {
				i++
			}
			mark(start, i)
		case c == ';':
			if codeStart >= 0 {
				codeEnd = i + 1
			}
			i++
			flush()
		case unicode.IsSpace(c):
			i++
		case isIdentifierStart(c):
			// Identifiers and keywords are consumed whole, because PostgreSQL
			// allows $ inside them: x$y$ is an identifier, not a dollar quote.
			start := i
			for i++; i < len(src) && isIdentifierRune(src[i]); i++ {
			}
			mark(start, i)
		default:
			mark(i, i+1)
			i++
		}
	}
	flush()
	return spans
}

// statementAt returns the 1-based statement containing a 0-based rune offset,
// treating whitespace and comments before a statement as part of it.
func statementAt(spans []statementSpan, offset int) int {
	for index, span := range spans {
		if offset < span.end {
			return index + 1
		}
	}
	return len(spans)
}

// isIdentifierStart follows PostgreSQL's ident_start, [A-Za-z\200-\377_]:
// every non-ASCII character can start an identifier. Unicode whitespace is
// excluded to match the frontend, which treats it as a separator.
func isIdentifierStart(r rune) bool {
	return r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= 0x80 && !unicode.IsSpace(r)
}

// isIdentifierRune follows PostgreSQL's ident_cont, [A-Za-z\200-\377_0-9\$].
func isIdentifierRune(r rune) bool {
	return isIdentifierStart(r) || r == '$' || r >= '0' && r <= '9'
}

// dollarTag matches PostgreSQL's dolqdelim, \$([A-Za-z\200-\377_][A-Za-z\200-\377_0-9]*)?\$,
// at the start of src.
func dollarTag(src []rune) string {
	if len(src) < 2 || src[0] != '$' {
		return ""
	}
	if src[1] == '$' {
		return "$$"
	}
	if !isIdentifierStart(src[1]) {
		return ""
	}
	for j := 2; j < len(src); j++ {
		if src[j] == '$' {
			return string(src[:j+1])
		}
		if !isIdentifierRune(src[j]) {
			return ""
		}
	}
	return ""
}

func indexRunes(src, needle []rune, from int) int {
	for i := from; i+len(needle) <= len(src); i++ {
		match := true
		for j, r := range needle {
			if src[i+j] != r {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
