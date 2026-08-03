import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMontageProjectRevision } from '../../shared/openmontage-agent.ts';
import {
  createOpenMontageAgentHandler,
  isOpenMontagePathInside,
  OPENMONTAGE_BODY_LIMIT,
  OPENMONTAGE_MAX_OUTPUT_BYTES,
  openMontageUploadName,
  publishOpenMontageVideo,
  type OpenMontageRuntimeHandle,
  type OpenMontageRuntimeInput,
} from './openmontage-agent.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-openmontage-verify-'));
const references = join(root, 'references');
const workspaces = join(root, 'workspaces');
const uploads = join(root, 'uploads');
await Promise.all([
  mkdir(references, { recursive: true }),
  mkdir(workspaces, { recursive: true }),
  mkdir(uploads, { recursive: true }),
]);
const referenceFile = join(references, 'clip.mp4');
await writeFile(referenceFile, 'reference');

const project = {
  version: 3,
  assets: [{
    id: 'asset-1', name: 'clip.mp4', kind: 'video', src: '/media/uploads/clip.mp4',
    durationInFrames: 90, sourceRevision: 'source-1',
  }],
  mediaFolders: [],
  timelines: [{
    id: 'tl-1', name: 'Sequence', order: 0, fps: 30, width: 1920, height: 1080,
    items: [], selectedId: null, trackOrder: ['track_v1'], tracks: { track_v1: { kind: 'video' } },
  }],
  activeTimelineId: 'tl-1',
};
const revision = openMontageProjectRevision(project);

interface Launch {
  input: OpenMontageRuntimeInput;
  emit: (event: unknown) => Promise<void>;
  exit: (error?: Error) => Promise<void>;
  cancelled: boolean;
}
const launches: Launch[] = [];
let idCounter = 0;
const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
const handler = createOpenMontageAgentHandler({
  loadStore: async () => ({ version: 1 as const, entries: { 'project:project-1': project } }),
  resolveUpload: async (name) => name === 'clip.mp4'
    ? { file: referenceFile, contentType: 'video/mp4', bytes: 9, cached: true }
    : null,
  workspaceRoot: workspaces,
  uploadDirectory: () => uploads,
  id: () => ids[idCounter++]!,
  now: (() => { let value = 1_700_000_000_000; return () => value++; })(),
  launchRuntime: (input, onEvent, onExit): OpenMontageRuntimeHandle => {
    const launch: Launch = {
      input,
      emit: async (event) => { await onEvent(event); },
      exit: async (error) => { await onExit(error); },
      cancelled: false,
    };
    launches.push(launch);
    return { cancel: () => { launch.cancelled = true; } };
  },
  publishVideo: async (_output, runId, fps) => ({
    id: `openmontage_${runId.replaceAll('-', '')}`,
    name: `openmontage-${runId}.mp4`,
    kind: 'video',
    src: `/media/uploads/openmontage-${runId}.mp4`,
    durationInFrames: fps * 2,
    width: 1920,
    height: 1080,
    sourceSize: 1_024,
    sourceModifiedAt: 123,
  }),
});

const server = createServer((req, res) => { void handler(req, res); });
await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

async function post(path: string, body: unknown, requestOrigin = origin): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

const request = {
  projectId: 'project-1',
  message: 'Make a polished two-second cut',
  referenceAssetIds: ['asset-1'],
  baseRevision: revision,
  clientRequestId: 'request-1',
  askOnly: false,
};

try {
  assert.equal(openMontageUploadName('/media/uploads/clip.mp4'), 'clip.mp4');
  assert.equal(openMontageUploadName('/media/uploads/../secret'), null);
  assert.equal(openMontageUploadName('/media/uploads/%2e%2e%2fsecret'), null);
  assert.equal(openMontageUploadName('/media/uploads/clip.mp4?token=x'), null);
  assert.equal(isOpenMontagePathInside(workspaces, join(workspaces, 'run', 'final.mp4')), true);
  assert.equal(isOpenMontagePathInside(workspaces, join(root, 'outside.mp4')), false);

  const foreign = await post('/runs', request, 'https://evil.example');
  assert.equal(foreign.status, 403, 'cross-origin POST is rejected');

  const oversized = await post('/runs', {
    ...request,
    clientRequestId: 'oversized',
    message: 'x'.repeat(OPENMONTAGE_BODY_LIMIT + 1),
  });
  assert.equal(oversized.status, 413, 'body limit is enforced before JSON validation');

  const unknownField = await post('/runs', { ...request, prompt: 'private prompt must never be accepted' });
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json() as { code: string }).code, 'unknown_field');

  const stale = await post('/runs', { ...request, clientRequestId: 'stale', baseRevision: 'v3-deadbeef' });
  assert.equal(stale.status, 409, 'stale project revisions cannot launch the runtime');

  const foreignAsset = await post('/runs', {
    ...request, clientRequestId: 'foreign-asset', referenceAssetIds: ['asset-2'],
  });
  assert.equal(foreignAsset.status, 400, 'asset ids are authorized against the project document');

  const created = await post('/runs', request);
  assert.equal(created.status, 201);
  const first = await created.json() as { runId: string; reused: boolean; eventsUrl: string };
  assert.equal(first.runId, ids[0]);
  assert.equal(first.reused, false);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.input.assets[0]!.path, referenceFile, 'runtime receives the server-resolved path');
  assert.equal('prompt' in launches[0]!.input, false, 'public prompt/tool payloads are not proxied');
  assert.equal(launches[0]!.input.allowPlanningOnly, false);

  const replay = await post('/runs', request);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { runId: string; reused: boolean }).runId, first.runId);
  assert.equal(launches.length, 1, 'identical clientRequestId is idempotent');

  const conflict = await post('/runs', { ...request, message: 'Different work' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code: string }).code, 'idempotency_conflict');

  await launches[0]!.emit({
    runId: first.runId,
    seq: 1,
    type: 'tool.started',
    timestamp: 1,
    data: { tool: 'compose', path: '/private/secret/final.mp4', prompt: 'private system prompt' },
  });
  await launches[0]!.emit({
    runId: first.runId,
    seq: 2,
    type: 'run.completed',
    timestamp: 2,
    data: {
      summary: 'Ready to review',
      output: { kind: 'video', path: join(workspaces, first.runId, 'final.mp4'), durationSeconds: 2 },
    },
  });
  await launches[0]!.exit();
  const eventResponse = await fetch(`${origin}${first.eventsUrl}`, { headers: { Origin: origin } });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /^text\/event-stream/);
  const eventText = await eventResponse.text();
  assert.match(eventText, /event: editor\.proposal/);
  assert.match(eventText, /event: run\.completed/);
  assert.match(eventText, /"baseRevision":"v3-/);
  assert.match(eventText, /\/media\/uploads\/openmontage-/);
  assert.doesNotMatch(eventText, /\/private\/secret|private system prompt|final\.mp4"/,
    'SSE does not expose private paths or prompts');
  const replayAfterOne = await fetch(`${origin}${first.eventsUrl}`, {
    headers: { Origin: origin, 'Last-Event-ID': '1' },
  });
  assert.doesNotMatch(await replayAfterOne.text(), /event: run\.accepted/,
    'Last-Event-ID resumes after the acknowledged event');

  const cancellable = await post('/runs', { ...request, clientRequestId: 'request-2' });
  const second = await cancellable.json() as { runId: string };
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const cancelled = await post(`/runs/${second.runId}/cancel`, {});
  assert.equal(cancelled.status, 202);
  assert.equal(launches[1]!.cancelled, true, 'cancel kills the private runtime process');
  const cancelEvents = await fetch(`${origin}/runs/${second.runId}/events`, { headers: { Origin: origin } });
  assert.match(await cancelEvents.text(), /event: run\.cancelled/);

  const approvable = await post('/runs', { ...request, clientRequestId: 'request-3' });
  const third = await approvable.json() as { runId: string };
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await launches[2]!.emit({ runId: third.runId, seq: 1, type: 'stage.awaiting_approval', timestamp: 1, stage: 'script' });
  await launches[2]!.exit();
  const approved = await post(`/runs/${third.runId}/actions`, { action: 'approve', stage: 'script' });
  assert.equal(approved.status, 202);
  assert.equal(launches[3]!.input.action, 'approve');
  assert.equal(launches[3]!.input.stage, 'script');

  const publishWorkspace = join(root, 'publish-workspace');
  await mkdir(publishWorkspace);
  const validMp4 = join(publishWorkspace, 'final.mp4');
  const header = Buffer.alloc(32);
  header.writeUInt32BE(24, 0);
  header.write('ftyp', 4, 'ascii');
  await writeFile(validMp4, header);
  const published = await publishOpenMontageVideo(
    { path: validMp4, durationSeconds: 2, width: 1920, height: 1080 },
    '10000000-0000-4000-8000-000000000001',
    30,
    publishWorkspace,
    uploads,
    async () => ({ durationSeconds: 2, width: 1920, height: 1080 }),
  );
  assert.equal(published.durationInFrames, 60);
  assert.equal((await readFile(join(uploads, published.name))).subarray(4, 8).toString(), 'ftyp');

  const outside = join(root, 'outside.mp4');
  await writeFile(outside, header);
  await assert.rejects(
    publishOpenMontageVideo(
      { path: outside, durationSeconds: 1, width: 1, height: 1 },
      '20000000-0000-4000-8000-000000000001', 30, publishWorkspace, uploads,
    ),
    /escaped its run workspace/,
  );
  const symlinkOutput = join(publishWorkspace, 'linked.mp4');
  await symlink(outside, symlinkOutput);
  await assert.rejects(
    publishOpenMontageVideo(
      { path: symlinkOutput, durationSeconds: 1, width: 1, height: 1 },
      '30000000-0000-4000-8000-000000000001', 30, publishWorkspace, uploads,
    ),
    /regular file/,
  );
  const huge = join(publishWorkspace, 'huge.mp4');
  await writeFile(huge, header);
  await truncate(huge, OPENMONTAGE_MAX_OUTPUT_BYTES + 1);
  await assert.rejects(
    publishOpenMontageVideo(
      { path: huge, durationSeconds: 1, width: 1, height: 1 },
      '40000000-0000-4000-8000-000000000001', 30, publishWorkspace, uploads,
    ),
    /invalid size/,
  );

  console.log('openmontage-agent.verify: same-origin, limits, paths, SSE and idempotency ok');
} finally {
  handler.close();
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  await rm(root, { recursive: true, force: true });
}
