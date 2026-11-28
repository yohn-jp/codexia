package main

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"maps"
	"net/netip"
	"reflect"
	"strings"

	"golang.org/x/crypto/ssh"
)

type protectedVariableWrite struct {
	environmentInput
	previous string
	update   bool
}

type managementVariablePair struct {
	environment, hostName, pinName string
}

var managementVariablePairs = []managementVariablePair{
	{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS"},
	{productionEnvironment, "CODEXIA_DEPLOY_HOST", "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS"},
}

func plannedProtectedVariables(snapshot githubSnapshot, vm vmObservation, managementHost, pin, target string) ([]protectedVariableWrite, error) {
	var writes []protectedVariableWrite
	if vm.CodexiaPresent {
		snapshot.Bootstrap.Variables = maps.Clone(snapshot.Bootstrap.Variables)
		snapshot.Production.Variables = maps.Clone(snapshot.Production.Variables)
		for _, pair := range managementVariablePairs {
			values := selectEnvironment(snapshot, pair.environment).Variables
			migration, err := managementVariableMigration(values, vm, pair, managementHost, pin, target)
			if err != nil {
				return nil, err
			}
			for _, write := range migration {
				values[write.name] = write.value
			}
			writes = append(writes, migration...)
		}
	}
	desired, err := observedProtectedVariables(snapshot, vm, managementHost, pin, target)
	if err != nil {
		return nil, err
	}
	missing, err := missingVariables(snapshot, desired)
	if err != nil {
		return nil, err
	}
	for _, input := range missing {
		writes = append(writes, protectedVariableWrite{environmentInput: input})
	}
	return writes, nil
}

func (pair managementVariablePair) replace(name, previous, value string) protectedVariableWrite {
	return protectedVariableWrite{environmentInput: environmentInput{pair.environment, name, value}, previous: previous, update: true}
}

func managementVariableMigration(values map[string]string, vm vmObservation, pair managementVariablePair, managementHost, pin, target string) ([]protectedVariableWrite, error) {
	currentHost, currentPins, currentTarget := values[pair.hostName], values[pair.pinName], values[edgeTarget]
	addBinding := matchesPreviousTarget(currentTarget, target, managementHost, true)
	oldLine, newLine, multiple := strings.Cut(strings.TrimSpace(currentPins), "\n")
	staged := multiple && newLine == pin
	switchHost := currentHost != "" && currentHost != managementHost
	if switchHost && multiple && !staged {
		return nil, refused("Existing SSH pin includes unrecognized entries and cannot be migrated")
	}
	removeOldPin := currentHost == managementHost && staged
	if !switchHost && !removeOldPin && !addBinding {
		return nil, nil
	}

	if !addBinding && !matchesPreviousTarget(currentTarget, target, managementHost, false) {
		return nil, refused("An existing SSH destination can only be migrated for the same verified Cloudflare target")
	}
	if err := vm.verifyKnownHosts(managementHost, pin); err != nil {
		return nil, err
	}
	var writes []protectedVariableWrite
	if switchHost || removeOldPin {
		oldHost, oldKey := literalManagementPin(oldLine)
		newHost, newKey := literalManagementPin(pin)
		address, addrErr := netip.ParseAddr(oldHost)
		if (!validDNSHostname(strings.ToLower(oldHost)) && (addrErr != nil || address.Zone() != "")) ||
			oldHost == managementHost || (switchHost && oldHost != currentHost) ||
			newHost != managementHost || oldKey == "" || oldKey != newKey {
			return nil, refused("Existing and replacement SSH pins must identify the same verified VM host key")
		}
		if switchHost {
			if !staged {
				stagedPins := oldLine + "\n" + pin
				writes = append(writes, pair.replace(pair.pinName, currentPins, stagedPins))
				currentPins = stagedPins
			}
			writes = append(writes, pair.replace(pair.hostName, currentHost, managementHost))
		}
		writes = append(writes, pair.replace(pair.pinName, currentPins, pin))
	}
	if addBinding {
		writes = append(writes, pair.replace(edgeTarget, currentTarget, target))
	}
	return writes, nil
}

func literalManagementPin(line string) (host, keyText string) {
	marker, hosts, key, comment, rest, err := ssh.ParseKnownHosts([]byte(line))
	if err != nil || marker != "" || len(hosts) != 1 || comment != "" || len(rest) != 0 {
		return "", ""
	}
	return hosts[0], strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}

func matchesPreviousTarget(previous, verified, managementHost string, absentSSHBinding bool) bool {
	// Reject duplicate JSON keys before comparing any binding. Requiring the same
	// other fields preserves the complete approved Cloudflare identity.
	var previousFields, verifiedFields map[string]json.RawMessage
	if jsonv2.Unmarshal([]byte(previous), &previousFields) != nil || jsonv2.Unmarshal([]byte(verified), &verifiedFields) != nil {
		return false
	}
	var target cloudflareTarget
	if err := jsonv2.Unmarshal([]byte(verified), &target, jsonv2.RejectUnknownMembers(true)); err != nil {
		return false
	}
	if target.Repository == "" || target.RepositoryID <= 0 || target.OwnerID <= 0 || target.Origin == "" ||
		!cloudflareID.MatchString(target.AccountID) || !cloudflareID.MatchString(target.ZoneID) ||
		!cloudflareUUID.MatchString(target.TunnelID) || !cloudflareUUID.MatchString(target.AuthorPolicyID) ||
		!cloudflareUUID.MatchString(target.CIPolicyID) || !cloudflareUUID.MatchString(target.SSHPolicyID) ||
		target.SSHHostname != managementHost || target.TunnelTeamName == "" {
		return false
	}
	if absentSSHBinding {
		delete(verifiedFields, "sshHostname")
		delete(verifiedFields, "sshPolicyId")
	}
	return reflect.DeepEqual(previousFields, verifiedFields)
}
