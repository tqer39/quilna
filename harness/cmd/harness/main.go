package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"adaptive-textbook/harness"
)

func main() { os.Exit(run()) }
func run() int {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: harness freeze-task -task ABS_PATH -output NEW_ABS_PATH -file ABS_PATH (repeat), or run|status|summary|resume|stop -state ABS_PATH [-task ABS_PATH | -run ID]")
		return 2
	}
	verb := os.Args[1]
	if verb == "freeze-task" {
		return freezeTask(os.Args[2:])
	}
	flags := flag.NewFlagSet(verb, flag.ContinueOnError)
	state := flags.String("state", "", "private state directory")
	task := flags.String("task", "", "trusted task JSON")
	id := flags.String("run", "", "run ID")
	allow := flags.Bool("allow-codex", false, "explicitly opt into configured Codex implementation, review and repair")
	reconcile := flags.Bool("reconcile-local", false, "after inspecting interrupted local edits, rerun checks without replaying edits")
	if flags.Parse(os.Args[2:]) != nil || flags.NArg() != 0 {
		return 2
	}
	store, err := harness.OpenStore(*state)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	engine := harness.Engine{Store: store, AllowCodex: *allow}
	if verb == "summary" {
		summary, err := engine.Summary(*id)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if json.NewEncoder(os.Stdout).Encode(summary) != nil {
			return 1
		}
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var result *harness.Run
	switch verb {
	case "run":
		result, err = engine.New(*task)
		if err == nil {
			fmt.Fprintln(os.Stderr, "run:", result.ID)
			result, err = engine.Execute(ctx, result.ID, false)
		}
	case "resume":
		result, err = engine.Execute(ctx, *id, *reconcile)
	case "status":
		result, err = engine.Status(*id)
	case "stop":
		err = store.Stop(*id)
		if err == nil {
			result, err = store.Load(*id)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		return 1
	}
	if verb != "status" && verb != "stop" && result.Status != "accepted" {
		return 1
	}
	return 0
}

type pathsFlag []string

func (p *pathsFlag) String() string         { return fmt.Sprint([]string(*p)) }
func (p *pathsFlag) Set(value string) error { *p = append(*p, value); return nil }

func freezeTask(args []string) int {
	flags := flag.NewFlagSet("freeze-task", flag.ContinueOnError)
	input := flags.String("task", "", "existing trusted task JSON")
	output := flags.String("output", "", "new canonical absolute task path")
	var files pathsFlag
	flags.Var(&files, "file", "canonical absolute control path; repeat for each fixed test/script")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	task, err := harness.FreezeTask(*input, *output, files)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := json.NewEncoder(os.Stdout).Encode(task.ProtectedFiles); err != nil {
		return 1
	}
	return 0
}
