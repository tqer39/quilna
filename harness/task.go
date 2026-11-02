package harness

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// Task is a trusted local specification, never a command supplied by a model.
type Task struct {
	ProtectedFiles  []FileSnapshot `json:"protectedFiles,omitempty"`
	Version         int            `json:"version"`
	Name            string         `json:"name"`
	Workspace       string         `json:"workspace"`
	Goal            string         `json:"goal"`
	Acceptance      []string       `json:"acceptance"`
	Implement       *Action        `json:"implement,omitempty"`
	Checks          []Action       `json:"checks"`
	Review          Reviewer       `json:"review"`
	Repair          *Action        `json:"repair,omitempty"`
	MaxRepairCycles int            `json:"maxRepairCycles"`
	TimeoutSeconds  int            `json:"timeoutSeconds"`
	LogLimitBytes   int            `json:"logLimitBytes"`
	MaxOperations   int            `json:"maxOperations"`
}

type Action struct {
	Kind           string       `json:"kind,omitempty"`
	Command        []string     `json:"command,omitempty"`
	Codex          *CodexConfig `json:"codex,omitempty"`
	Instructions   string       `json:"instructions,omitempty"`
	TimeoutSeconds int          `json:"timeoutSeconds"`
}

func (a Action) isCodex() bool { return a.Kind == "codex" }

func (t Task) usesCodex() bool {
	return t.Review.Kind == "codex" || (t.Implement != nil && t.Implement.isCodex()) || (t.Repair != nil && t.Repair.isCodex())
}

func validCodex(c *CodexConfig) bool {
	return c != nil && c.Enabled && filepath.IsAbs(c.Binary) && filepath.IsAbs(c.Home) && len(c.Model) > 0 && len(c.Model) <= 160
}

type Reviewer struct {
	Kind           string       `json:"kind"`
	Command        []string     `json:"command,omitempty"`
	Codex          *CodexConfig `json:"codex,omitempty"`
	TimeoutSeconds int          `json:"timeoutSeconds"`
}

type CodexConfig struct {
	Enabled bool   `json:"enabled"`
	Binary  string `json:"binary"`
	Home    string `json:"home"`
	Model   string `json:"model"`
}

type Review struct {
	Decision string   `json:"decision"`
	CodeHash string   `json:"codeHash"`
	Findings []string `json:"findings"`
}

func strictJSON(data []byte, target any) error {
	// encoding/json normally accepts duplicate keys. Reject them at every depth.
	d := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		t, err := d.Token()
		if err != nil {
			return err
		}
		if delim, ok := t.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					if e != nil {
						return e
					}
					key, ok := k.(string)
					if !ok || seen[key] {
						return errors.New("duplicate-json-key")
					}
					seen[key] = true
					if e = walk(); e != nil {
						return e
					}
				}
			case '[':
				for d.More() {
					if err := walk(); err != nil {
						return err
					}
				}
			default:
				return errors.New("invalid-json")
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := walk(); err != nil {
		return errors.New("invalid-json")
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing-json")
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errors.New("schema-invalid")
	}
	return nil
}

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func LoadTask(path string) (Task, []byte, string, error) {
	var task Task
	f, err := os.Open(path)
	if err != nil {
		return task, nil, "", errors.New("task-unreadable")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 128*1024+1))
	if err != nil || len(data) > 128*1024 {
		return task, nil, "", errors.New("task-too-large")
	}
	if err = strictJSON(data, &task); err != nil {
		return task, nil, "", err
	}
	if err = task.validate(); err != nil {
		return task, nil, "", err
	}
	canonical, _ := json.Marshal(task)
	return task, canonical, digest(canonical), nil
}

var safeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validCommand(command []string) bool {
	if len(command) == 0 || len(command) > 64 || !filepath.IsAbs(command[0]) {
		return false
	}
	for _, arg := range command {
		if len(arg) > 8192 || bytes.IndexByte([]byte(arg), 0) >= 0 {
			return false
		}
	}
	return true
}

func (t Task) validate() error {
	if err := validateSnapshots(t.ProtectedFiles); err != nil {
		return err
	}
	if t.Version != 1 || !safeName.MatchString(t.Name) || !filepath.IsAbs(t.Workspace) || len(t.Goal) == 0 || len(t.Goal) > 8000 || len(t.Acceptance) == 0 || len(t.Acceptance) > 30 {
		return errors.New("task-fields-invalid")
	}
	w, err := filepath.EvalSymlinks(t.Workspace)
	if err != nil || w != filepath.Clean(t.Workspace) {
		return errors.New("workspace-must-be-canonical")
	}
	for _, a := range t.Acceptance {
		if len(a) == 0 || len(a) > 2000 {
			return errors.New("acceptance-invalid")
		}
	}
	if t.TimeoutSeconds < 1 || t.TimeoutSeconds > 7200 || t.LogLimitBytes < 1024 || t.LogLimitBytes > 1024*1024 || t.MaxOperations < 1 || t.MaxOperations > 64 || t.MaxRepairCycles < 0 || t.MaxRepairCycles > 2 || len(t.Checks) == 0 || len(t.Checks) > 20 {
		return errors.New("limits-invalid")
	}
	check := func(a Action) error {
		if a.TimeoutSeconds < 1 || a.TimeoutSeconds > t.TimeoutSeconds || len(a.Instructions) > 8000 {
			return errors.New("action-invalid")
		}
		switch a.Kind {
		case "", "command":
			if !validCommand(a.Command) || a.Codex != nil {
				return errors.New("action-command-invalid")
			}
		case "codex":
			if !validCodex(a.Codex) || len(a.Command) != 0 {
				return errors.New("action-codex-invalid")
			}
		default:
			return errors.New("action-kind-invalid")
		}
		return nil
	}
	for _, a := range t.Checks {
		if a.isCodex() {
			return errors.New("checks-must-be-local-commands")
		}
		if err := check(a); err != nil {
			return err
		}
	}
	for _, a := range []*Action{t.Implement, t.Repair} {
		if a != nil {
			if err := check(*a); err != nil {
				return err
			}
		}
	}
	if t.MaxRepairCycles > 0 && t.Repair == nil {
		return errors.New("repair-required")
	}
	r := t.Review
	if r.TimeoutSeconds < 1 || r.TimeoutSeconds > t.TimeoutSeconds {
		return errors.New("review-timeout-invalid")
	}
	switch r.Kind {
	case "command":
		if !validCommand(r.Command) || r.Codex != nil {
			return errors.New("review-command-invalid")
		}
	case "codex":
		if len(r.Command) != 0 || !validCodex(r.Codex) {
			return errors.New("codex-config-invalid")
		}
	default:
		return errors.New("review-kind-invalid")
	}
	return nil
}

func parseReview(data []byte, hash string) (Review, error) {
	var r Review
	if err := strictJSON(data, &r); err != nil {
		return r, errors.New("review-json-invalid")
	}
	if !hashPattern.MatchString(r.CodeHash) || r.CodeHash != hash || r.Findings == nil || len(r.Findings) > 30 {
		return r, errors.New("review-evidence-mismatch")
	}
	for _, f := range r.Findings {
		if len(f) == 0 || len(f) > 4000 {
			return r, errors.New("review-findings-invalid")
		}
	}
	switch r.Decision {
	case "approve":
		if len(r.Findings) != 0 {
			return r, errors.New("approval-has-findings")
		}
	case "revise", "reject":
		if len(r.Findings) == 0 {
			return r, errors.New("review-findings-required")
		}
	default:
		return r, fmt.Errorf("review-decision-invalid")
	}
	return r, nil
}
