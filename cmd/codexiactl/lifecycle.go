package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"
)

var (
	sourceHash       = regexp.MustCompile(`^[a-f0-9]{40}$`)
	digestHash       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	fullImage        = regexp.MustCompile(`^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$`)
	safeIdentifier   = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,79}$`)
	errExistingOwner = errors.New("an existing Owner is enrolled. Continue through the protected deployment runbook")
)

type lifecycleState struct {
	M, H, D, A, B, F, T string
}

type frontendIdentity struct {
	Format    string
	SourceSHA string
	Version   string
	Profile   string
	APIEpoch  int
}

type lifecycleReceipt struct {
	SourceSHA  string
	RunID      int64
	Attempt    int
	Management string
	PlanSHA    string `json:"planSha256"`
	Request    struct {
		Intent                string
		Window                *json.RawMessage
		BackendPublisherRunID int64
		Frontend              struct {
			RunID, ArtifactID, VerifyRunID int64
			ArtifactDigest                 string
		}
	}
	Plan struct {
		Format, Intent, Route, CandidateRoute string
		Window                                *json.RawMessage
		Blockers, RequiredApprovals           []string
		Observation                           struct {
			State           lifecycleState
			ObservedAt      time.Time
			BootstrapResume json.RawMessage
			Binding         struct {
				HostID string
			}
		}
		Target struct {
			BackendCertificateSHA string `json:"backendCertificateSha256"`
			FrontendArtifactSHA   string `json:"frontendArtifactSha256"`
			IdentitySHA           string `json:"identitySha256"`
		}
	}
	Evidence struct {
		Host struct {
			Database struct {
				State                string
				OwnerSetupCheckpoint struct {
					GrantBindingSHA                         string `json:"grantBindingSha256"`
					PendingHandoff, EncryptedHandoffPresent bool
				}
			}
		}
		Edge struct {
			Origin, FrontendState              string
			RoutesReady, PublicProtocolEnabled bool
			Frontend                           *frontendIdentity
			Backend                            *struct {
				StandaloneOAuth bool
			}
		}
		Candidate struct {
			BackendImage string
			Frontend     frontendIdentity
		}
	}
}

const evidenceMaxAge = 5 * time.Minute

func (r lifecycleReceipt) validate(sha string, id int64, management, hostID, origin string, now time.Time) error {
	if r.Request.Intent != "install" || r.Request.Window != nil {
		return refused("Expected a window-free initial-install Preflight")
	}
	return r.validateObservation(sha, id, management, hostID, origin, now)
}

func (r lifecycleReceipt) validateObservation(sha string, id int64, management, hostID, origin string, now time.Time) error {
	if r.SourceSHA != sha || r.RunID != id || r.Attempt != 1 || r.Management != management ||
		r.Plan.Observation.Binding.HostID != hostID || r.Evidence.Edge.Origin != origin {
		return refused("Preflight evidence does not match the approved source, attempt, VM, or origin")
	}
	f := r.Request.Frontend
	switch r.Request.Intent {
	case "install", "adopt", "update", "maintenance", "restore":
	default:
		return refused("Preflight has an unrecognized lifecycle intent")
	}
	if r.Plan.Format != "codexia-deployment-plan/v1" || r.Plan.Intent != r.Request.Intent ||
		!matchingReceiptWindow(r.Request.Window, r.Plan.Window) || !digestHash.MatchString(r.PlanSHA) ||
		r.Request.BackendPublisherRunID < 1 || f.RunID < 1 || f.ArtifactID < 1 || f.VerifyRunID < 1 ||
		f.ArtifactDigest != r.Plan.Target.FrontendArtifactSHA || !digestHash.MatchString(f.ArtifactDigest) ||
		!digestHash.MatchString(r.Plan.Target.BackendCertificateSHA) || !digestHash.MatchString(r.Plan.Target.IdentitySHA) {
		return refused("Preflight lacks the exact certified candidate pair and install evidence")
	}
	if !r.fresh(now) {
		return needsAction("The lifecycle observation expired. Start a fresh protected Preflight")
	}
	return nil
}

func matchingReceiptWindow(request, plan *json.RawMessage) bool {
	if request == nil || plan == nil {
		return request == nil && plan == nil
	}
	return bytes.Equal(*request, *plan)
}

func (r lifecycleReceipt) fresh(now time.Time) bool {
	age := now.Sub(r.Plan.Observation.ObservedAt)
	return age >= 0 && age <= evidenceMaxAge
}

type installOperation int

const (
	initializeDatabase installOperation = iota + 1
	resumeAuthOnly
	publishFrontend
)

func (r lifecycleReceipt) initialOperation() (installOperation, error) {
	s := r.Plan.Observation.State
	if s.A == "ready" || s.A == "unprepared" {
		return 0, errExistingOwner
	}
	for _, blocker := range r.Plan.Blockers {
		if blocker != "approval-required" {
			return 0, needsAction("The protected lifecycle plan has a blocker. Review the run before proceeding")
		}
	}
	if s.M != "ready" || s.T != "none" || r.Evidence.Edge.PublicProtocolEnabled {
		return 0, refused("The management connection, transaction state, or edge boundary requires independent review")
	}
	approvals := slices.Clone(r.Plan.RequiredApprovals)
	slices.Sort(approvals)
	switch r.Plan.CandidateRoute {
	case "R4":
		if !slices.Equal(approvals, []string{"bootstrap", "database-initialization"}) || s.A != "absent" {
			return 0, refused("R4 is outside the verified new-install path")
		}
		if s.D == "absent" && (r.Evidence.Host.Database.State == "absent" || r.Evidence.Host.Database.State == "missing") && s.B == "absent" {
			return initializeDatabase, nil
		}
		if s.H == "ready" && s.D == "compatible" && s.B == "absent" &&
			len(r.Plan.Observation.BootstrapResume) > 0 && string(r.Plan.Observation.BootstrapResume) != "null" {
			return resumeAuthOnly, nil
		}
		return 0, refused("R4 cannot establish DB absence or a verified Auth-only continuation")
	case "R5":
		if slices.Equal(approvals, []string{"owner-enrollment"}) && s.H == "ready" &&
			s.D == "compatible" && s.A == "pending" && (s.B == "absent" || s.B == "setup") &&
			(s.F == "absent" || s.F == "compatible") {
			return publishFrontend, nil
		}
	}
	return 0, needsAction("The protected lifecycle route requires another operation. See the production Bootstrap and recovery runbooks")
}

func (r lifecycleReceipt) frontendReady() bool {
	e := r.Evidence.Edge
	return e.RoutesReady && !e.PublicProtocolEnabled && e.FrontendState == "running" &&
		e.Frontend != nil && *e.Frontend == r.Evidence.Candidate.Frontend && e.Frontend.Profile == "full" &&
		sourceHash.MatchString(e.Frontend.SourceSHA) && e.Frontend.APIEpoch > 0 &&
		e.Backend == nil
}

func (r lifecycleReceipt) setupForDelivery() bool {
	state := r.Plan.Observation.State
	handoff := r.Evidence.Host.Database.OwnerSetupCheckpoint
	return state.M == "ready" && state.H == "ready" && state.D == "compatible" &&
		state.A == "pending" && state.B == "setup" && state.F == "compatible" && state.T == "none" &&
		r.frontendReady() && handoff.EncryptedHandoffPresent && !handoff.PendingHandoff &&
		digestHash.MatchString(handoff.GrantBindingSHA)
}

func (r lifecycleReceipt) reviewSummary(id int64) string {
	s := r.Plan.Observation.State
	return fmt.Sprintf("Preflight %s. Observation M=%s H=%s D=%s A=%s B=%s F=%s T=%s. Candidate Backend publisher %d, Frontend build %d, approval plan %s.",
		runLink(id), stateValue(s.M), stateValue(s.H), stateValue(s.D), stateValue(s.A),
		stateValue(s.B), stateValue(s.F), stateValue(s.T), r.Request.BackendPublisherRunID, r.Request.Frontend.RunID, r.PlanSHA)
}

func stateValue(value string) string {
	if safeIdentifier.MatchString(value) {
		return value
	}
	return "unknown"
}
