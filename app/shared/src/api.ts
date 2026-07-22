// HTTP / WebSocket message shapes shared between backend and frontend.
// The universal entity vocabulary lives in vocabulary.ts and nowhere else;
// everything here is a transport-layer envelope around it.

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}
