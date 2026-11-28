package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	cloudflareWorkerID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
	cloudflareAUD      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	cloudflareTeam     = regexp.MustCompile(`^[a-z0-9-]+$`)
)

type cloudflareRoutes struct {
	Routes       []string `json:"routes"`
	OriginRoutes []string `json:"originRoutes"`
}

func cloudflareMatchesHost(pattern, host string) bool {
	pattern = strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(pattern), "https://"), "http://")
	pattern, _, _ = strings.Cut(pattern, "/")
	if !strings.Contains(pattern, "*") {
		return pattern == host
	}
	matcher := "^" + strings.ReplaceAll(regexp.QuoteMeta(pattern), `\*`, ".*") + "$"
	matched, err := regexp.MatchString(matcher, host)
	return matched || err != nil
}

type cloudflareAccessApp struct {
	ID                string   `json:"id"`
	AUD               string   `json:"aud"`
	Domain            string   `json:"domain"`
	Type              string   `json:"type"`
	SelfHostedDomains []string `json:"self_hosted_domains"`
	Destinations      []struct {
		Type      string            `json:"type"`
		URI       string            `json:"uri"`
		Overrides []json.RawMessage `json:"overrides"`
	} `json:"destinations"`
}

type cloudflareAccessPolicy struct {
	ID         string                       `json:"id"`
	Decision   string                       `json:"decision"`
	Precedence int64                        `json:"precedence"`
	Require    []json.RawMessage            `json:"require"`
	Exclude    []json.RawMessage            `json:"exclude"`
	Include    []map[string]json.RawMessage `json:"include"`
}
