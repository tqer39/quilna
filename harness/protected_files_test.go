package harness

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestImplementationCannotRewriteFixedCheckIntoPassingResult(t *testing.T) {
	e, path, task := fixture(t)
	check := filepath.Join(task.Workspace, "fixed-check.sh")
	if err := os.WriteFile(check, []byte("exit 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := SnapshotFile(check)
	if err != nil {
		t.Fatal(err)
	}
	task.ProtectedFiles = []FileSnapshot{frozen}
	task.Checks = []Action{{Command: []string{"/bin/sh", check}, TimeoutSeconds: 3}}
	task.Implement = &Action{Command: []string{"/bin/sh", "-c", "printf 'exit 0\\n' > fixed-check.sh"}, TimeoutSeconds: 3}
	writeTask(t, path, task)
	r, err := e.New(path)
	if err != nil {
		t.Fatal(err)
	}
	r, err = e.Execute(context.Background(), r.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "blocked" || r.Reason != "protected-file-modified" || r.Operations != 1 {
		t.Fatalf("rewritten acceptance must never run: status=%s reason=%s operations=%d", r.Status, r.Reason, r.Operations)
	}
}

func TestProtectedExternalControlTamperingInvalidatesAcceptedEvidence(t *testing.T) {
	e, path, task := fixture(t)
	control := filepath.Join(filepath.Dir(path), "trusted-review-control")
	if err := os.WriteFile(control, []byte("fixed criteria"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := SnapshotFile(control)
	if err != nil {
		t.Fatal(err)
	}
	task.ProtectedFiles = []FileSnapshot{frozen}
	writeTask(t, path, task)
	r, err := e.New(path)
	if err != nil {
		t.Fatal(err)
	}
	r, err = e.Execute(context.Background(), r.ID, false)
	if err != nil || r.Status != "accepted" {
		t.Fatalf("%+v %v", r, err)
	}
	before := r.CodeHash
	if err := os.WriteFile(control, []byte("changed criteria"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, err := e.Status(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status.CurrentCodeHash != before || !status.Stale || status.CurrentValidation != "protected-file-modified" {
		t.Fatalf("outside control not covered by ordinary code hash: %+v", status)
	}
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "protected-file-modified" {
		t.Fatalf("modified control accepted on resume: %v", err)
	}
}

func TestProtectedFilesRejectMissingSymlinkContentAndModeChanges(t *testing.T) {
	for _, mutation := range []string{"missing", "symlink", "content", "mode"} {
		t.Run(mutation, func(t *testing.T) {
			e, path, task := fixture(t)
			control := filepath.Join(task.Workspace, "code.txt")
			frozen, err := SnapshotFile(control)
			if err != nil {
				t.Fatal(err)
			}
			task.ProtectedFiles = []FileSnapshot{frozen}
			writeTask(t, path, task)
			switch mutation {
			case "missing":
				_ = os.Remove(control)
			case "symlink":
				other := filepath.Join(task.Workspace, "other.txt")
				_ = os.Rename(control, other)
				_ = os.Symlink(other, control)
			case "content":
				_ = os.WriteFile(control, []byte("changed"), 0o600)
			case "mode":
				_ = os.Chmod(control, 0o700)
			}
			if _, err := e.New(path); err == nil || err.Error() != "protected-file-modified" {
				t.Fatalf("new run accepted modified control: %v", err)
			}
		})
	}
}

func TestProtectedFilesCannotBeRefrozenByTaskMutation(t *testing.T) {
	e, path, task := fixture(t)
	control := filepath.Join(task.Workspace, "code.txt")
	frozen, err := SnapshotFile(control)
	if err != nil {
		t.Fatal(err)
	}
	task.ProtectedFiles = []FileSnapshot{frozen}
	writeTask(t, path, task)
	r, err := e.New(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(control, []byte("changed"), 0o600)
	task.ProtectedFiles[0], err = SnapshotFile(control)
	if err != nil {
		t.Fatal(err)
	}
	writeTask(t, path, task)
	if _, err = e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "fixed-task-modified" {
		t.Fatalf("refrozen task accepted: %v", err)
	}
}

func TestFreezeTaskPreservesCriteriaAndNeverOverwritesOrSilentlyRefreezes(t *testing.T) {
	_, path, task := fixture(t)
	control := filepath.Join(task.Workspace, "code.txt")
	output := filepath.Join(filepath.Dir(path), "frozen.json")
	frozen, err := FreezeTask(path, output, []string{control})
	if err != nil {
		t.Fatal(err)
	}
	loaded, _, _, err := LoadTask(output)
	if err != nil || len(loaded.ProtectedFiles) != 1 || loaded.Goal != task.Goal || loaded.Acceptance[0] != task.Acceptance[0] || len(loaded.Checks) != len(task.Checks) {
		t.Fatalf("freeze changed the fixed contract: %+v %v", loaded, err)
	}
	info, err := os.Stat(output)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private task mode: %v %v", info, err)
	}
	if _, err := FreezeTask(path, output, []string{control}); err == nil {
		t.Fatal("overwrote existing task")
	}
	if _, err := FreezeTask(path, output+"-duplicate", []string{control, control}); err == nil {
		t.Fatal("duplicate control accepted")
	}
	_ = os.WriteFile(control, []byte("changed"), 0o600)
	other := filepath.Join(task.Workspace, "another.txt")
	_ = os.WriteFile(other, []byte("new"), 0o600)
	if _, err := FreezeTask(output, output+"-refrozen", []string{other}); err == nil || err.Error() != "protected-file-modified" {
		t.Fatalf("changed original control refrozen: %v", err)
	}
	if frozen.ProtectedFiles[0].SHA256 == "" {
		t.Fatal("missing file hash")
	}
}

func TestSnapshotRejectsFIFOWithoutWaitingForWriter(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "control.pipe")
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := SnapshotFile(path); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO accepted as a fixed regular file")
		}
	case <-time.After(300 * time.Millisecond):
		// Release a blocking read-only open so the red reproducer does not leak.
		fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			_ = syscall.Close(fd)
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("FIFO snapshot remained stuck")
		}
		t.Fatal("snapshot waited for a FIFO writer before checking the file type")
	}
}
