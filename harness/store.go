package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Evidence struct {
	ArtifactError  string             `json:"artifactError,omitempty"`
	Artifacts      *ArtifactReference `json:"artifacts,omitempty"`
	CheckIndex     *int               `json:"checkIndex,omitempty"`
	Model          *ModelMetadata     `json:"model,omitempty"`
	Operation      int                `json:"operation"`
	Phase          string             `json:"phase"`
	CodeHash       string             `json:"codeHash"`
	AfterHash      string             `json:"afterHash"`
	ExitCode       int                `json:"exitCode"`
	Outcome        string             `json:"outcome"`
	StartedAt      string             `json:"startedAt"`
	DurationMillis int64              `json:"durationMillis"`
	Log            string             `json:"log"`
	LogHash        string             `json:"logHash"`
}

type Pending struct {
	Dispatched     bool           `json:"dispatched"`
	ObservedHash   string         `json:"observedHash,omitempty"`
	Model          *ModelMetadata `json:"model,omitempty"`
	ProcessStopped bool           `json:"processStopped"`
	Phase          string         `json:"phase"`
	Effect         string         `json:"effect"`
	CodeHash       string         `json:"codeHash"`
	ThreadID       string         `json:"threadId,omitempty"`
	TurnID         string         `json:"turnId,omitempty"`
}

type ModelMetadata struct {
	DeniedServerRequest string         `json:"deniedServerRequest,omitempty"`
	TurnStatus          string         `json:"turnStatus,omitempty"`
	CodexErrorInfo      string         `json:"codexErrorInfo,omitempty"`
	ErrorHTTPStatus     *int           `json:"errorHttpStatus,omitempty"`
	ReportedServiceTier *string        `json:"reportedServiceTier"`
	Tokens              *TokenMetadata `json:"tokens,omitempty"`
	Role                string         `json:"role"`
	RequestedModel      string         `json:"requestedModel"`
	ResolvedModel       string         `json:"resolvedModel,omitempty"`
	Provider            string         `json:"provider,omitempty"`
	ServiceTier         string         `json:"serviceTier"`
	ThreadID            string         `json:"threadId,omitempty"`
	TurnID              string         `json:"turnId,omitempty"`
	Quota               *IncludedQuota `json:"quota,omitempty"`
}

type TokenMetadata struct {
	Input           int64 `json:"inputTokens"`
	Output          int64 `json:"outputTokens"`
	CachedInput     int64 `json:"cachedInputTokens"`
	ReasoningOutput int64 `json:"reasoningOutputTokens"`
	Total           int64 `json:"totalTokens"`
}

type Run struct {
	CurrentCodeHash   string     `json:"currentCodeHash,omitempty"`
	CurrentTaskHash   string     `json:"currentTaskHash,omitempty"`
	CurrentValidation string     `json:"currentValidation,omitempty"`
	Stale             bool       `json:"stale"`
	ID                string     `json:"id"`
	TaskPath          string     `json:"taskPath"`
	TaskHash          string     `json:"taskHash"`
	Task              Task       `json:"task"`
	Status            string     `json:"status"`
	Phase             string     `json:"phase"`
	CheckIndex        int        `json:"checkIndex"`
	Cycle             int        `json:"cycle"`
	Operations        int        `json:"operations"`
	ElapsedMillis     int64      `json:"elapsedMillis"`
	CodeHash          string     `json:"codeHash"`
	Pending           *Pending   `json:"pending,omitempty"`
	Reason            string     `json:"reason"`
	Findings          []string   `json:"findings"`
	Evidence          []Evidence `json:"evidence"`
	StopRequested     bool       `json:"stopRequested"`
}

type Store struct {
	Directory string
	DB        string
}

func OpenStore(directory string) (*Store, error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("state-must-be-absolute")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, errors.New("state-create-failed")
	}
	real, err := filepath.EvalSymlinks(directory)
	if err != nil || real != filepath.Clean(directory) {
		return nil, errors.New("state-must-be-canonical")
	}
	if err = os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	s := &Store{Directory: directory, DB: filepath.Join(directory, "runs.sqlite3")}
	f, err := os.OpenFile(s.DB, os.O_CREATE|os.O_RDWR|sysNoFollow, 0o600)
	if err != nil {
		return nil, errors.New("state-open-failed")
	}
	f.Close()
	if err = os.Chmod(s.DB, 0o600); err != nil {
		return nil, err
	}
	_, err = s.sql(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL);`)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func (s *Store) sql(query string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/sqlite3", "-batch", "-bail", "-json", "-cmd", ".timeout 5000", s.DB)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	cmd.Stdin = strings.NewReader(query)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, errors.New("ledger-operation-failed")
	}
	return out.Bytes(), nil
}

func (s *Store) Save(r *Run, create bool) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	statement := "UPDATE runs SET body=" + quote(string(data)) + " WHERE id=" + quote(r.ID) + ";"
	if create {
		statement = "INSERT INTO runs(id,body) VALUES(" + quote(r.ID) + "," + quote(string(data)) + ");"
	}
	_, err = s.sql("BEGIN IMMEDIATE;" + statement + "INSERT INTO events(run_id,at,event) VALUES(" + quote(r.ID) + "," + quote(time.Now().UTC().Format(time.RFC3339Nano)) + "," + quote(r.Status+":"+r.Phase+":"+r.Reason) + ");COMMIT;")
	return err
}

func (s *Store) Load(id string) (*Run, error) {
	if !safeName.MatchString(id) {
		return nil, errors.New("run-id-invalid")
	}
	data, err := s.sql("SELECT body,stop_requested FROM runs WHERE id=" + quote(id) + ";")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Body string `json:"body"`
		Stop int    `json:"stop_requested"`
	}
	if json.Unmarshal(data, &rows) != nil || len(rows) != 1 {
		return nil, errors.New("run-not-found")
	}
	var r Run
	if strictJSON([]byte(rows[0].Body), &r) != nil || r.ID != id || r.Task.validate() != nil {
		return nil, errors.New("ledger-invalid")
	}
	canonical, _ := json.Marshal(r.Task)
	if digest(canonical) != r.TaskHash {
		return nil, errors.New("ledger-task-modified")
	}
	validPhase := r.Phase == "implement" || r.Phase == "checks" || r.Phase == "review" || r.Phase == "repair"
	if !validPhase || r.CheckIndex < 0 || r.CheckIndex > len(r.Task.Checks) || (r.Phase == "checks" && r.CheckIndex == len(r.Task.Checks)) || r.Operations < 0 || r.Operations > r.Task.MaxOperations || r.Cycle < 0 || r.Cycle > r.Task.MaxRepairCycles || r.ElapsedMillis < 0 || len(r.Evidence) > 64 || !hashPattern.MatchString(r.CodeHash) {
		return nil, errors.New("ledger-state-invalid")
	}
	for _, proof := range r.Evidence {
		if proof.CheckIndex != nil && (proof.Phase != "checks" || *proof.CheckIndex < 0 || *proof.CheckIndex >= len(r.Task.Checks)) {
			return nil, errors.New("ledger-evidence-invalid")
		}
	}
	r.StopRequested = rows[0].Stop != 0
	return &r, nil
}

func (s *Store) Stop(id string) error {
	if _, err := s.Load(id); err != nil {
		return err
	}
	_, err := s.sql("UPDATE runs SET stop_requested=1 WHERE id=" + quote(id) + ";")
	return err
}

func (s *Store) clearStop(id string) error {
	_, err := s.sql("UPDATE runs SET stop_requested=0 WHERE id=" + quote(id) + ";")
	return err
}
