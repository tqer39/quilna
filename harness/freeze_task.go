package harness

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// FreezeTask creates a new specification; it never rewrites an existing task
// or refreezes a declared control whose bytes have already changed.
func FreezeTask(input, output string, files []string) (Task, error) {
	task, _, initialHash, err := LoadTask(input)
	if err != nil {
		return task, err
	}
	if len(files) == 0 {
		return task, errors.New("protected-files-required")
	}
	if err := verifySnapshots(task.ProtectedFiles); err != nil {
		return task, err
	}
	seen := map[string]bool{}
	for _, f := range task.ProtectedFiles {
		seen[f.Path] = true
	}
	for _, path := range files {
		if seen[path] {
			return task, errors.New("protected-file-duplicate")
		}
		f, err := SnapshotFile(path)
		if err != nil {
			return task, err
		}
		task.ProtectedFiles = append(task.ProtectedFiles, f)
		seen[path] = true
	}
	sort.Slice(task.ProtectedFiles, func(i, j int) bool { return task.ProtectedFiles[i].Path < task.ProtectedFiles[j].Path })
	if err := task.validate(); err != nil {
		return task, err
	}
	_, _, currentHash, err := LoadTask(input)
	if err != nil || currentHash != initialHash {
		return task, errors.New("fixed-task-modified")
	}
	if err := verifySnapshots(task.ProtectedFiles); err != nil {
		return task, err
	}
	if !filepath.IsAbs(output) || filepath.Clean(output) != output {
		return task, errors.New("output-must-be-canonical")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(output))
	if err != nil || parent != filepath.Dir(output) {
		return task, errors.New("output-parent-must-be-canonical")
	}
	data, err := json.MarshalIndent(task, "", "  ")
	if err != nil || len(data)+1 > 128*1024 {
		return task, errors.New("task-too-large")
	}
	f, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY|sysNoFollow, 0o600)
	if err != nil {
		return task, errors.New("output-must-be-new-file")
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return task, err
	}
	if err := f.Sync(); err != nil {
		return task, err
	}
	return task, nil
}
