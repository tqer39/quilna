package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// This child runs real subprocess paths with a scrubbed environment.
func TestHelper(t *testing.T) {
	i := 0
	for i < len(os.Args) && os.Args[i] != "--" {
		i++
	}
	if i == len(os.Args) {
		return
	}
	args := os.Args[i+1:]
	if len(args) == 0 {
		os.Exit(2)
	}
	switch args[0] {
	case "check":
		if len(args) > 1 && args[1] == "slow" {
			time.Sleep(600 * time.Millisecond)
		}
		if len(args) > 1 && args[1] == "content" {
			data, _ := os.ReadFile("code.txt")
			if string(data) != "fixed" {
				fmt.Println("expected fixed")
				os.Exit(1)
			}
		}
		if os.Getenv("TEST_SECRET_TOKEN") != "" || os.Getenv("OPENAI_API_KEY") != "" {
			os.Exit(3)
		}
		fmt.Println("checked")
		os.Exit(0)
	case "repair":
		if args[1] != "noop" {
			_ = os.WriteFile("code.txt", []byte("fixed"), 0o600)
		}
		os.Exit(0)
	case "review":
		var input struct {
			CodeHash string          `json:"codeHash"`
			Evidence []Evidence      `json:"evidence"`
			History  *HistorySummary `json:"history"`
		}
		_ = json.NewDecoder(os.Stdin).Decode(&input)
		r := Review{Decision: "approve", CodeHash: input.CodeHash, Findings: []string{}}
		switch args[1] {
		case "summary-context":
			if len(input.Evidence) != 1 || input.Evidence[0].Phase != "checks" || input.Evidence[0].ExitCode != 0 || input.Evidence[0].CodeHash != input.CodeHash || input.History == nil || input.History.CheckOperations != 2 || input.History.FailedCheckOperations != 1 || input.History.RepairCycles != 1 {
				r.Decision = "reject"
				r.Findings = []string{"current checks or failed history missing from reviewer input"}
			}
		case "invalid":
			fmt.Println("looks fine")
			os.Exit(0)
		case "mismatch":
			r.CodeHash = strings.Repeat("a", 64)
		case "always-revise":
			r.Decision = "revise"
			r.Findings = []string{"needs change"}
		case "by-content":
			data, _ := os.ReadFile("code.txt")
			if string(data) != "fixed" {
				r.Decision = "revise"
				r.Findings = []string{"fix code.txt"}
			}
		case "mutate":
			_ = os.WriteFile("code.txt", []byte("reviewer changed code"), 0o600)
		}
		_ = json.NewEncoder(os.Stdout).Encode(r)
		os.Exit(0)
	case "appserver":
		expected := []string{"app-server", "--listen", "stdio://", "-c", fmt.Sprintf("model_provider=%q", "openai"), "-c", fmt.Sprintf("approval_policy=%q", "untrusted"), "-c", fmt.Sprintf("sandbox_mode=%q", "read-only"), "-c", fmt.Sprintf("shell_environment_policy.inherit=%q", "none")}
		expected = append(expected, "-c", fmt.Sprintf("forced_login_method=%q", "chatgpt"), "-c", fmt.Sprintf("service_tier=%q", "default"), "-c", fmt.Sprintf("web_search=%q", "disabled"), "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.multi_agent=false", "-c", "features.hooks=false", "-c", "notify=[]")
		if strings.Join(args[2:], "\x00") != strings.Join(expected, "\x00") {
			os.Exit(7)
		}
		fakeAppServer(args[1])
		os.Exit(0)
	}
	os.Exit(2)
}

func helper(role string, args ...string) []string {
	binary, _ := os.Executable()
	return append([]string{binary, "-test.run=TestHelper", "--", role}, args...)
}
func action(role string, args ...string) Action {
	return Action{Command: helper(role, args...), TimeoutSeconds: 3}
}

func fixture(t *testing.T) (Engine, string, Task) {
	t.Helper()
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	workspace := filepath.Join(root, "repo")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/usr/bin/git", "init", "-q", workspace)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %s %v", out, err)
	}
	_ = os.WriteFile(filepath.Join(workspace, "code.txt"), []byte("initial"), 0o600)
	store, err := OpenStore(filepath.Join(root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	task := Task{Version: 1, Name: "test", Workspace: workspace, Goal: "a verified local change", Acceptance: []string{"checks pass and reviewer agrees"}, Checks: []Action{action("check")}, Review: Reviewer{Kind: "command", Command: helper("review", "approve"), TimeoutSeconds: 3}, MaxRepairCycles: 0, TimeoutSeconds: 20, LogLimitBytes: 16384, MaxOperations: 20}
	path := filepath.Join(root, "task.json")
	writeTask(t, path, task)
	return Engine{Store: store}, path, task
}
func writeTask(t *testing.T, path string, task Task) {
	t.Helper()
	data, _ := json.Marshal(task)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
func newRun(t *testing.T, e Engine, path string) *Run {
	t.Helper()
	r, err := e.New(path)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func executeRun(t *testing.T, e Engine, r *Run) *Run {
	t.Helper()
	got, err := e.Execute(context.Background(), r.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestStrictTasks(t *testing.T) {
	e, path, task := fixture(t)
	_ = e
	data, _ := json.Marshal(task)
	for name, invalid := range map[string][]byte{"unknown": []byte(strings.TrimSuffix(string(data), "}") + `,"surprise":true}`), "duplicate": []byte(strings.TrimSuffix(string(data), "}") + `,"name":"other"}`), "trailing": append(data, []byte(" {}")...)} {
		t.Run(name, func(t *testing.T) {
			_ = os.WriteFile(path, invalid, 0o600)
			if _, _, _, err := LoadTask(path); err == nil {
				t.Fatal("accepted malformed task")
			}
		})
	}
	task.MaxRepairCycles = 3
	writeTask(t, path, task)
	if _, _, _, err := LoadTask(path); err == nil {
		t.Fatal("unbounded repairs")
	}
}

func TestOfflineChecksReviewEvidenceAndNoSecretInheritance(t *testing.T) {
	t.Setenv("TEST_SECRET_TOKEN", "private-test-value")
	t.Setenv("OPENAI_API_KEY", "private-placeholder")
	e, path, _ := fixture(t)
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "accepted" || len(r.Evidence) != 2 {
		t.Fatalf("%+v", r)
	}
	for _, proof := range r.Evidence {
		if proof.ExitCode != 0 || proof.CodeHash != r.CodeHash || proof.LogHash == "" {
			t.Fatalf("invalid proof %+v", proof)
		}
	}
	info, _ := os.Stat(e.Store.DB)
	if info.Mode().Perm() != 0o600 {
		t.Fatal("unsafe DB permissions")
	}
	// A completed run cannot use modified evidence as a valid acceptance proof.
	_ = os.WriteFile(filepath.Join(e.Store.Directory, r.Evidence[0].Log), []byte("changed"), 0o600)
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "evidence-modified" {
		t.Fatalf("tampered evidence: %v", err)
	}
}

func TestCheckAndReviewRepairLoops(t *testing.T) {
	for _, mode := range []string{"check-failure", "review-revision"} {
		t.Run(mode, func(t *testing.T) {
			e, path, task := fixture(t)
			repair := action("repair", "fix")
			task.Repair = &repair
			task.MaxRepairCycles = 2
			if mode == "check-failure" {
				task.Checks = []Action{action("check", "content")}
			} else {
				task.Review.Command = helper("review", "by-content")
			}
			writeTask(t, path, task)
			r := executeRun(t, e, newRun(t, e, path))
			if r.Status != "accepted" || r.Cycle != 1 {
				t.Fatalf("%+v", r)
			}
		})
	}
	t.Run("repair-cap", func(t *testing.T) {
		e, path, task := fixture(t)
		repair := action("repair", "noop")
		task.Repair = &repair
		task.MaxRepairCycles = 2
		task.Review.Command = helper("review", "always-revise")
		writeTask(t, path, task)
		r := executeRun(t, e, newRun(t, e, path))
		if r.Status != "blocked" || r.Reason != "repair-budget-exhausted" || r.Cycle != 2 {
			t.Fatalf("%+v", r)
		}
	})
}

func TestInvalidReviewsNeverAccept(t *testing.T) {
	for _, mode := range []string{"invalid", "mismatch", "mutate"} {
		t.Run(mode, func(t *testing.T) {
			e, path, task := fixture(t)
			task.Review.Command = helper("review", mode)
			writeTask(t, path, task)
			r := executeRun(t, e, newRun(t, e, path))
			if r.Status != "blocked" {
				t.Fatalf("accepted invalid review: %+v", r)
			}
		})
	}
}

func waitPending(t *testing.T, e Engine, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := e.Store.Load(id)
		if err == nil && r.Pending != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("operation never started")
}

func TestStopResumeAndLocks(t *testing.T) {
	e, path, task := fixture(t)
	task.Checks = []Action{action("check", "slow")}
	writeTask(t, path, task)
	r := newRun(t, e, path)
	finished := make(chan *Run, 1)
	errs := make(chan error, 1)
	go func() { got, err := e.Execute(context.Background(), r.ID, false); finished <- got; errs <- err }()
	waitPending(t, e, r.ID)
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "already-running" {
		t.Fatalf("duplicate run: %v", err)
	}
	// Different databases still share the canonical-workspace editing lock.
	otherStore, err := OpenStore(filepath.Join(filepath.Dir(path), "other-state"))
	if err != nil {
		t.Fatal(err)
	}
	other := Engine{Store: otherStore}
	otherRun := newRun(t, other, path)
	if _, err := other.Execute(context.Background(), otherRun.ID, false); err == nil || err.Error() != "already-running" {
		t.Fatalf("cross-store workspace lock: %v", err)
	}
	if err := e.Store.Stop(r.ID); err != nil {
		t.Fatal(err)
	}
	stopped := <-finished
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if stopped.Status != "stopped" || stopped.Pending == nil {
		t.Fatalf("lost checkpoint: %+v", stopped)
	}
	r = executeRun(t, e, stopped)
	if r.Status != "accepted" {
		t.Fatalf("resume: %+v", r)
	}
}

func TestResumeRefusesTaskAndCodeChanges(t *testing.T) {
	for _, mode := range []string{"task", "code"} {
		t.Run(mode, func(t *testing.T) {
			e, path, task := fixture(t)
			r := newRun(t, e, path)
			if mode == "task" {
				task.Goal = "changed"
				writeTask(t, path, task)
			} else {
				_ = os.WriteFile(filepath.Join(task.Workspace, "code.txt"), []byte("changed"), 0o600)
			}
			if _, err := e.Execute(context.Background(), r.ID, false); err == nil {
				t.Fatal("resumed modified task/code")
			}
		})
	}
}

func TestTerminalAcceptanceCannotBeReusedAfterCodeDeletion(t *testing.T) {
	e, path, task := fixture(t)
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "accepted" {
		t.Fatal(r.Status)
	}
	_ = os.Remove(filepath.Join(task.Workspace, "code.txt"))
	status, err := e.Status(r.ID)
	if err != nil || !status.Stale || status.Status != "accepted" {
		t.Fatalf("historical status did not flag stale proof: %+v %v", status, err)
	}
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "code-modified-since-checkpoint" {
		t.Fatalf("stale acceptance: %v", err)
	}
}

func TestUnknownLocalEditRequiresReconciliationAndDoesNotReplay(t *testing.T) {
	e, path, task := fixture(t)
	r := newRun(t, e, path)
	r.Pending = &Pending{Phase: "implement", Effect: "local-edit", CodeHash: r.CodeHash}
	r.Status = "stopped"
	r.Phase = "implement"
	r.Operations = 1
	_ = e.Store.Save(r, false)
	_ = os.WriteFile(filepath.Join(task.Workspace, "code.txt"), []byte("partial edit"), 0o600)
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil {
		t.Fatal("replayed unknown edit")
	}
	got, err := e.Execute(context.Background(), r.ID, true)
	if err != nil || got.Status != "accepted" {
		t.Fatalf("reconcile: %+v %v", got, err)
	}
}

func TestCrashVerificationNeedsProcessReconciliation(t *testing.T) {
	e, path, _ := fixture(t)
	r := newRun(t, e, path)
	r.Status = "stopped"
	r.Pending = &Pending{Phase: "checks", Effect: "verification", CodeHash: r.CodeHash}
	_ = e.Store.Save(r, false)
	if _, err := e.Execute(context.Background(), r.ID, false); err == nil || err.Error() != "process-state-unknown-inspect-and-use-reconcile-local" {
		t.Fatalf("unconfirmed child replay: %v", err)
	}
	got, err := e.Execute(context.Background(), r.ID, true)
	if err != nil || got.Status != "accepted" {
		t.Fatalf("reconciled verification: %+v %v", got, err)
	}
}

func TestOperationLimitAndIgnoredState(t *testing.T) {
	e, path, task := fixture(t)
	task.MaxOperations = 1
	writeTask(t, path, task)
	r := executeRun(t, e, newRun(t, e, path))
	if r.Status != "blocked" || r.Reason != "operation-budget-exhausted" {
		t.Fatalf("%+v", r)
	}
	_ = os.WriteFile(filepath.Join(task.Workspace, ".gitignore"), []byte(".local-state/\n"), 0o600)
	store, err := OpenStore(filepath.Join(task.Workspace, ".local-state", "harness"))
	if err != nil {
		t.Fatal(err)
	}
	e = Engine{Store: store}
	task.MaxOperations = 5
	writeTask(t, path, task)
	if r := executeRun(t, e, newRun(t, e, path)); r.Status != "accepted" {
		t.Fatalf("ignored state changes hash: %+v", r)
	}
}

func TestNestedWorkspaceCannotBypassEditingLock(t *testing.T) {
	e, path, task := fixture(t)
	nested := filepath.Join(task.Workspace, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	task.Workspace = nested
	writeTask(t, path, task)
	if _, err := e.New(path); err == nil || err.Error() != "workspace-must-be-git-root" {
		t.Fatalf("nested workspace accepted: %v", err)
	}
	if _, err := workspaceLock(nested); err == nil || err.Error() != "workspace-must-be-git-root" {
		t.Fatalf("nested editing lock accepted: %v", err)
	}
}

func TestProcessGroupCancellationAndOrphanPipes(t *testing.T) {
	for _, script := range []string{"sleep 30 & echo $!; wait", "sleep 30 & echo $!; exit 0"} {
		t.Run(script, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			result := execute(ctx, t.TempDir(), Action{Command: []string{"/bin/sh", "-c", script}, TimeoutSeconds: 2}, nil, 1024, nil)
			if result.duration > 2*time.Second || result.outcome == "complete" {
				t.Fatalf("unbounded process: %+v", result)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(result.stdout)))
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				if syscall.Kill(pid, 0) == syscall.ESRCH {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			// Linux may retain a terminated grandchild as a zombie until PID 1 reaps it.
			out, _ := exec.Command("/bin/ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
			if !strings.HasPrefix(strings.TrimSpace(string(out)), "Z") {
				t.Fatalf("grandchild survives: %s", out)
			}
		})
	}
}

func TestLogBoundAndRedaction(t *testing.T) {
	r := execute(context.Background(), t.TempDir(), Action{Command: []string{"/bin/sh", "-c", "while :; do echo bounded; done"}, TimeoutSeconds: 3}, nil, 1024, nil)
	if r.outcome != "log-limit" || len(r.stdout)+len(r.stderr) > 1024 {
		t.Fatalf("log limit %+v", r)
	}
	path := filepath.Join(t.TempDir(), "log.json")
	_, err := writeEvidenceLog(path, processResult{stdout: []byte("TOKEN=private-placeholder sk-abcdefghijklmnop Bearer abcdefghijklmnop")})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "private-placeholder") || strings.Contains(string(data), "abcdefghijklmnop") {
		t.Fatal("secret retained")
	}
}

// A real child binary emulates the app-server protocol without network or a model.
func fakeQuota(mode string) map[string]any {
	credits := map[string]any{"hasCredits": false, "unlimited": false}
	window := map[string]any{"usedPercent": 7, "windowDurationMins": 10080, "resetsAt": time.Now().Add(time.Hour).Unix()}
	bucket := map[string]any{"planType": "prolite", "primary": window, "secondary": nil, "credits": credits, "spendControlReached": nil, "rateLimitReachedType": nil}
	switch mode {
	case "quota-credit":
		credits["hasCredits"] = true
	case "quota-unlimited":
		credits["unlimited"] = true
	case "quota-credit-unknown":
		bucket["credits"] = nil
	case "quota-exhausted":
		window["usedPercent"] = 80
	case "quota-window-unknown":
		window["usedPercent"] = nil
	case "quota-reset-expired":
		window["resetsAt"] = time.Now().Add(-time.Second).Unix()
	case "quota-spend-reached":
		bucket["spendControlReached"] = true
	case "quota-reached":
		bucket["rateLimitReachedType"] = "rate_limit_reached"
	}
	buckets := map[string]any{"codex": bucket}
	if mode == "quota-other-bucket" {
		buckets["other"] = map[string]any{"primary": map[string]any{"usedPercent": 95, "windowDurationMins": 60, "resetsAt": time.Now().Add(time.Hour).Unix()}, "credits": credits}
	}
	return map[string]any{"rateLimits": bucket, "rateLimitsByLimitId": buckets}
}

func fakeAppServer(mode string) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	threadID := "thread-" + strconv.Itoa(os.Getpid())
	turnID := "turn-test"
	hash := ""
	initialized := false
	role := "review"
	activeReadProfile := ""
	send := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	for scanner.Scan() {
		var m struct {
			ID     any             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(3)
		}
		if m.Method == "initialize" {
			var init struct {
				Capabilities struct {
					Experimental bool `json:"experimentalApi"`
				} `json:"capabilities"`
			}
			_ = json.Unmarshal(m.Params, &init)
			if strings.HasPrefix(mode, "restricted") && !init.Capabilities.Experimental {
				os.Exit(17)
			}
			if mode == "protocol-initial-stream" || mode == "protocol-initial-queue" {
				for i := 0; i < 24; i++ {
					send(map[string]any{"method": "ignored/progress", "params": map[string]any{"data": strings.Repeat("q", 1024)}})
				}
			}
			if mode == "protocol-initial-message" {
				fmt.Fprint(os.Stdout, strings.Repeat("x", 16384))
				os.Stdout.Close()
				continue
			}
			initialized = true
			send(map[string]any{"id": m.ID, "result": map[string]any{"userAgent": "fake"}})
			continue
		}
		if !initialized {
			os.Exit(4)
		}
		switch m.Method {
		case "initialized":
			continue
		case "account/read":
			kind := "chatgpt"
			if mode == "api" {
				kind = "apiKey"
			}
			send(map[string]any{"id": m.ID, "result": map[string]any{"account": map[string]any{"type": kind, "planType": "prolite"}}})
		case "config/read":
			send(map[string]any{"id": m.ID, "result": map[string]any{"config": map[string]any{"permissions": map[string]any{"existing-profile": map[string]any{"filesystem": map[string]any{":root": "read"}}}, "mcp_servers": map[string]any{"dangerous": map[string]any{"command": "DO-NOT-RUN", "env": map[string]any{"API_KEY": "sensitive-config-placeholder"}}}, "plugins": map[string]any{"risk@local": map[string]any{"enabled": true}}, "hooks": map[string]any{"SessionStart": []any{map[string]any{"command": "DO-NOT-RUN"}}, "state": map[string]any{"hook-id": map[string]any{"enabled": true, "trusted_hash": "sensitive-config-placeholder"}}}, "shell_environment_policy": map[string]any{"set": map[string]any{"API_KEY": "sensitive-config-placeholder"}}}}})
		case "account/rateLimits/read":
			if string(m.Params) != "null" {
				os.Exit(11)
			}
			send(map[string]any{"id": m.ID, "result": fakeQuota(mode)})
		case "thread/start":
			var p struct {
				Model       string `json:"model"`
				Provider    string `json:"modelProvider"`
				Tier        string `json:"serviceTier"`
				Permissions string `json:"permissions"`
				Sandbox     string `json:"sandbox"`
				Config      struct {
					MCP map[string]struct {
						Enabled bool `json:"enabled"`
					} `json:"mcp_servers"`
					Plugins map[string]struct {
						Enabled bool `json:"enabled"`
					} `json:"plugins"`
					Hooks struct {
						SessionStart []json.RawMessage `json:"SessionStart"`
						State        map[string]struct {
							Enabled *bool `json:"enabled"`
						} `json:"state"`
					} `json:"hooks"`
					Shell struct {
						Set     map[string]string `json:"set"`
						Profile bool              `json:"experimental_use_profile"`
					} `json:"shell_environment_policy"`
					Web         string `json:"web_search"`
					Permissions map[string]struct {
						Filesystem map[string]string `json:"filesystem"`
						Network    struct {
							Enabled bool `json:"enabled"`
						} `json:"network"`
					} `json:"permissions"`
					Tools struct {
						ViewImage *bool `json:"view_image"`
					} `json:"tools"`
				} `json:"config"`
			}
			if json.Unmarshal(m.Params, &p) != nil {
				os.Exit(12)
			}
			_, hasMCP := p.Config.MCP["dangerous"]
			_, hasPlugin := p.Config.Plugins["risk@local"]
			_, hasSet := p.Config.Shell.Set["API_KEY"]
			_, hasHookState := p.Config.Hooks.State["hook-id"]
			if !hasMCP || !hasPlugin || !hasSet || hasHookState || len(p.Config.Hooks.SessionStart) != 0 || p.Tier != "default" || p.Provider != "openai" || p.Config.Web != "disabled" || p.Config.MCP["dangerous"].Enabled || p.Config.Plugins["risk@local"].Enabled || p.Config.Shell.Profile || p.Config.Shell.Set["API_KEY"] != "" {
				os.Exit(9)
			}
			provider := "openai"
			resolved := p.Model
			tier := "default"
			if mode == "wrong-provider" {
				provider = "other"
			}
			if mode == "wrong-model" {
				resolved = "other-model"
			}
			if mode == "fast-tier" {
				tier = "fast"
			}
			response := map[string]any{"thread": map[string]any{"id": threadID}, "model": resolved, "modelProvider": provider, "serviceTier": tier}
			if strings.HasPrefix(mode, "restricted") {
				cwd, _ := os.Getwd()
				profile, ok := p.Config.Permissions[p.Permissions]
				if !ok || p.Permissions == "" || p.Sandbox != "" || len(p.Config.Permissions) != 1 || len(profile.Filesystem) != 2 || profile.Filesystem[":minimal"] != "read" || profile.Filesystem[filepath.Join(cwd, "code.txt")] != "read" || profile.Network.Enabled || p.Config.Tools.ViewImage == nil || *p.Config.Tools.ViewImage {
					os.Exit(15)
				}
				id := p.Permissions
				activeReadProfile = id
				var extends any
				if mode == "restricted-other" {
					id = "other"
				}
				if mode == "restricted-inherits" {
					extends = ":read-only"
				}
				if mode != "restricted-missing" {
					response["activePermissionProfile"] = map[string]any{"id": id, "extends": extends}
				}
				response["sandbox"] = map[string]any{"type": "readOnly", "networkAccess": mode == "restricted-network"}
			}
			send(map[string]any{"id": m.ID, "result": response})
		case "turn/start":
			if strings.HasPrefix(mode, "restricted-") {
				os.Exit(16)
			}
			if strings.HasPrefix(mode, "quota-") || mode == "wrong-model" || mode == "wrong-provider" || mode == "fast-tier" {
				os.Exit(8)
			}
			var p struct {
				ThreadID    string `json:"threadId"`
				Approval    string `json:"approvalPolicy"`
				Tier        string `json:"serviceTier"`
				Permissions string `json:"permissions"`
				Sandbox     struct {
					Type          string   `json:"type"`
					Network       bool     `json:"networkAccess"`
					WritableRoots []string `json:"writableRoots"`
					ExcludeTmp    bool     `json:"excludeTmpdirEnvVar"`
					ExcludeSlash  bool     `json:"excludeSlashTmp"`
				} `json:"sandboxPolicy"`
				Input []struct {
					Text string `json:"text"`
				} `json:"input"`
				Schema map[string]any `json:"outputSchema"`
			}
			_ = json.Unmarshal(m.Params, &p)
			if mode == "restricted" && p.Permissions != "" {
				// Match CLI0.148.0: this override reloads the global config,
				// where the thread-local permissions table is absent.
				send(map[string]any{"id": m.ID, "error": map[string]any{"code": -32600, "message": "default_permissions requires a permissions table"}})
				continue
			}
			if p.ThreadID != threadID || p.Sandbox.Network || p.Tier != "default" || len(p.Schema) == 0 || len(p.Input) != 1 {
				os.Exit(5)
			}
			textInput := p.Input[0].Text
			if strings.HasPrefix(textInput, "Act as the implement agent") {
				role = "implement"
			} else if strings.HasPrefix(textInput, "Act as the repair agent") {
				role = "repair"
			}
			if role == "review" {
				if p.Approval != "on-request" || (mode == "restricted" && (p.Permissions != "" || activeReadProfile == "" || p.Sandbox.Type != "")) || (mode != "restricted" && (p.Permissions != "" || p.Sandbox.Type != "readOnly")) {
					os.Exit(5)
				}
			} else {
				cwd, _ := os.Getwd()
				if p.Approval != "on-request" || p.Sandbox.Type != "workspaceWrite" || len(p.Sandbox.WritableRoots) != 1 || p.Sandbox.WritableRoots[0] != cwd || !p.Sandbox.ExcludeTmp || !p.Sandbox.ExcludeSlash {
					os.Exit(5)
				}
			}
			start := strings.Index(textInput, "\n{")
			if start >= 0 {
				var body struct {
					CodeHash string `json:"codeHash"`
				}
				_ = json.Unmarshal([]byte(textInput[start+1:]), &body)
				hash = body.CodeHash
			}
			send(map[string]any{"id": m.ID, "result": map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress"}}})
			switch mode {
			case "protocol-progress":
				for i := 0; i < 2048; i++ {
					send(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": threadID, "turnId": turnID, "delta": strings.Repeat("PROTOCOL_PROGRESS_NOT_RETAINED", 32)}})
				}
			case "protocol-message":
				send(map[string]any{"method": "ignored/progress", "params": map[string]any{"data": strings.Repeat("x", defaultProtocolLimits.messageBytes+1)}})
				continue
			case "protocol-invalid-json":
				fmt.Fprintln(os.Stdout, "{MALFORMED_PROTOCOL_NOT_RETAINED")
				continue
			case "protocol-diagnostics":
				fmt.Fprint(os.Stderr, strings.Repeat("DIAGNOSTIC_NOT_RETAINED", 1024))
				continue
			case "protocol-eof":
				os.Stdout.Close()
				return
			}
			if mode == "approval" {
				send(map[string]any{"id": 100, "method": "item/commandExecution/requestApproval", "params": map[string]any{}})
				continue
			}
			if mode == "review-mutate" && role == "review" {
				_ = os.WriteFile("code.txt", []byte("unexpected review edit"), 0o600)
			}
			if role != "review" {
				content := "fixed"
				if mode == "partial" || mode == "hang" {
					content = "partial"
				}
				_ = os.WriteFile("code.txt", []byte(content), 0o600)
			}
			if mode == "hang" {
				continue
			}
			review := Review{Decision: "approve", CodeHash: hash, Findings: []string{}}
			if mode == "mismatch" {
				review.CodeHash = strings.Repeat("a", 64)
			}
			if mode == "by-content" {
				data, _ := os.ReadFile("code.txt")
				if string(data) != "fixed" {
					review.Decision = "revise"
					review.Findings = []string{"fix code.txt"}
				}
			}
			text, _ := json.Marshal(review)
			if role != "review" {
				text, _ = json.Marshal(EditResult{Summary: "updated code.txt"})
			}
			if mode == "invalid" {
				text = []byte("not JSON")
			}
			if mode == "protocol-final-output" {
				text = append([]byte(strings.Repeat(" ", 4096)), text...)
			}
			send(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": threadID, "turnId": turnID, "tokenUsage": map[string]any{"total": TokenMetadata{Input: 20, Output: 5, Total: 25}}}})
			send(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": threadID, "turnId": turnID, "item": map[string]any{"type": "agentMessage", "phase": "final_answer", "text": string(text)}}})
			status := "completed"
			if mode == "failed" {
				status = "failed"
			}
			send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": threadID, "turn": map[string]any{"id": turnID, "status": status, "items": []any{}}}})
		case "thread/read":
			var p struct {
				ThreadID string `json:"threadId"`
				Include  bool   `json:"includeTurns"`
			}
			_ = json.Unmarshal(m.Params, &p)
			if !p.Include {
				os.Exit(10)
			}
			if mode == "recovery-mutate" {
				_ = os.WriteFile("code.txt", []byte("changed during recovery"), 0o600)
			}
			cwd, _ := os.Getwd()
			hash, _ = CodeHash(cwd)
			text, _ := json.Marshal(Review{Decision: "approve", CodeHash: hash, Findings: []string{}})
			if mode == "edit-recovery" {
				text, _ = json.Marshal(EditResult{Summary: "confirmed prior edit"})
			}
			status := "completed"
			if mode == "hang" {
				status = "inProgress"
			}
			send(map[string]any{"id": m.ID, "result": map[string]any{"thread": map[string]any{"id": p.ThreadID, "turns": []any{map[string]any{"id": turnID, "status": status, "items": []any{map[string]any{"type": "agentMessage", "phase": "final_answer", "text": string(text)}}}}}}})
		default:
			os.Exit(6)
		}
	}
}

func fakeCodexConfig(t *testing.T, root, mode string) *CodexConfig {
	t.Helper()
	binary, _ := os.Executable()
	wrapper := filepath.Join(root, "fake-codex-"+mode)
	body := "#!/bin/sh\nexec '" + strings.ReplaceAll(binary, "'", "'\\''") + "' -test.run=TestHelper -- appserver '" + mode + "' \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "codex-home")
	_ = os.MkdirAll(home, 0o700)
	return &CodexConfig{Enabled: true, Binary: wrapper, Home: home, Model: "test-model"}
}

func codexFixture(t *testing.T, mode string) (Engine, string, Task) {
	e, path, task := fixture(t)
	task.Review = Reviewer{Kind: "codex", Codex: fakeCodexConfig(t, filepath.Dir(path), mode), TimeoutSeconds: 2}
	writeTask(t, path, task)
	e.AllowCodex = true
	return e, path, task
}

func TestCodexProtocolAndFailClosed(t *testing.T) {
	for _, mode := range []string{"success", "invalid", "mismatch", "failed", "approval", "api"} {
		t.Run(mode, func(t *testing.T) {
			e, path, _ := codexFixture(t, mode)
			r := executeRun(t, e, newRun(t, e, path))
			if (r.Status == "accepted") != (mode == "success") {
				t.Fatalf("%s: %+v", mode, r)
			}
			if mode == "failed" {
				proof := r.Evidence[len(r.Evidence)-1]
				if proof.Outcome != "codex-turn-failed" || proof.Model == nil || proof.Model.TurnStatus != "failed" {
					t.Fatalf("failed turn not classified: %+v", proof)
				}
			}
			if mode == "approval" {
				proof := r.Evidence[len(r.Evidence)-1]
				if proof.Model == nil || proof.Model.DeniedServerRequest != "item/commandExecution/requestApproval" || proof.Outcome != "codex-approval-or-tool-request-denied" {
					t.Fatalf("server request classification missing: %+v", proof)
				}
			}
		})
	}
	t.Run("disabled", func(t *testing.T) {
		e, path, _ := codexFixture(t, "success")
		e.AllowCodex = false
		if _, err := e.New(path); err == nil || err.Error() != "codex-disabled" {
			t.Fatalf("%v", err)
		}
	})
}

func TestCodexRecoveryNeverStartsNewTurn(t *testing.T) {
	for _, mode := range []string{"success", "hang"} {
		t.Run(mode, func(t *testing.T) {
			e, path, _ := codexFixture(t, mode)
			r := newRun(t, e, path)
			r.Status = "stopped"
			r.Phase = "review"
			r.Pending = &Pending{Phase: "review", Effect: "model-review", CodeHash: r.CodeHash, ThreadID: "thread-test", TurnID: "turn-test"}
			_ = e.Store.Save(r, false)
			got := executeRun(t, e, r)
			if (got.Status == "accepted") != (mode == "success") {
				t.Fatalf("%+v", got)
			}
			if len(got.Evidence) != 1 || got.Evidence[0].Phase != "review-recovery" || got.ElapsedMillis <= 0 {
				t.Fatalf("recovery evidence missing: %+v", got)
			}
		})
	}
	// Lost turn ID cannot be guessed, and the turn cannot be automatically resent.
	e, path, _ := codexFixture(t, "success")
	r := newRun(t, e, path)
	r.Pending = &Pending{Phase: "review", Effect: "model-review", CodeHash: r.CodeHash, ThreadID: "thread-test"}
	_ = e.Store.Save(r, false)
	if got := executeRun(t, e, r); got.Status != "blocked" || got.Reason != "model-dispatch-unknown-no-replay" {
		t.Fatalf("%+v", got)
	}
}

func TestCodexRecoveryHashAndTimeBounds(t *testing.T) {
	for _, mode := range []string{"recovery-mutate", "time-exhausted"} {
		t.Run(mode, func(t *testing.T) {
			e, path, _ := codexFixture(t, mode)
			r := newRun(t, e, path)
			r.Status = "stopped"
			r.Phase = "review"
			r.Pending = &Pending{Phase: "review", Effect: "model-review", CodeHash: r.CodeHash, ThreadID: "thread-test", TurnID: "turn-test"}
			if mode == "time-exhausted" {
				r.ElapsedMillis = int64(r.Task.TimeoutSeconds) * 1000
			}
			_ = e.Store.Save(r, false)
			got := executeRun(t, e, r)
			if got.Status != "blocked" {
				t.Fatalf("%+v", got)
			}
			if mode == "time-exhausted" && got.Reason != "time-budget-exhausted" {
				t.Fatal(got.Reason)
			}
			if mode == "recovery-mutate" && got.Reason != "review-recovery-modified-code" {
				t.Fatal(got.Reason)
			}
		})
	}
}
