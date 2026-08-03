import assert from 'node:assert/strict';
import { actOnOpenMontageRun, cancelOpenMontageRun, createOpenMontageRun } from './openmontageClient';
import { openMontageProjectRevision } from '../../shared/openmontage-agent';
import { revisionOf } from './external-edit-session';
import type { ProjectDoc } from '../editor/types';

const doc = { version: 14, assets: [], timelines: [], activeTimelineId: 'main' } as unknown as ProjectDoc;
assert.equal(openMontageProjectRevision(doc), revisionOf(doc), 'browser and editor revisions must remain byte-compatible');

const previousFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push({ url, init });
  if (url.endsWith('/actions')) return new Response(JSON.stringify({ runId: 'run-1', status: 'running' }));
  if (url.endsWith('/cancel')) return new Response(JSON.stringify({ runId: 'run-1', status: 'cancelled' }));
  return new Response(JSON.stringify({ runId: 'run-1', status: 'queued', eventsUrl: '/api/agent/runs/run-1/events', createdAt: 1, reused: false }));
};

try {
  const created = await createOpenMontageRun({
    projectId: 'project-1', message: 'make a video', referenceAssetIds: ['asset-1'],
    baseRevision: openMontageProjectRevision(doc), clientRequestId: 'request-1',
  });
  assert.equal(created.runId, 'run-1');
  await actOnOpenMontageRun('run-1', { action: 'revise', feedback: 'make it shorter' });
  await cancelOpenMontageRun('run-1');
  assert.deepEqual(requests.map((request) => [request.url, request.init?.method]), [
    ['/api/agent/runs', 'POST'],
    ['/api/agent/runs/run-1/actions', 'POST'],
    ['/api/agent/runs/run-1/cancel', 'POST'],
  ]);
} finally {
  globalThis.fetch = previousFetch;
}
