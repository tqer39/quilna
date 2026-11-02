package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func artifactFixture(t *testing.T) (Engine, string, Task, string) {
	t.Helper()
	e, path, task := fixture(t)
	if err := os.WriteFile(filepath.Join(task.Workspace, ".gitignore"), []byte(".build/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(task.Workspace, ".build/App.app")
	if err := os.MkdirAll(filepath.Join(bundle, "Contents/MacOS"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"App", "App.debug.dylib"} {
		if err := os.WriteFile(filepath.Join(bundle, "Contents/MacOS", name), []byte("original"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	task.Checks[0].Artifacts = []string{".build/App.app"}
	writeTask(t, path, task)
	return e, path, task, bundle
}

func TestChangedRuntimeDylibInvalidatesAcceptedCheck(t *testing.T) {
	e, path, _, bundle := artifactFixture(t)
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "accepted" {
		t.Fatalf("initial run: %+v", r)
	}
	if err := os.WriteFile(filepath.Join(bundle, "Contents/MacOS/App.debug.dylib"), []byte("replaced runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := e.Status(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s.CurrentCodeHash != r.CodeHash || !s.Stale || s.CurrentValidation != "artifact-modified" {
		t.Fatalf("changed ignored runtime accepted: stale=%v validation=%s codeUnchanged=%v", s.Stale, s.CurrentValidation, s.CurrentCodeHash == r.CodeHash)
	}
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil {
		t.Fatal("resumed with replaced runtime")
	}
}

func TestSuccessfulCommandMustProduceDeclaredArtifact(t *testing.T) {
	e, path, _, bundle := artifactFixture(t)
	if err := os.RemoveAll(bundle); err != nil {
		t.Fatal(err)
	}
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "blocked" || r.Reason != "artifact-capture-failed" || r.Operations != 1 {
		t.Fatalf("missing required build output accepted: status=%s reason=%s operations=%d", r.Status, r.Reason, r.Operations)
	}
}

func TestArtifactBundleChangesInvalidateEvidence(t *testing.T) {
	for _, mutation := range []string{"delete", "add", "mode", "directory-mode", "symlink", "manifest", "manifest-symlink"} {
		t.Run(mutation, func(t *testing.T) {
			e, path, _, bundle := artifactFixture(t)
			r := executeRun(t, e, newRun(t, e, path))
			if r.Status != "accepted" {
				t.Fatal(r.Status)
			}
			file := filepath.Join(bundle, "Contents/MacOS/App")
			switch mutation {
			case "delete":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			case "add":
				if err := os.WriteFile(filepath.Join(bundle, "extra"), []byte("new"), 0600); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(file, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory-mode":
				if err := os.Chmod(filepath.Join(bundle, "Contents"), 0755); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("App.debug.dylib", file); err != nil {
					t.Fatal(err)
				}
			case "manifest", "manifest-symlink":
				manifest := filepath.Join(e.Store.Directory, r.Evidence[0].Artifacts.Manifest)
				if mutation == "manifest" {
					if err := os.WriteFile(manifest, []byte("{}"), 0600); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.Rename(manifest, manifest+".copy"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(manifest+".copy", manifest); err != nil {
						t.Fatal(err)
					}
				}
			}
			status, err := e.Status(r.ID)
			if err != nil || !status.Stale {
				t.Fatalf("mutation not invalidated: %+v %v", status, err)
			}
		})
	}
}

func TestReviewCannotMutateArtifactEvenWhenRequestingRepair(t *testing.T) {
	for _, decision := range []string{"approve", "always-revise"} {
		t.Run(decision, func(t *testing.T) {
			e, path, task, _ := artifactFixture(t)
			task.Review.Command = append([]string{"/bin/sh", "-c", `printf changed > .build/App.app/Contents/MacOS/App.debug.dylib; exec "$@"`, "review"}, helper("review", decision)...)
			repair := action("repair", "fix")
			task.Repair = &repair
			task.MaxRepairCycles = 1
			writeTask(t, path, task)
			r := executeRun(t, e, newRun(t, e, path))
			if r.Status != "blocked" || r.Reason != "artifact-modified" || r.Operations != 2 {
				t.Fatalf("review modified artifact: %+v", r)
			}
		})
	}
}

func TestRepairedBuildSupersedesCurrentArtifactButRetainsHistory(t *testing.T) {
	e, path, task, _ := artifactFixture(t)
	task.Checks[0].Command = []string{"/bin/sh", "-c", "cp code.txt .build/App.app/Contents/MacOS/App.debug.dylib"}
	task.Review.Command = helper("review", "by-content")
	repair := action("repair", "fix")
	task.Repair = &repair
	task.MaxRepairCycles = 1
	writeTask(t, path, task)
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "accepted" || r.Cycle != 1 {
		t.Fatalf("repair failed: %+v", r)
	}
	first, err := e.loadArtifactManifest(r, r.Evidence[0])
	if err != nil {
		t.Fatal(err)
	}
	latest, err := e.loadArtifactManifest(r, r.Evidence[3])
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first.Trees)
	b, _ := json.Marshal(latest.Trees)
	if bytes.Equal(a, b) || first.CodeHash == latest.CodeHash {
		t.Fatal("old source/artifact identity replaced")
	}
	s, err := e.Summary(r.ID)
	if err != nil || s.Stale || len(s.Checks) != 1 || s.Checks[0].Artifacts == nil || !filepath.IsAbs(s.Checks[0].Artifacts.Manifest) {
		t.Fatalf("wrong current evidence: %+v %v", s, err)
	}
	manifest := filepath.Join(e.Store.Directory, r.Evidence[0].Artifacts.Manifest)
	if err := os.WriteFile(manifest, []byte("changed history"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err = e.Summary(r.ID)
	if err != nil || !s.Stale || s.CurrentValidation != "artifact-manifest-modified" {
		t.Fatalf("historical manifest not protected: %+v %v", s, err)
	}
}

func TestArtifactTreeAcceptsInternalFrameworkLinksAndRefusesExternalOrSpecialFiles(t *testing.T) {
	for _, kind := range []string{"internal", "external", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			_, _, task, bundle := artifactFixture(t)
			link := filepath.Join(bundle, "Current")
			var err error
			switch kind {
			case "internal":
				err = os.Symlink("Contents", link)
			case "external":
				err = os.Symlink(task.Workspace, link)
			case "fifo":
				err = syscall.Mkfifo(link, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			trees, err := snapshotArtifacts(task.Workspace, task.Checks[0].Artifacts)
			if kind == "internal" {
				if err != nil || len(trees) != 1 {
					t.Fatalf("internal link refused: %v", err)
				}
			} else if err == nil {
				t.Fatal("unsafe artifact captured")
			}
		})
	}
}

func TestArtifactTaskRejectsEscapesOverlapsAndStateCapture(t *testing.T) {
	for _, invalid := range []string{"", ".", "../outside", "/absolute", ".build/../outside", ".git/config"} {
		e, path, task, _ := artifactFixture(t)
		task.Checks[0].Artifacts = []string{invalid}
		writeTask(t, path, task)
		if _, err := e.New(path); err == nil {
			t.Fatalf("unsafe path accepted: %q", invalid)
		}
	}
	e, path, task, _ := artifactFixture(t)
	extra := action("check")
	extra.Artifacts = []string{".build/App.app/Contents"}
	task.Checks = append(task.Checks, extra)
	writeTask(t, path, task)
	if _, err := e.New(path); err == nil {
		t.Fatal("overlapping outputs accepted")
	}
	task.Checks = task.Checks[:1]
	store, err := OpenStore(filepath.Join(task.Workspace, ".build/state"))
	if err != nil {
		t.Fatal(err)
	}
	e.Store = store
	task.Checks[0].Artifacts = []string{".build"}
	writeTask(t, path, task)
	if _, err := e.New(path); err == nil || err.Error() != "artifact-overlaps-state" {
		t.Fatalf("state capture: %v", err)
	}
}

func TestArtifactReviewCancellationPreservesStoppedCheckpoint(t *testing.T) {
	for _, artifacts := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "artifacts"}[artifacts], func(t *testing.T) {
			e, path, task, _ := artifactFixture(t)
			if !artifacts {
				task.Checks[0].Artifacts = nil
			}
			gate := filepath.Join(filepath.Dir(path), "review-started")
			task.Review.Command = []string{"/bin/sh", "-c", `printf started > "$1"; exec /bin/sleep 10`, "review", gate}
			task.Review.TimeoutSeconds = 15
			writeTask(t, path, task)
			r := newRun(t, e, path)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type result struct {
				run *Run
				err error
			}
			done := make(chan result, 1)
			go func() { run, err := e.Execute(ctx, r.ID, false); done <- result{run, err} }()
			deadline := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(gate); err == nil {
					break
				}
				if time.Now().After(deadline) {
					cancel()
					<-done
					t.Fatal("review never started")
				}
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
			got := <-done
			if got.err != nil || got.run.Status != "stopped" || got.run.Reason != "interrupted" || got.run.Pending == nil {
				t.Fatalf("cancellation overwritten by artifact scan: %+v %v", got.run, got.err)
			}
		})
	}
}
