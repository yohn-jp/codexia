package main

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestRunbookLinksUseCheckedOutDocumentsAtSelectedRevision(t *testing.T) {
	target := githubTarget{Owner: "Fork-Org"}
	controller := workflowController{target: target, sha: strings.Repeat("b", 40)}
	for _, file := range []string{bootstrapRunbook, recoveryRunbook, authRuntimeRunbook} {
		doc := "docs/deployment/" + file
		want := target.URL() + "/blob/" + controller.sha + "/" + doc
		if got := controller.runbookLink(file); got != want {
			t.Errorf("runbook link = %q, want %q", got, want)
		}
		info, err := os.Stat(filepath.Join("..", "..", doc))
		if err != nil || !info.Mode().IsRegular() {
			t.Errorf("missing runbook %s", doc)
		}
	}
}

func TestRequiredJobsMatchCheckedOutProductionWorkflows(t *testing.T) {
	for _, tc := range []struct {
		operation string
		mode      string
		jobIDs    []string
	}{
		{"management", "preflight", []string{"bootstrap"}},
		{"lifecycle", "lifecycle", []string{"lifecycle-candidate", "lifecycle-host", "lifecycle-plan"}},
		{"bootstrap", "bootstrap", []string{"runtime-identity", "bootstrap", "runtime-acceptance"}},
		{"frontend", "", []string{"initial-frontend"}},
		{"owner-setup", "owner-setup", []string{"bootstrap"}},
	} {
		t.Run(tc.operation, func(t *testing.T) {
			spec := operations[tc.operation]
			filename := filepath.Join("..", "..", ".github", "workflows", spec.file)
			workflow, err := os.ReadFile(filename) //nolint:gosec // Reads an embedded application workflow allowlist entry from the test checkout.
			if err != nil {
				t.Fatal(err)
			}
			var canonical []string
			for _, job := range tc.jobIDs {
				// Workflow job IDs and their display name are top-level fields
				// under jobs. Deeper step names are outside this declaration.
				declaration := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(job) + `:\n(?:    [^ \n][^\n]*\n)*?    name: ([^\n]+)`)
				name := declaration.FindSubmatch(workflow)
				if len(name) != 2 {
					t.Fatalf("%s has no explicit name for %s", spec.file, job)
				}
				canonical = append(canonical, strings.ReplaceAll(string(name[1]), "${{ inputs.mode }}", tc.mode))
			}
			if !slices.Equal(spec.jobs, canonical) {
				t.Fatalf("CLI requires %q but canonical %s runs %q", spec.jobs, spec.file, canonical)
			}
		})
	}
}
