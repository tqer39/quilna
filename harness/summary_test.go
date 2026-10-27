package harness

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func checkProof(operation, index int, hash string) Evidence {
	return Evidence{Operation: operation, CheckIndex: &index, Phase: "checks", CodeHash: hash, AfterHash: hash, ExitCode: 0, Outcome: "complete", Log: "run/check.json", LogHash: strings.Repeat("a", 64)}
}

func TestLatestCheckEvidenceKeepsAllLatestChecksAndRefusesStaleSource(t *testing.T) {
	r := &Run{CodeHash: "new", Evidence: []Evidence{
		checkProof(1, 0, "old"), {Operation: 2, Phase: "repair"},
		checkProof(3, 0, "new"), checkProof(4, 1, "new"), checkProof(5, 1, "new"),
		{Operation: 6, Phase: "review"},
	}}
	r.Evidence[3].Outcome = "interrupted"
	got := latestCheckEvidence(r)
	if len(got) != 2 || got[0].Operation != 3 || got[1].Operation != 5 {
		t.Fatalf("wrong latest checks: %+v", got)
	}
	r.CodeHash = "another"
	if got := latestCheckEvidence(r); len(got) != 0 {
		t.Fatalf("stale checks reused: %+v", got)
	}
	r.CodeHash = "new"
	r.Evidence[2].CheckIndex = nil
	r.Evidence[3].CheckIndex = nil
	r.Evidence[4].CheckIndex = nil
	if got := latestCheckEvidence(r); len(got) != 3 {
		t.Fatalf("legacy unknown indices silently discarded: %+v", got)
	}
}

func TestSummaryDeduplicatesRecoveredTurnCountersAndReportsUnknownCoverage(t *testing.T) {
	model := func(total int64) *ModelMetadata {
		return &ModelMetadata{ThreadID: "thread", TurnID: "turn", Tokens: &TokenMetadata{Input: total - 10, Output: 10, CachedInput: total - 20, Total: total}}
	}
	r := &Run{Operations: 8, Cycle: 1, ElapsedMillis: 123, Evidence: []Evidence{
		checkProof(1, 0, "same"), {Operation: 2, Phase: "review", Model: model(100)},
		{Operation: 3, Phase: "review-recovery", Model: model(150)},
		{Operation: 4, Phase: "review-recovery", Model: model(120)},
		checkProof(5, 0, "same"), {Operation: 6, Phase: "review", Model: &ModelMetadata{ThreadID: "thread2", TurnID: "turn2"}},
		{Operation: 7, Phase: "review", Model: &ModelMetadata{}},
	}}
	r.Evidence[0].ExitCode = 1
	r.Evidence[0].Outcome = "command-failed"
	s, err := summarizeHistory(r)
	if err != nil {
		t.Fatal(err)
	}
	if s.ModelOperations != 5 || s.ModelTurns != 2 || s.TurnsWithTokenCounters != 1 || s.UnidentifiedModelOperations != 1 || s.RecordedTokens.Total != 150 {
		t.Fatalf("counter duplication or unknown usage treated as zero: %+v", s)
	}
	if s.CheckOperations != 2 || s.FailedCheckOperations != 1 || s.RepeatedCheckOperations == nil || *s.RepeatedCheckOperations != 1 {
		t.Fatalf("check history lost: %+v", s)
	}
	r.Evidence[0].CheckIndex = nil
	s, err = summarizeHistory(r)
	if err != nil || s.RepeatedCheckOperations != nil {
		t.Fatalf("legacy repeated count invented: %+v %v", s, err)
	}
}

func TestSummaryShowsTamperedEvidenceAsStaleAndUsesHashLinkedLogReferences(t *testing.T) {
	e, path, _ := fixture(t)
	r, err := e.New(path)
	if err != nil {
		t.Fatal(err)
	}
	r, err = e.Execute(context.Background(), r.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	s, err := e.Summary(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Stale || s.Status != "accepted" || len(s.Checks) != 1 || s.Checks[0].CheckIndex == nil || s.History.RecordedTokens != nil {
		t.Fatalf("unexpected summary: %+v", s)
	}
	proof := s.Checks[0]
	if !filepath.IsAbs(proof.Log) || proof.LogHash == "" || proof.CodeHash != r.CodeHash {
		t.Fatalf("missing provenance: %+v", proof)
	}
	if err := os.WriteFile(proof.Log, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err = e.Summary(r.ID)
	if err != nil || !s.Stale || s.CurrentValidation != "evidence-modified" {
		t.Fatalf("tampering hidden: %+v %v", s, err)
	}
}

func TestReviewContextReductionRetainsEarlierFailureCounts(t *testing.T) {
	r := &Run{CodeHash: "same", Cycle: 2}
	for i := 0; i < 3; i++ {
		p := checkProof(i*3+1, 0, "same")
		if i < 2 {
			p.ExitCode = 1
			p.Outcome = "command-failed"
		}
		r.Evidence = append(r.Evidence, p)
		if i < 2 {
			r.Evidence = append(r.Evidence, Evidence{Operation: i*3 + 2, Phase: "review"}, Evidence{Operation: i*3 + 3, Phase: "repair"})
		}
	}
	all, _ := json.Marshal(r.Evidence)
	current, _ := json.Marshal(latestCheckEvidence(r))
	history, err := summarizeHistory(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(current) >= len(all) || history.FailedCheckOperations != 2 || history.RepairCycles != 2 {
		t.Fatal("history concealed while shrinking prompt")
	}
	t.Logf("synthetic evidence JSON: all history %d bytes; latest checks %d bytes; failure/repair counts retained separately", len(all), len(current))
}

func TestMalformedCheckIndexIsRejectedFromLedger(t *testing.T) {
	for _, index := range []int{-1, 1} {
		e, path, _ := fixture(t)
		r, err := e.New(path)
		if err != nil {
			t.Fatal(err)
		}
		r, err = e.Execute(context.Background(), r.ID, false)
		if err != nil {
			t.Fatal(err)
		}
		r.Evidence[0].CheckIndex = &index
		if err := e.Store.Save(r, false); err != nil {
			t.Fatal(err)
		}
		if _, err := e.Store.Load(r.ID); err == nil || err.Error() != "ledger-evidence-invalid" {
			t.Fatalf("invalid index accepted: %v", err)
		}
	}
}

func TestUsageIdentityDoesNotConfuseOpaqueIDsContainingSeparators(t *testing.T) {
	r := &Run{Evidence: []Evidence{
		{Model: &ModelMetadata{ThreadID: "a/b", TurnID: "c", Tokens: &TokenMetadata{Total: 10}}},
		{Model: &ModelMetadata{ThreadID: "a", TurnID: "b/c", Tokens: &TokenMetadata{Total: 20}}},
	}}
	s, err := summarizeHistory(r)
	if err != nil || s.ModelTurns != 2 || s.RecordedTokens == nil || s.RecordedTokens.Total != 30 {
		t.Fatalf("opaque identity collision: %+v %v", s, err)
	}
}
