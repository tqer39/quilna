package harness

import (
	"errors"
	"os"
	"path/filepath"
)

// Review paths are trusted grants, not paths suggested by model output.
// The CLI's minimal runtime reads remain necessary for its command tools.
func validateReviewReadPaths(review Reviewer) error {
	if review.ReadPaths == nil {
		return nil
	}
	if review.Kind != "codex" || len(review.ReadPaths) == 0 || len(review.ReadPaths) > 128 {
		return errors.New("review-read-paths-invalid")
	}
	seen := map[string]bool{}
	bytes := 0
	for _, path := range review.ReadPaths {
		bytes += len(path)
		if !filepath.IsAbs(path) || path != filepath.Clean(path) || seen[path] || bytes > 32768 {
			return errors.New("review-read-paths-invalid")
		}
		canonical, err := filepath.EvalSymlinks(path)
		if err != nil || canonical != path {
			return errors.New("review-read-path-must-be-canonical")
		}
		info, err := os.Stat(path)
		if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("review-read-path-type-invalid")
		}
		seen[path] = true
	}
	return nil
}

func reviewPermissionProfile(paths []string) map[string]any {
	filesystem := map[string]any{":minimal": "read"}
	for _, path := range paths {
		filesystem[path] = "read"
	}
	return map[string]any{"filesystem": filesystem, "network": map[string]any{"enabled": false}}
}
