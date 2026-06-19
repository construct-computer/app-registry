import type { DeploymentOptions } from '@construct/observability';

export function observabilityOptions(env: { ENVIRONMENT?: string }): DeploymentOptions {
  return {
    serviceName: 'construct-app-registry',
    workerName: 'construct-app-registry',
  };
}
