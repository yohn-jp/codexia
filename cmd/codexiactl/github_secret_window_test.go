package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"
)

const (
	githubTestOperationA = "123456789abcdef00000000000000001"
	githubTestOperationB = "123456789abcdef00000000000000002"
	githubTestLockPath   = "/repos/yohn-jp/codexia/environments/codexia-bootstrap/variables"
)

type githubTestSettingsVariable struct {
	mu          sync.Mutex
	value       string
	creates     int
	emptyChecks chan struct{}
}

func (s *githubTestSettingsVariable) serve(t *testing.T, w http.ResponseWriter, r *http.Request) bool {
	switch {
	case r.URL.Path == githubTestLockPath && r.Method == http.MethodPost:
		var input struct{ Name, Value string }
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Name != githubSettingsWriterVariable {
			t.Error("bad lock creation")
			w.WriteHeader(http.StatusUnprocessableEntity)
			return true
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.value != "" {
			w.WriteHeader(http.StatusConflict)
			return true
		}
		s.creates++
		s.value = input.Value
		w.WriteHeader(http.StatusCreated)
	case r.URL.Path == githubTestLockPath+"/"+githubSettingsWriterVariable && r.Method == http.MethodGet:
		s.mu.Lock()
		value := s.value
		s.mu.Unlock()
		if value == "" {
			if s.emptyChecks != nil {
				s.emptyChecks <- struct{}{}
			}
			w.WriteHeader(http.StatusNotFound)
		} else {
			githubTestJSON(t, w, map[string]string{"name": githubSettingsWriterVariable, "value": value})
		}
	case r.URL.Path == githubTestLockPath+"/"+githubSettingsWriterVariable && r.Method == http.MethodDelete:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.value = ""
		w.WriteHeader(http.StatusNoContent)
	default:
		return false
	}
	return true
}

func TestGitHubSecretSettingsWriterSerializesTwoSessionsAndResumesOnlyOwner(t *testing.T) {
	t.Parallel()
	lock := new(githubTestSettingsVariable)
	lock.emptyChecks = make(chan struct{}, 2)
	bothObserved := make(chan struct{})
	go func() {
		<-lock.emptyChecks
		<-lock.emptyChecks
		close(bothObserved)
	}()
	handler := func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == githubTestLockPath && r.Method == http.MethodPost {
			// Both clients must have observed absence before either POST is applied.
			select {
			case <-bothObserved:
			case <-r.Context().Done():
				return
			}
		}
		if !lock.serve(t, w, r) && !githubTestProtection(t, w, r) {
			t.Errorf("unexpected API request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
	a := newTestGitHub(t, handler)
	b := newTestGitHub(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	type result struct {
		id     string
		window *githubSecretWriteWindow
		err    error
	}
	results := make(chan result, 2)
	for _, session := range []struct {
		id      string
		control *githubControl
	}{{githubTestOperationA, a}, {githubTestOperationB, b}} {
		go func() {
			window, err := session.control.AcquireSecretWriteWindow(ctx, new(githubTestOperator), session.id)
			results <- result{session.id, window, err}
		}()
	}
	first, second := <-results, <-results
	if first.err != nil {
		first, second = second, first
	}
	if first.err != nil || first.window == nil || !errors.Is(second.err, errGitHubSettingsWriterUnavailable) || lock.creates != 1 {
		t.Fatalf("expected one settings writer, got first=%v second=%v creates=%d", first.err, second.err, lock.creates)
	}
	fresh := newTestGitHub(t, handler)
	if _, err := fresh.AcquireSecretWriteWindow(ctx, new(githubTestOperator), second.id); !errors.Is(err, errGitHubSettingsWriterUnavailable) {
		t.Fatalf("different checkpoint can claim the active lock: %v", err)
	}
	ownerResumed, err := fresh.AcquireSecretWriteWindow(ctx, new(githubTestOperator), first.id)
	if err != nil || lock.creates != 1 {
		t.Fatalf("matching checkpoint did not resume its existing window: %v", err)
	}
	if err := ownerResumed.Close(ctx); err != nil || lock.value != "" {
		t.Fatalf("could not release owning settings window: %v", err)
	}
}

func TestGitHubSecretDoesNotSendWithoutExclusiveWriterApproval(t *testing.T) {
	t.Parallel()
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("uncoordinated mutation %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	})
	ctx := context.Background()
	if _, err := g.AcquireSecretWriteWindow(ctx, &githubTestOperator{deny: true}, githubTestOperationA); !errors.Is(err, errGitHubSettingsWriterUnavailable) {
		t.Fatalf("did not stop when the exclusive scope was denied: %v", err)
	}
	err := g.PutSecret(ctx, githubBootstrapEnvironment, "CODEXIA_TUNNEL_TOKEN", []byte("fixture"))
	if !errors.Is(err, errGitHubSettingsWriterUnavailable) || errors.Is(err, errGitHubSecretWriteUnknown) {
		t.Fatalf("uncoordinated Secret send was not rejected before transmission: %v", err)
	}
}

func TestGitHubSecretResumeNeverRecreatesLostWriterRecord(t *testing.T) {
	t.Parallel()
	lock := new(githubTestSettingsVariable)
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if !lock.serve(t, w, r) && !githubTestProtection(t, w, r) {
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if _, err := g.ResumeSecretWriteWindow(context.Background(), new(githubTestOperator), githubTestOperationA); !errors.Is(err, errGitHubSettingsWriterUnavailable) || lock.creates != 0 {
		t.Fatalf("lost lock was treated as uninterrupted ownership: %v, created %d", err, lock.creates)
	}
}

func TestGitHubSecretStopsWhenItsWriterRecordChangesAndPreservesOtherHolder(t *testing.T) {
	t.Parallel()
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	lock := new(githubTestSettingsVariable)
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete || r.Method == http.MethodPut {
			t.Errorf("attempted mutation with a different lock owner: %s %s", r.Method, r.URL.Path)
		}
		switch {
		case lock.serve(t, w, r), githubTestProtection(t, w, r):
		case strings.HasSuffix(r.URL.Path, "/secrets/public-key"):
			githubTestJSON(t, w, map[string]string{"key_id": "123", "key": base64.StdEncoding.EncodeToString(pub[:])})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/secrets/CODEXIA_TUNNEL_TOKEN"):
			lock.mu.Lock()
			lock.value = githubTestOperationB
			lock.mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := context.Background()
	window, err := g.AcquireSecretWriteWindow(ctx, new(githubTestOperator), githubTestOperationA)
	if err != nil {
		t.Fatal(err)
	}
	err = g.PutSecret(ctx, githubBootstrapEnvironment, "CODEXIA_TUNNEL_TOKEN", []byte("fixture"))
	if !errors.Is(err, errGitHubSettingsWriterUnavailable) || errors.Is(err, errGitHubSecretWriteUnknown) {
		t.Fatalf("Secret send did not stop on loss of its lock: %v", err)
	}
	if err := window.Close(ctx); !errors.Is(err, errGitHubSettingsWriterUnavailable) {
		t.Fatalf("released a different holder's settings window: %v", err)
	}
}

func TestGitHubSecretWriteUncertaintyDistinguishesDefiniteRejections(t *testing.T) {
	t.Parallel()
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		status  int
		unknown bool
	}{
		{http.StatusForbidden, false},
		{http.StatusServiceUnavailable, true},
		{http.StatusNoContent, true},
		{http.StatusCreated, true}, // The follow-up Secret metadata is absent.
	} {
		t.Run(fmt.Sprint(tt.status), func(t *testing.T) {
			lock := new(githubTestSettingsVariable)
			g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case lock.serve(t, w, r), githubTestProtection(t, w, r):
				case strings.HasSuffix(r.URL.Path, "/secrets/public-key"):
					githubTestJSON(t, w, map[string]string{"key_id": "123", "key": base64.StdEncoding.EncodeToString(pub[:])})
				case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/secrets/CODEXIA_TUNNEL_TOKEN"):
					w.WriteHeader(tt.status)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})
			ctx := context.Background()
			if _, err := g.AcquireSecretWriteWindow(ctx, new(githubTestOperator), githubTestOperationA); err != nil {
				t.Fatal(err)
			}
			err := g.PutSecret(ctx, githubBootstrapEnvironment, "CODEXIA_TUNNEL_TOKEN", []byte("fixture"))
			if err == nil || errors.Is(err, errGitHubSecretWriteUnknown) != tt.unknown {
				t.Fatalf("unexpected classification for status %d: %v", tt.status, err)
			}
		})
	}
}
