package harness

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Engine struct {
	Store      *Store
	AllowCodex bool
}

func (e Engine) Status(id string) (*Run, error) {
	r, err := e.Store.Load(id)
	if err != nil {
		return nil, err
	}
	r.CurrentCodeHash, err = CodeHash(r.Task.Workspace)
	if err != nil {
		r.Stale = true
		r.CurrentValidation = "code-unreadable"
	} else if r.CurrentCodeHash != r.CodeHash {
		r.Stale = true
		r.CurrentValidation = "code-modified"
	}
	_, _, r.CurrentTaskHash, err = LoadTask(r.TaskPath)
	if err != nil || r.CurrentTaskHash != r.TaskHash {
		r.Stale = true
		r.CurrentValidation = "fixed-task-modified"
	}
	if err := e.verifyEvidence(r); err != nil {
		r.Stale = true
		r.CurrentValidation = err.Error()
	}
	return r, nil
}

func (e Engine) New(taskPath string) (*Run, error) {
	taskPath, err := filepath.Abs(taskPath)
	if err != nil {
		return nil, err
	}
	task, _, hash, err := LoadTask(taskPath)
	if err != nil {
		return nil, err
	}
	if err := verifySnapshots(task.ProtectedFiles); err != nil {
		return nil, err
	}
	if _, err := gitRoot(task.Workspace); err != nil {
		return nil, err
	}
	if e.Store.Directory == task.Workspace {
		return nil, errors.New("state-cannot-be-workspace-root")
	}
	if strings.HasPrefix(e.Store.Directory, task.Workspace+string(filepath.Separator)) {
		rel, _ := filepath.Rel(task.Workspace, e.Store.Directory)
		if _, err := gitOutput(task.Workspace, "check-ignore", "-q", "--", rel); err != nil {
			return nil, errors.New("state-inside-workspace-must-be-ignored")
		}
		tracked, err := gitOutput(task.Workspace, "ls-files", "--cached", "--", rel)
		if err != nil || len(tracked) != 0 {
			return nil, errors.New("state-must-not-be-tracked")
		}
	}
	for _, check := range task.Checks {
		for _, path := range check.Artifacts {
			root := filepath.Join(task.Workspace, path)
			if withinPath(root, e.Store.Directory) || withinPath(e.Store.Directory, root) {
				return nil, errors.New("artifact-overlaps-state")
			}
		}
	}
	if task.usesCodex() && !e.AllowCodex {
		return nil, errors.New("codex-disabled")
	}
	codeHash, err := CodeHash(task.Workspace)
	if err != nil {
		return nil, err
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	r := &Run{ID: hex.EncodeToString(id[:]), TaskPath: taskPath, TaskHash: hash, Task: task, CodeHash: codeHash, Status: "ready", Phase: "checks", Evidence: []Evidence{}, Findings: []string{}}
	if task.Implement != nil {
		r.Phase = "implement"
	}
	if err := os.Mkdir(filepath.Join(e.Store.Directory, r.ID), 0o700); err != nil {
		return nil, err
	}
	if err := e.Store.Save(r, true); err != nil {
		return nil, err
	}
	return r, nil
}

func (e Engine) Execute(ctx context.Context, id string, reconcileLocal bool) (*Run, error) {
	r, err := e.Store.Load(id)
	if err != nil {
		return nil, err
	}
	lock, err := lockFile(filepath.Join(e.Store.Directory, id+".lock"))
	if err != nil {
		return nil, err
	}
	defer unlockFile(lock)
	// Reload after locking; a stale status must never replay accepted operations.
	r, err = e.Store.Load(id)
	if err != nil {
		return nil, err
	}
	wlock, err := workspaceLock(r.Task.Workspace)
	if err != nil {
		return nil, err
	}
	defer unlockFile(wlock)
	_, _, taskHash, err := LoadTask(r.TaskPath)
	if err != nil || taskHash != r.TaskHash {
		return r, errors.New("fixed-task-modified")
	}
	if err := e.verifyEvidence(r); err != nil {
		return r, err
	}
	current, err := CodeHash(r.Task.Workspace)
	if err != nil {
		return r, err
	}
	if r.Status == "accepted" || r.Status == "rejected" {
		if current != r.CodeHash {
			return r, errors.New("code-modified-since-checkpoint")
		}
		return r, nil
	}
	if r.Task.usesCodex() && !e.AllowCodex {
		return r, errors.New("codex-disabled")
	}
	if err := e.Store.clearStop(id); err != nil {
		return r, err
	}
	remaining := time.Duration(r.Task.TimeoutSeconds)*time.Second - time.Duration(r.ElapsedMillis)*time.Millisecond
	if remaining <= 0 {
		return e.finish(r, "blocked", "time-budget-exhausted")
	}
	ctx, cancel := context.WithTimeout(ctx, remaining)
	defer cancel()
	// Stop requests cancel the active runner. Join its watcher before releasing
	// the run/workspace locks or allowing the caller to clean up state.
	stopWatching := watchStopRequests(ctx, cancel, func() (*Run, error) { return e.Store.Load(id) })
	defer stopWatching()
	if r.Pending != nil {
		switch r.Pending.Effect {
		case "verification":
			if current != r.Pending.CodeHash {
				return r, errors.New("code-modified-since-interruption")
			}
			if !r.Pending.ProcessStopped && !reconcileLocal {
				return r, errors.New("process-state-unknown-inspect-and-use-reconcile-local")
			}
			if !r.Pending.ProcessStopped {
				r.Reason = "verification-process-reconciled"
				if err := e.Store.Save(r, false); err != nil {
					return r, err
				}
			}
			r.Pending = nil // Safe to rerun a trusted, side-effect-free verification command.
		case "local-edit":
			if !reconcileLocal {
				return r, errors.New("local-edit-unknown-use-reconcile-local-after-inspection")
			}
			r.Pending = nil
			r.Phase = "checks"
			r.CheckIndex = 0
			r.CodeHash = current
			r.Reason = "local-edit-reconciled"
			if err := e.Store.Save(r, false); err != nil {
				return r, err
			}
		case "model-review":
			// A possibly dispatched model turn is never automatically sent again.
			return e.recoverReview(ctx, r)
		case "model-action":
			return e.recoverModelAction(ctx, r, reconcileLocal)
		default:
			return r, errors.New("pending-effect-invalid")
		}
	} else if current != r.CodeHash {
		return r, errors.New("code-modified-since-checkpoint")
	}
	r.Status = "running"
	r.Reason = ""
	if err := e.Store.Save(r, false); err != nil {
		return r, err
	}
	for {
		if ctx.Err() != nil {
			return e.finish(r, "stopped", "interrupted")
		}
		_, _, fixedHash, fixedErr := LoadTask(r.TaskPath)
		if fixedErr != nil || fixedHash != r.TaskHash {
			return e.finish(r, "blocked", "fixed-task-modified")
		}
		if err := verifySnapshots(r.Task.ProtectedFiles); err != nil {
			return e.finish(r, "blocked", err.Error())
		}
		if err := e.verifyArtifactsDuringRun(ctx, r); err != nil {
			if ctx.Err() != nil {
				return e.finish(r, "stopped", "interrupted")
			}
			return e.finish(r, "blocked", err.Error())
		}
		if r.Operations >= r.Task.MaxOperations {
			return e.finish(r, "blocked", "operation-budget-exhausted")
		}
		before, err := CodeHash(r.Task.Workspace)
		if err != nil {
			return r, err
		}
		if before != r.CodeHash {
			return e.finish(r, "blocked", "concurrent-code-change")
		}
		effect := "verification"
		if r.Phase == "repair" || r.Phase == "implement" {
			effect = "local-edit"
			a := r.Task.Implement
			if r.Phase == "repair" {
				a = r.Task.Repair
			}
			if a != nil && a.isCodex() {
				effect = "model-action"
			}
		}
		if r.Phase == "review" && r.Task.Review.Kind == "codex" {
			effect = "model-review"
		}
		r.Pending = &Pending{Phase: r.Phase, Effect: effect, CodeHash: before}
		r.Operations++
		if err := e.Store.Save(r, false); err != nil {
			return r, err
		}
		inputEvidence := latestCheckEvidence(r)
		for i := range inputEvidence {
			inputEvidence[i].Log = filepath.Join(e.Store.Directory, inputEvidence[i].Log)
			if ref := inputEvidence[i].Artifacts; ref != nil {
				inputEvidence[i].Artifacts = &ArtifactReference{Manifest: filepath.Join(e.Store.Directory, ref.Manifest), SHA256: ref.SHA256}
			}
		}
		history, historyErr := summarizeHistory(r)
		if historyErr != nil {
			return e.finish(r, "blocked", historyErr.Error())
		}
		input, _ := json.Marshal(struct {
			Goal       string         `json:"goal"`
			Acceptance []string       `json:"acceptance"`
			CodeHash   string         `json:"codeHash"`
			TaskHash   string         `json:"taskHash"`
			Findings   []string       `json:"findings"`
			Evidence   []Evidence     `json:"evidence"`
			History    HistorySummary `json:"history"`
		}{r.Task.Goal, r.Task.Acceptance, before, r.TaskHash, r.Findings, inputEvidence, history})
		var result processResult
		started := time.Now().UTC()
		switch r.Phase {
		case "implement":
			if r.Task.Implement.isCodex() {
				result = e.codexOperation(ctx, r, input, false)
			} else {
				result = execute(ctx, r.Task.Workspace, *r.Task.Implement, input, r.Task.LogLimitBytes, nil)
			}
		case "repair":
			if r.Task.Repair.isCodex() {
				result = e.codexOperation(ctx, r, input, false)
			} else {
				result = execute(ctx, r.Task.Workspace, *r.Task.Repair, input, r.Task.LogLimitBytes, nil)
			}
		case "checks":
			result = execute(ctx, r.Task.Workspace, r.Task.Checks[r.CheckIndex], input, r.Task.LogLimitBytes, nil)
		case "review":
			if r.Task.Review.Kind == "command" {
				result = execute(ctx, r.Task.Workspace, Action{Command: r.Task.Review.Command, TimeoutSeconds: r.Task.Review.TimeoutSeconds}, input, r.Task.LogLimitBytes, nil)
			} else {
				result = e.codexReview(ctx, r, input, false)
			}
		default:
			return r, errors.New("phase-invalid")
		}
		r.ElapsedMillis += result.duration.Milliseconds()
		r.Pending.ProcessStopped = true
		_, _, fixedHash, fixedErr = LoadTask(r.TaskPath)
		if fixedErr != nil || fixedHash != r.TaskHash {
			return e.finish(r, "blocked", "fixed-task-modified")
		}
		after, hashErr := CodeHash(r.Task.Workspace)
		if hashErr != nil {
			return r, hashErr
		}
		logName := fmt.Sprintf("%s/%03d.json", r.ID, r.Operations)
		logHash, logErr := writeEvidenceLog(filepath.Join(e.Store.Directory, logName), result)
		if logErr != nil {
			return r, logErr
		}
		r.Pending.ObservedHash = after
		r.Evidence = append(r.Evidence, Evidence{Model: r.Pending.Model, Operation: r.Operations, Phase: r.Phase, CodeHash: before, AfterHash: after, ExitCode: result.exitCode, Outcome: result.outcome, StartedAt: started.Format(time.RFC3339Nano), DurationMillis: result.duration.Milliseconds(), Log: logName, LogHash: logHash})
		if r.Phase == "checks" {
			index := r.CheckIndex
			r.Evidence[len(r.Evidence)-1].CheckIndex = &index
			if result.outcome == "complete" && result.exitCode == 0 && before == after {
				artifactStarted := time.Now()
				ref, err := e.captureArtifacts(r, r.Evidence[len(r.Evidence)-1])
				r.ElapsedMillis += time.Since(artifactStarted).Milliseconds()
				if err != nil {
					r.Evidence[len(r.Evidence)-1].Outcome = "artifact-capture-failed"
					r.Evidence[len(r.Evidence)-1].ArtifactError = err.Error()
					return e.finish(r, "blocked", "artifact-capture-failed")
				}
				r.Evidence[len(r.Evidence)-1].Artifacts = ref
			}
		}
		if err := verifySnapshots(r.Task.ProtectedFiles); err != nil {
			return e.finish(r, "blocked", err.Error())
		}
		if r.Phase == "review" {
			if err := e.verifyArtifactsDuringRun(ctx, r); err != nil {
				if ctx.Err() != nil {
					return e.finish(r, "stopped", "interrupted")
				}
				return e.finish(r, "blocked", err.Error())
			}
		}
		if (effect == "verification" || effect == "model-review") && before != after {
			return e.finish(r, "blocked", "verification-modified-code")
		}
		if result.outcome != "complete" {
			if (effect == "model-review" || effect == "model-action") && !r.Pending.Dispatched {
				r.Pending = nil
				return e.finish(r, "blocked", result.outcome)
			}
			if result.outcome == "interrupted" || effect == "model-review" || effect == "model-action" || effect == "local-edit" {
				return e.finish(r, "stopped", result.outcome) // Keep Pending for explicit recovery/reconciliation.
			}
			r.Pending = nil
			if r.Phase == "checks" && result.outcome == "command-failed" {
				r.Findings = []string{fmt.Sprintf("check-%d-failed", r.CheckIndex)}
				if e.prepareRepair(r) {
					if err := e.Store.Save(r, false); err != nil {
						return r, err
					}
					continue
				}
			}
			return e.finish(r, "blocked", result.outcome)
		}
		if effect == "model-action" {
			if err := parseEditResult(result.stdout); err != nil {
				return e.finish(r, "blocked", err.Error())
			}
		}
		r.Pending = nil
		r.CodeHash = after
		switch r.Phase {
		case "implement", "repair":
			r.Phase = "checks"
			r.CheckIndex = 0
		case "checks":
			r.CheckIndex++
			if r.CheckIndex == len(r.Task.Checks) {
				r.Phase = "review"
			}
		case "review":
			if after != before {
				return e.finish(r, "blocked", "review-modified-code")
			}
			review, err := parseReview(result.stdout, before)
			if err != nil {
				return e.finish(r, "blocked", err.Error())
			}
			r.Findings = review.Findings
			if review.Decision == "approve" {
				return e.finish(r, "accepted", "")
			}
			if review.Decision == "reject" {
				return e.finish(r, "rejected", "review-rejected")
			}
			if !e.prepareRepair(r) {
				return e.finish(r, "blocked", "repair-budget-exhausted")
			}
		}
		if err := e.Store.Save(r, false); err != nil {
			return r, err
		}
	}
}

func (e Engine) verifyEvidence(r *Run) error {
	if err := verifySnapshots(r.Task.ProtectedFiles); err != nil {
		return err
	}
	for _, proof := range r.Evidence {
		if !strings.HasPrefix(proof.Log, r.ID+"/") || filepath.Clean(proof.Log) != proof.Log {
			return errors.New("evidence-path-invalid")
		}
		data, err := os.ReadFile(filepath.Join(e.Store.Directory, proof.Log))
		if err != nil || digest(data) != proof.LogHash {
			return errors.New("evidence-modified")
		}
	}
	return e.verifyArtifactEvidence(r)
}

func (e Engine) prepareRepair(r *Run) bool {
	if r.Task.Repair == nil || r.Cycle >= r.Task.MaxRepairCycles {
		return false
	}
	r.Cycle++
	r.Phase = "repair"
	r.CheckIndex = 0
	return true
}

func (e Engine) finish(r *Run, status, reason string) (*Run, error) {
	r.Status = status
	r.Reason = reason
	return r, e.Store.Save(r, false)
}

func (e Engine) recoverReview(ctx context.Context, r *Run) (*Run, error) {
	if !e.AllowCodex {
		return r, errors.New("codex-disabled")
	}
	if r.Pending.ThreadID == "" || r.Pending.TurnID == "" {
		return e.finish(r, "blocked", "model-dispatch-unknown-no-replay")
	}
	current, err := CodeHash(r.Task.Workspace)
	if err != nil || current != r.Pending.CodeHash {
		return r, errors.New("code-modified-since-model-review")
	}
	if r.Operations >= r.Task.MaxOperations {
		return e.finish(r, "blocked", "operation-budget-exhausted")
	}
	r.Operations++
	if err := e.Store.Save(r, false); err != nil {
		return r, err
	}
	started := time.Now().UTC()
	result := e.codexReview(ctx, r, nil, true)
	r.ElapsedMillis += result.duration.Milliseconds()
	after, err := CodeHash(r.Task.Workspace)
	if err != nil {
		return r, err
	}
	logName := fmt.Sprintf("%s/%03d.json", r.ID, r.Operations)
	logHash, err := writeEvidenceLog(filepath.Join(e.Store.Directory, logName), result)
	if err != nil {
		return r, err
	}
	r.Evidence = append(r.Evidence, Evidence{Model: r.Pending.Model, Operation: r.Operations, Phase: "review-recovery", CodeHash: current, AfterHash: after, ExitCode: result.exitCode, Outcome: result.outcome, StartedAt: started.Format(time.RFC3339Nano), DurationMillis: result.duration.Milliseconds(), Log: logName, LogHash: logHash})
	if err := verifySnapshots(r.Task.ProtectedFiles); err != nil {
		return e.finish(r, "blocked", err.Error())
	}
	if err := e.verifyArtifactsDuringRun(ctx, r); err != nil {
		if ctx.Err() != nil {
			return e.finish(r, "stopped", "interrupted")
		}
		return e.finish(r, "blocked", err.Error())
	}
	if current != after {
		return e.finish(r, "blocked", "review-recovery-modified-code")
	}
	_, _, fixedHash, fixedErr := LoadTask(r.TaskPath)
	if fixedErr != nil || fixedHash != r.TaskHash {
		return e.finish(r, "blocked", "fixed-task-modified")
	}
	if ctx.Err() != nil {
		return e.finish(r, "stopped", "interrupted")
	}
	if result.outcome != "complete" {
		return e.finish(r, "blocked", "model-result-unconfirmed-no-replay")
	}
	review, err := parseReview(result.stdout, current)
	if err != nil {
		return e.finish(r, "blocked", err.Error())
	}
	// Recovery can approve/reject a confirmed completed turn, but never starts a repair implicitly.
	r.Pending = nil
	r.Findings = review.Findings
	if review.Decision == "approve" {
		return e.finish(r, "accepted", "")
	}
	if review.Decision == "reject" {
		return e.finish(r, "rejected", "review-rejected")
	}
	if e.prepareRepair(r) {
		return e.finish(r, "ready", "recovered-review-resume-required")
	}
	return e.finish(r, "blocked", "repair-budget-exhausted")
}

func (e Engine) recoverModelAction(ctx context.Context, r *Run, reconcile bool) (*Run, error) {
	if !reconcile {
		return r, errors.New("model-edit-unknown-inspect-and-use-reconcile-local")
	}
	if r.Pending.ThreadID == "" || r.Pending.TurnID == "" {
		return e.finish(r, "blocked", "model-dispatch-unknown-no-replay")
	}
	before, err := CodeHash(r.Task.Workspace)
	if err != nil {
		return r, err
	}
	if r.Pending.ObservedHash != "" && before != r.Pending.ObservedHash {
		return r, errors.New("code-modified-since-model-interruption")
	}
	if r.Operations >= r.Task.MaxOperations {
		return e.finish(r, "blocked", "operation-budget-exhausted")
	}
	r.Operations++
	if err := e.Store.Save(r, false); err != nil {
		return r, err
	}
	started := time.Now().UTC()
	result := e.codexOperation(ctx, r, nil, true)
	r.ElapsedMillis += result.duration.Milliseconds()
	after, err := CodeHash(r.Task.Workspace)
	if err != nil {
		return r, err
	}
	logName := fmt.Sprintf("%s/%03d.json", r.ID, r.Operations)
	logHash, err := writeEvidenceLog(filepath.Join(e.Store.Directory, logName), result)
	if err != nil {
		return r, err
	}
	r.Evidence = append(r.Evidence, Evidence{Model: r.Pending.Model, Operation: r.Operations, Phase: r.Pending.Phase + "-recovery", CodeHash: before, AfterHash: after, ExitCode: result.exitCode, Outcome: result.outcome, StartedAt: started.Format(time.RFC3339Nano), DurationMillis: result.duration.Milliseconds(), Log: logName, LogHash: logHash})
	if err := verifySnapshots(r.Task.ProtectedFiles); err != nil {
		return e.finish(r, "blocked", err.Error())
	}
	if before != after {
		return e.finish(r, "blocked", "model-recovery-modified-code")
	}
	_, _, fixedHash, fixedErr := LoadTask(r.TaskPath)
	if fixedErr != nil || fixedHash != r.TaskHash {
		return e.finish(r, "blocked", "fixed-task-modified")
	}
	if ctx.Err() != nil {
		return e.finish(r, "stopped", "interrupted")
	}
	if result.outcome != "complete" {
		return e.finish(r, "blocked", "model-result-unconfirmed-no-replay")
	}
	if err := parseEditResult(result.stdout); err != nil {
		return e.finish(r, "blocked", err.Error())
	}
	r.Pending = nil
	r.CodeHash = after
	r.Phase = "checks"
	r.CheckIndex = 0
	return e.finish(r, "ready", "model-edit-reconciled-resume-required")
}

// watchStopRequests owns all background ledger reads for one execution.
func watchStopRequests(ctx context.Context, cancel context.CancelFunc, load func() (*Run, error)) func() {
	stop := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				// A ready tick must not start a new read after shutdown.
				select {
				case <-stop:
					return
				case <-ctx.Done():
					return
				default:
				}
				latest, err := load()
				if err != nil || latest.StopRequested {
					cancel()
					return
				}
			}
		}
	}()
	return func() {
		close(stop)
		<-finished
	}
}
