package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// ArtifactReference points to immutable, hash-linked metadata, not a copy of the binary.
type ArtifactReference struct {
	Manifest string `json:"manifest"`
	SHA256   string `json:"sha256"`
}

type artifactEntry struct {
	Path   string `json:"path"`
	Mode   uint32 `json:"mode"`
	SHA256 string `json:"sha256,omitempty"`
	Target string `json:"target,omitempty"`
}

type artifactTree struct {
	Path    string          `json:"path"`
	Entries []artifactEntry `json:"entries"`
}

type artifactManifest struct {
	Version    int            `json:"version"`
	CodeHash   string         `json:"codeHash"`
	TaskHash   string         `json:"taskHash"`
	Operation  int            `json:"operation"`
	CheckIndex int            `json:"checkIndex"`
	Trees      []artifactTree `json:"trees"`
}

const artifactManifestLimit = 4 * 1024 * 1024

func validArtifactPath(path string) bool {
	return path != "" && path != "." && len(path) <= 4096 && !filepath.IsAbs(path) && filepath.Clean(path) == path && path != ".." && !strings.HasPrefix(path, "../") && !strings.ContainsRune(path, 0) && path != ".git" && !strings.HasPrefix(path, ".git/")
}

func withinPath(root, path string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

func (t Task) validateArtifacts() error {
	var all []string
	for _, a := range t.Checks {
		if len(a.Artifacts) > 16 {
			return errors.New("artifact-count-limit")
		}
		for _, path := range a.Artifacts {
			if !validArtifactPath(path) {
				return errors.New("artifact-path-invalid")
			}
			for _, previous := range all {
				if withinPath(path, previous) || withinPath(previous, path) {
					return errors.New("artifact-paths-overlap")
				}
			}
			all = append(all, path)
		}
	}
	for _, a := range []*Action{t.Implement, t.Repair} {
		if a != nil && len(a.Artifacts) > 0 {
			return errors.New("artifacts-only-on-checks")
		}
	}
	return nil
}

// Snapshot every directory entry, including debug dylibs and internal symlinks.
// WalkDir does not follow symlinks; their resolved target must remain in this tree.
func snapshotArtifacts(workspace string, paths []string) ([]artifactTree, error) {
	var trees []artifactTree
	count := 0
	var total int64
	for _, path := range paths {
		root := filepath.Join(workspace, path)
		canonical, err := filepath.EvalSymlinks(root)
		if err != nil || canonical != root {
			return nil, errors.New("artifact-root-not-canonical")
		}
		tree := artifactTree{Path: path, Entries: []artifactEntry{}}
		directories := map[string]fs.FileInfo{}
		err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			count++
			if count > 8192 {
				return errors.New("artifact-entry-limit")
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(root, current)
			if err != nil {
				return err
			}
			record := artifactEntry{Path: relative, Mode: uint32(info.Mode())}
			switch {
			case info.IsDir():
				directories[current] = info
			case info.Mode().IsRegular():
				total += info.Size()
				if total > 1024*1024*1024 {
					return errors.New("artifact-size-limit")
				}
				snap, err := SnapshotFile(current)
				if err != nil {
					return err
				}
				after, err := os.Lstat(current)
				if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() || uint32(info.Mode()) != snap.Mode {
					return errors.New("artifact-changed-during-capture")
				}
				record.SHA256 = snap.SHA256
			case info.Mode()&os.ModeSymlink != 0:
				target, err := os.Readlink(current)
				if err != nil {
					return err
				}
				resolved, err := filepath.EvalSymlinks(current)
				if err != nil || !withinPath(root, resolved) {
					return errors.New("artifact-link-outside-tree")
				}
				after, err := os.Lstat(current)
				if err != nil || !os.SameFile(info, after) || info.ModTime() != after.ModTime() {
					return errors.New("artifact-changed-during-capture")
				}
				record.Target = target
			default:
				return errors.New("artifact-not-regular")
			}
			tree.Entries = append(tree.Entries, record)
			return nil
		})
		if err != nil {
			return nil, err
		}
		for path, before := range directories {
			after, err := os.Lstat(path)
			if err != nil || !os.SameFile(before, after) || before.Mode() != after.Mode() || before.ModTime() != after.ModTime() {
				return nil, errors.New("artifact-changed-during-capture")
			}
		}
		canonical, err = filepath.EvalSymlinks(root)
		if err != nil || canonical != root {
			return nil, errors.New("artifact-root-not-canonical")
		}
		trees = append(trees, tree)
	}
	return trees, nil
}

func (e Engine) captureArtifacts(r *Run, proof Evidence) (*ArtifactReference, error) {
	paths := r.Task.Checks[*proof.CheckIndex].Artifacts
	if len(paths) == 0 {
		return nil, nil
	}
	trees, err := snapshotArtifacts(r.Task.Workspace, paths)
	if err != nil {
		return nil, err
	}
	manifest := artifactManifest{Version: 1, CodeHash: proof.CodeHash, TaskHash: r.TaskHash, Operation: proof.Operation, CheckIndex: *proof.CheckIndex, Trees: trees}
	data, err := json.Marshal(manifest)
	if err != nil || len(data) > artifactManifestLimit {
		return nil, errors.New("artifact-manifest-limit")
	}
	name := fmt.Sprintf("%s/%03d.artifacts.json", r.ID, proof.Operation)
	f, err := os.OpenFile(filepath.Join(e.Store.Directory, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY|sysNoFollow, 0600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return nil, err
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}
	return &ArtifactReference{Manifest: name, SHA256: digest(data)}, nil
}

func (e Engine) loadArtifactManifest(r *Run, proof Evidence) (artifactManifest, error) {
	var m artifactManifest
	ref := proof.Artifacts
	expected := fmt.Sprintf("%s/%03d.artifacts.json", r.ID, proof.Operation)
	if ref == nil || ref.Manifest != expected || !hashPattern.MatchString(ref.SHA256) {
		return m, errors.New("artifact-manifest-invalid")
	}
	path := filepath.Join(e.Store.Directory, ref.Manifest)
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return m, errors.New("artifact-manifest-modified")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|sysNoFollow|syscall.O_NONBLOCK, 0)
	if err != nil {
		return m, errors.New("artifact-manifest-modified")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > artifactManifestLimit {
		return m, errors.New("artifact-manifest-modified")
	}
	data, err := io.ReadAll(io.LimitReader(f, artifactManifestLimit+1))
	if err != nil || len(data) > artifactManifestLimit || digest(data) != ref.SHA256 {
		return m, errors.New("artifact-manifest-modified")
	}
	if strictJSON(data, &m) != nil || m.Version != 1 || m.TaskHash != r.TaskHash || m.CodeHash != proof.CodeHash || m.Operation != proof.Operation || proof.CheckIndex == nil || m.CheckIndex != *proof.CheckIndex {
		return m, errors.New("artifact-manifest-invalid")
	}
	paths := r.Task.Checks[m.CheckIndex].Artifacts
	if len(m.Trees) != len(paths) {
		return m, errors.New("artifact-manifest-invalid")
	}
	for i, path := range paths {
		if m.Trees[i].Path != path {
			return m, errors.New("artifact-manifest-invalid")
		}
	}
	return m, nil
}

func (e Engine) verifyArtifactEvidence(r *Run) error {
	// Historical manifests remain immutable even when repairs supersede their outputs.
	for _, proof := range r.Evidence {
		if proof.Artifacts != nil {
			if proof.Phase != "checks" || proof.CheckIndex == nil {
				return errors.New("artifact-manifest-invalid")
			}
			if _, err := e.loadArtifactManifest(r, proof); err != nil {
				return err
			}
		}
	}
	if r.Phase == "repair" || r.Phase == "implement" {
		return nil
	}
	for _, proof := range latestCheckEvidence(r) {
		if proof.CheckIndex == nil || proof.ExitCode != 0 || proof.Outcome != "complete" {
			continue
		}
		if r.Phase == "checks" && *proof.CheckIndex >= r.CheckIndex {
			continue
		}
		paths := r.Task.Checks[*proof.CheckIndex].Artifacts
		if len(paths) == 0 {
			continue
		}
		m, err := e.loadArtifactManifest(r, proof)
		if err != nil {
			return err
		}
		current, err := snapshotArtifacts(r.Task.Workspace, paths)
		if err != nil {
			return errors.New("artifact-modified")
		}
		before, _ := json.Marshal(m.Trees)
		after, _ := json.Marshal(current)
		if !bytes.Equal(before, after) {
			return errors.New("artifact-modified")
		}
	}
	return nil
}

// Include artifact verification in the persisted run budget. A review that
// finishes near the deadline cannot become accepted after an over-budget scan.
func (e Engine) verifyArtifactsDuringRun(ctx context.Context, r *Run) error {
	hasArtifacts := false
	for _, check := range r.Task.Checks {
		hasArtifacts = hasArtifacts || len(check.Artifacts) > 0
	}
	if !hasArtifacts {
		return nil
	}
	started := time.Now()
	err := e.verifyArtifactEvidence(r)
	r.ElapsedMillis += time.Since(started).Milliseconds()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
