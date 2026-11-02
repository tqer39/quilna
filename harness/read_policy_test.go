package harness

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestCodexReviewReadPathsRoundTrip checks persisted grants, successful restricted turns and confirmed profile metadata.
func TestCodexReviewReadPathsRoundTrip(t *testing.T) {
	e, path, task := codexFixture(t, "restricted")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	document["review"].(map[string]any)["readPaths"] = []string{filepath.Join(task.Workspace, "code.txt")}
	data, _ = json.Marshal(document)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := LoadTask(path); err != nil {
		t.Fatalf("explicit review read scope was refused: %v", err)
	}
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "accepted" {
		t.Fatalf("restricted review did not complete: %+v", r)
	}
	data, _ = json.Marshal(r.Evidence[len(r.Evidence)-1].Model)
	var metadata map[string]any
	_ = json.Unmarshal(data, &metadata)
	if metadata["readProfile"] == nil || metadata["readProfile"] == "" {
		t.Fatalf("confirmed read profile missing from evidence: %s", data)
	}
}

// TestReviewReadPathsValidation distinguishes omitted legacy grants from invalid explicit scopes.
func TestReviewReadPathsValidation(t *testing.T) {
	_, _, task := codexFixture(t, "restricted")
	file := filepath.Join(task.Workspace, "code.txt")
	link := filepath.Join(task.Workspace, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(task.Workspace, "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	tooMany := make([]string, 129)
	for i := range tooMany {
		tooMany[i] = file
	}
	for _, test := range []struct {
		name  string
		paths []string
		valid bool
	}{
		{"file", []string{file}, true},
		{"directory", []string{task.Workspace}, true},
		{"legacy", nil, true},
		{"explicit-empty", []string{}, false},
		{"relative", []string{"code.txt"}, false},
		{"unclean", []string{task.Workspace + "/./code.txt"}, false},
		{"duplicate", []string{file, file}, false},
		{"missing", []string{file + "-missing"}, false},
		{"symlink", []string{link}, false},
		{"fifo", []string{fifo}, false},
		{"count", tooMany, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := task
			candidate.Review.ReadPaths = test.paths
			if err := candidate.validate(); (err == nil) != test.valid {
				t.Fatalf("unexpected validation: %v", err)
			}
		})
	}
	if err := validateReviewReadPaths(Reviewer{Kind: "command", ReadPaths: []string{file}}); err == nil {
		t.Fatal("command reviewer cannot enforce named Codex permissions")
	}
}

// TestCodexReviewRefusesUnconfirmedReadProfile rejects missing, changed, inherited or network-enabled profiles before dispatch.
func TestCodexReviewRefusesUnconfirmedReadProfile(t *testing.T) {
	for _, mode := range []string{"restricted-missing", "restricted-other", "restricted-inherits", "restricted-network"} {
		t.Run(mode, func(t *testing.T) {
			e, path, task := codexFixture(t, mode)
			task.Review.ReadPaths = []string{filepath.Join(task.Workspace, "code.txt")}
			writeTask(t, path, task)
			r := executeRun(t, e, newRun(t, e, path))
			proof := r.Evidence[len(r.Evidence)-1]
			if r.Status == "accepted" || proof.Outcome != "codex-read-profile-unconfirmed" || proof.Model.TurnID != "" || proof.Model.ReadProfile != "" {
				t.Fatalf("unconfirmed profile reached dispatch: %+v", proof)
			}
		})
	}
}

// TestReadProfileCollisionRefusesInheritedGrant prevents a thread-local name from adopting an inherited profile.
func TestReadProfileCollisionRefusesInheritedGrant(t *testing.T) {
	_, _, task := codexFixture(t, "restricted")
	s, err := startAppServer(context.Background(), *task.Review.Codex, task.Workspace, 16384)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if err := s.initializeWithExperimental(true); err != nil {
		t.Fatal(err)
	}
	_, err = minimalThreadConfig(s, task.Workspace, "existing-profile", []string{filepath.Join(task.Workspace, "code.txt")})
	if err == nil || err.Error() != "codex-read-profile-collision" {
		t.Fatalf("inherited profile grant not refused: %v", err)
	}
}

// TestChangingReviewReadPathsInvalidatesFrozenTask prevents a broader grant from bypassing the frozen task hash.
func TestChangingReviewReadPathsInvalidatesFrozenTask(t *testing.T) {
	e, path, task := codexFixture(t, "restricted")
	task.Review.ReadPaths = []string{filepath.Join(task.Workspace, "code.txt")}
	writeTask(t, path, task)
	r := newRun(t, e, path)
	task.Review.ReadPaths = []string{task.Workspace}
	writeTask(t, path, task)
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "fixed-task-modified" {
		t.Fatalf("broader read grant reached execution: %v", err)
	}
}
