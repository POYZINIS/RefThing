export interface HealthStatus {
  status: string;
  version: string;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as HealthStatus;
}
