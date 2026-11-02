package harness

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// FileSnapshot binds a regular file's content and mode. Absolute paths also
// support trusted controls outside the editable workspace.
type FileSnapshot struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

func SnapshotFile(path string) (FileSnapshot, error) {
	var result FileSnapshot
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return result, errors.New("snapshot-path-must-be-canonical")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return result, errors.New("snapshot-symlink-or-missing")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|sysNoFollow|syscall.O_NONBLOCK, 0)
	if err != nil {
		return result, errors.New("snapshot-unreadable")
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return result, errors.New("snapshot-not-regular")
	}
	h := sha256.New()
	const maxBytes = 256 * 1024 * 1024
	n, err := io.Copy(h, io.LimitReader(f, maxBytes+1))
	if err != nil || n > maxBytes {
		return result, errors.New("snapshot-read-limit")
	}
	after, err := f.Stat()
	current, currentErr := os.Lstat(path)
	realAfter, pathErr := filepath.EvalSymlinks(path)
	if err != nil || currentErr != nil || pathErr != nil || realAfter != path || !os.SameFile(after, current) || before.Size() != after.Size() ||
		before.ModTime() != after.ModTime() || before.Mode() != after.Mode() {
		return result, errors.New("snapshot-file-changed")
	}
	return FileSnapshot{Path: path, SHA256: hex.EncodeToString(h.Sum(nil)), Mode: uint32(before.Mode())}, nil
}

func validateSnapshots(files []FileSnapshot) error {
	if len(files) > 256 {
		return errors.New("protected-files-limit")
	}
	seen := map[string]bool{}
	for _, f := range files {
		if !filepath.IsAbs(f.Path) || filepath.Clean(f.Path) != f.Path || len(f.Path) > 4096 ||
			!hashPattern.MatchString(f.SHA256) || seen[f.Path] ||
			os.FileMode(f.Mode)&^(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
			return errors.New("protected-file-invalid")
		}
		seen[f.Path] = true
	}
	return nil
}

func verifySnapshots(files []FileSnapshot) error {
	for _, expected := range files {
		actual, err := SnapshotFile(expected.Path)
		if err != nil || actual != expected {
			return errors.New("protected-file-modified")
		}
	}
	return nil
}
