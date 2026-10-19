//go:build !windows

package main

func runUpdaterHelper([]string) (bool, error) {
	return false, nil
}
