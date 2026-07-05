export interface RegistryObservabilityEnv {
  ANALYTICS_QUEUE?: Queue;
  ENVIRONMENT?: string;
  APP_VERSION?: string;
}

export function observabilityEnv(env: RegistryObservabilityEnv) {
  return { ...env, SERVICE_NAME: 'construct-app-registry' };
}
