import {
  OPENMONTAGE_AGENT_API_PREFIX,
  type OpenMontageCreateRunRequest,
  type OpenMontageCreateRunResponse,
  type OpenMontageErrorResponse,
  type OpenMontageRunActionRequest,
  type OpenMontageRunActionResponse,
  type OpenMontageSseEvent,
} from '../../shared/openmontage-agent';

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | OpenMontageErrorResponse | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `OpenMontage request failed (${response.status})`;
    throw new Error(message);
  }
  if (!body) throw new Error('OpenMontage returned an empty response.');
  return body as T;
}

export async function createOpenMontageRun(
  request: OpenMontageCreateRunRequest,
  signal?: AbortSignal,
): Promise<OpenMontageCreateRunResponse> {
  const response = await fetch(`${OPENMONTAGE_AGENT_API_PREFIX}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  return responseJson<OpenMontageCreateRunResponse>(response);
}

export async function actOnOpenMontageRun(
  runId: string,
  action: OpenMontageRunActionRequest,
  signal?: AbortSignal,
): Promise<OpenMontageRunActionResponse> {
  const response = await fetch(`${OPENMONTAGE_AGENT_API_PREFIX}/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
    signal,
  });
  return responseJson<OpenMontageRunActionResponse>(response);
}

export async function cancelOpenMontageRun(runId: string): Promise<void> {
  const response = await fetch(`${OPENMONTAGE_AGENT_API_PREFIX}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
  await responseJson<Record<string, unknown>>(response);
}

function parseSsePayload(payload: string): OpenMontageSseEvent | null {
  try {
    const event = JSON.parse(payload) as Partial<OpenMontageSseEvent>;
    return typeof event.id === 'number' && typeof event.runId === 'string' && typeof event.type === 'string'
      ? event as OpenMontageSseEvent
      : null;
  } catch {
    return null;
  }
}

/**
 * EventSource deliberately receives only public progress events. Prompts,
 * skills, tool inputs and credentials never cross this browser boundary.
 */
export function subscribeOpenMontageRun(
  eventsUrl: string,
  onEvent: (event: OpenMontageSseEvent) => void,
  onTransportError?: () => void,
): () => void {
  const source = new EventSource(eventsUrl);
  const receive = (raw: Event) => {
    const event = raw as MessageEvent<string>;
    const parsed = parseSsePayload(event.data);
    if (parsed) onEvent(parsed);
  };
  source.onmessage = receive;
  for (const type of [
    'run.accepted', 'run.started', 'stage.started', 'model.started', 'tool.started',
    'tool.completed', 'stage.reviewed', 'stage.approved', 'stage.revision_requested',
    'stage.awaiting_approval', 'stage.completed',
    'run.completed', 'run.failed', 'run.cancelled', 'editor.proposal',
  ]) source.addEventListener(type, receive);
  source.onerror = () => onTransportError?.();
  return () => source.close();
}
