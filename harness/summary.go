package harness

import (
	"errors"
	"math"
	"path/filepath"
)

// CheckSummary deliberately contains references rather than raw logs.
type CheckSummary struct {
	Operation      int    `json:"operation"`
	CheckIndex     *int   `json:"checkIndex,omitempty"`
	CodeHash       string `json:"codeHash"`
	ExitCode       int    `json:"exitCode"`
	Outcome        string `json:"outcome"`
	DurationMillis int64  `json:"durationMillis"`
	Log            string `json:"log"`
	LogHash        string `json:"logHash"`
}

type HistorySummary struct {
	Operations                  int            `json:"operations"`
	ElapsedMillis               int64          `json:"elapsedMillis"`
	RepairCycles                int            `json:"repairCycles"`
	CheckOperations             int            `json:"checkOperations"`
	FailedCheckOperations       int            `json:"failedCheckOperations"`
	RepeatedCheckOperations     *int           `json:"repeatedCheckOperations"`
	ModelOperations             int            `json:"modelOperations"`
	UnidentifiedModelOperations int            `json:"unidentifiedModelOperations"`
	ModelTurns                  int            `json:"modelTurns"`
	TurnsWithTokenCounters      int            `json:"turnsWithTokenCounters"`
	RecordedTokens              *TokenMetadata `json:"recordedTokens"`
}

type RunSummary struct {
	Phase             string         `json:"phase"`
	PendingOperation  bool           `json:"pendingOperation"`
	ID                string         `json:"id"`
	Status            string         `json:"status"`
	Reason            string         `json:"reason"`
	Stale             bool           `json:"stale"`
	CurrentValidation string         `json:"currentValidation,omitempty"`
	CodeHash          string         `json:"codeHash"`
	CurrentCodeHash   string         `json:"currentCodeHash"`
	TaskHash          string         `json:"taskHash"`
	Findings          []string       `json:"findings"`
	Checks            []CheckSummary `json:"checks"`
	History           HistorySummary `json:"history"`
}

// latestCheckEvidence retains the most recent check attempt for each index in
// the latest check cycle. Legacy evidence without indices is retained as-is.
// It never substitutes checks from another source hash.
func latestCheckEvidence(r *Run) []Evidence {
	end := -1
	for i := len(r.Evidence) - 1; i >= 0; i-- {
		if r.Evidence[i].Phase == "checks" {
			end = i
			break
		}
	}
	if end < 0 {
		return nil
	}
	start := end
	for start > 0 && r.Evidence[start-1].Phase == "checks" {
		start--
	}
	last := map[int]int{}
	for i := start; i <= end; i++ {
		p := r.Evidence[i]
		if p.CheckIndex != nil {
			last[*p.CheckIndex] = i
		}
	}
	var result []Evidence
	for i := start; i <= end; i++ {
		p := r.Evidence[i]
		if p.CodeHash != r.CodeHash || p.AfterHash != r.CodeHash {
			continue
		}
		if p.CheckIndex != nil && last[*p.CheckIndex] != i {
			continue
		}
		result = append(result, p)
	}
	return result
}

func summarizeHistory(r *Run) (HistorySummary, error) {
	result := HistorySummary{Operations: r.Operations, ElapsedMillis: r.ElapsedMillis, RepairCycles: r.Cycle}
	seenChecks := map[string]map[int]bool{}
	repeated := 0
	indicesKnown := true
	turns := map[[2]string]*TokenMetadata{}
	for _, p := range r.Evidence {
		if p.Phase == "checks" {
			result.CheckOperations++
			if p.ExitCode != 0 || p.Outcome != "complete" {
				result.FailedCheckOperations++
			}
			if p.CheckIndex == nil {
				indicesKnown = false
			} else {
				if seenChecks[p.CodeHash] == nil {
					seenChecks[p.CodeHash] = map[int]bool{}
				}
				if seenChecks[p.CodeHash][*p.CheckIndex] {
					repeated++
				}
				seenChecks[p.CodeHash][*p.CheckIndex] = true
			}
		}
		if p.Model == nil {
			continue
		}
		result.ModelOperations++
		key := [2]string{p.Model.ThreadID, p.Model.TurnID}
		if p.Model.ThreadID == "" || p.Model.TurnID == "" {
			// Missing identity cannot safely be counted as a unique turn.
			result.UnidentifiedModelOperations++
			continue
		}
		if _, ok := turns[key]; !ok {
			turns[key] = nil
		}
		if p.Model.Tokens != nil && (turns[key] == nil || p.Model.Tokens.Total >= turns[key].Total) {
			turns[key] = p.Model.Tokens
		}
	}
	if indicesKnown {
		result.RepeatedCheckOperations = &repeated
	}
	result.ModelTurns = len(turns)
	var totals TokenMetadata
	add := func(a *int64, b int64) error {
		if b < 0 || *a > math.MaxInt64-b {
			return errors.New("token-counter-invalid")
		}
		*a += b
		return nil
	}
	for _, t := range turns {
		if t == nil {
			continue
		}
		for _, pair := range []struct {
			a *int64
			b int64
		}{{&totals.Input, t.Input}, {&totals.Output, t.Output}, {&totals.CachedInput, t.CachedInput}, {&totals.ReasoningOutput, t.ReasoningOutput}, {&totals.Total, t.Total}} {
			if err := add(pair.a, pair.b); err != nil {
				return result, err
			}
		}
		result.TurnsWithTokenCounters++
	}
	if result.TurnsWithTokenCounters > 0 {
		result.RecordedTokens = &totals
	}
	return result, nil
}

func (e Engine) Summary(id string) (RunSummary, error) {
	var summary RunSummary
	r, err := e.Status(id)
	if err != nil {
		return summary, err
	}
	history, err := summarizeHistory(r)
	if err != nil {
		return summary, err
	}
	summary = RunSummary{ID: r.ID, Status: r.Status, Phase: r.Phase, PendingOperation: r.Pending != nil, Reason: r.Reason, Stale: r.Stale, CurrentValidation: r.CurrentValidation, CodeHash: r.CodeHash, CurrentCodeHash: r.CurrentCodeHash, TaskHash: r.TaskHash, Findings: r.Findings, History: history, Checks: []CheckSummary{}}
	for _, p := range latestCheckEvidence(r) {
		summary.Checks = append(summary.Checks, CheckSummary{Operation: p.Operation, CheckIndex: p.CheckIndex, CodeHash: p.CodeHash, ExitCode: p.ExitCode, Outcome: p.Outcome, DurationMillis: p.DurationMillis, Log: filepath.Join(e.Store.Directory, p.Log), LogHash: p.LogHash})
	}
	return summary, nil
}
