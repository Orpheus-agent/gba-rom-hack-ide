// HTTP / WebSocket message shapes shared between backend and frontend.
// Per MASTER_PROMPT §5, the universal vocabulary stays in vocabulary.ts;
// these are transport-layer envelopes.

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}
