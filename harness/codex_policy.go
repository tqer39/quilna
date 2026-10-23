package harness

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Read only config keys, never retain or log MCP/plugin definitions or credentials.
// An empty table would not clear inherited MCP entries: each name is disabled.
func minimalThreadConfig(s *appServer, workspace, readProfile string, readPaths []string) (map[string]any, error) {
	data, err := s.call("config/read", map[string]any{"cwd": workspace, "includeLayers": false})
	if err != nil {
		return nil, errors.New("codex-config-unconfirmed")
	}
	var response struct {
		Config *struct {
			MCP         map[string]json.RawMessage `json:"mcp_servers"`
			Plugins     map[string]json.RawMessage `json:"plugins"`
			Hooks       map[string]json.RawMessage `json:"hooks"`
			Permissions map[string]json.RawMessage `json:"permissions"`
			Shell       struct {
				Set map[string]json.RawMessage `json:"set"`
			} `json:"shell_environment_policy"`
		} `json:"config"`
	}
	if json.Unmarshal(data, &response) != nil || response.Config == nil {
		return nil, errors.New("codex-config-invalid")
	}
	mcp := map[string]any{}
	for name := range response.Config.MCP {
		mcp[name] = map[string]any{"enabled": false}
	}
	plugins := map[string]any{"_default": map[string]any{"enabled": false}}
	for name := range response.Config.Plugins {
		plugins[name] = map[string]any{"enabled": false}
	}
	hooks := map[string]any{}
	for name, raw := range response.Config.Hooks {
		if name == "state" {
			// This is a map of trust hashes, not an event array. Preserve it untouched.
			continue
		}
		shape := bytes.TrimSpace(raw)
		if len(shape) == 0 || (shape[0] != '[' && string(shape) != "null") {
			return nil, errors.New("codex-hook-event-shape-unknown")
		}
		hooks[name] = []any{}
	}
	set := map[string]string{}
	for name := range response.Config.Shell.Set {
		set[name] = ""
	}
	config := map[string]any{"mcp_servers": mcp, "plugins": plugins, "hooks": hooks, "notify": []string{}, "features": map[string]any{"hooks": false, "apps": false, "plugins": false, "multi_agent": false}, "web_search": "disabled", "service_tier": "default", "forced_login_method": "chatgpt", "shell_environment_policy": map[string]any{"inherit": "none", "set": set, "experimental_use_profile": false}}
	if readProfile != "" {
		if _, exists := response.Config.Permissions[readProfile]; exists {
			return nil, errors.New("codex-read-profile-collision")
		}
		if err := validateReviewReadPaths(Reviewer{Kind: "codex", ReadPaths: readPaths}); err != nil {
			return nil, err
		}
		config["permissions"] = map[string]any{readProfile: reviewPermissionProfile(readPaths)}
		// Image loading is not a sandboxed shell read. This mode reviews source.
		config["tools"] = map[string]any{"view_image": false}
	}
	return config, nil
}

type EditResult struct {
	Summary string `json:"summary"`
}

func parseEditResult(data []byte) error {
	var result EditResult
	if strictJSON(data, &result) != nil || len(result.Summary) == 0 || len(result.Summary) > 8000 {
		return errors.New("model-edit-result-invalid")
	}
	return nil
}
func editOutputSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"summary"}, "properties": map[string]any{"summary": map[string]any{"type": "string", "minLength": 1, "maxLength": 8000}}}
}

func modelRole(r *Run) (string, *CodexConfig, int, string) {
	phase := r.Phase
	if r.Pending != nil {
		phase = r.Pending.Phase
	}
	if phase == "review" {
		return phase, r.Task.Review.Codex, r.Task.Review.TimeoutSeconds, ""
	}
	action := r.Task.Implement
	if phase == "repair" {
		action = r.Task.Repair
	}
	if action == nil {
		return phase, nil, 0, ""
	}
	return phase, action.Codex, action.TimeoutSeconds, action.Instructions
}
