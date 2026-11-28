package main

import "context"

// Write scopes are needed only for init. The pinned cf cannot read Workers
// Routes or Custom Domains itself. Init can request a short-lived, verified
// account API token for those reads; the read-only commands never issue one.
func cloudflareRequirementsFor(snapshot githubSnapshot) cfDeviceRequirements {
	requirements := cfDeviceRequirements{accountTokenCreate: true, allowTemporaryObservation: true}
	for _, input := range missingSecrets(snapshot) {
		switch input.name {
		case sshAccessSecret, cloudflareProbeSecret:
			requirements.accessTokenWrite = true
		case cloudflareWorkerRole:
			requirements.workerScriptsWrite = true
		}
	}
	return requirements
}

func (r cfDeviceRequirements) requireConnectorToken(needed bool) cfDeviceRequirements {
	r.tunnelToken = needed
	return r
}

func startCloudflareSession(ctx context.Context, o operator, host, managementHost string, requirements cfDeviceRequirements) (*cfRuntime, error) {
	runtime, err := prepareCloudflareRuntime(ctx)
	if err != nil {
		return nil, err
	}
	if err := runtime.deviceLogin(ctx, o, host, managementHost, requirements); err != nil {
		if cleanupErr := runtime.close(); cleanupErr != nil {
			o.Notice(cleanupErr.Error())
		}
		return nil, err
	}
	return runtime, nil
}
