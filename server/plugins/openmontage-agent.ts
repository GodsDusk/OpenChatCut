import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Plugin } from 'vite';

import type {
  OpenMontageCreateRunRequest,
  OpenMontageCreateRunResponse,
  OpenMontageEditorProposalData,
  OpenMontagePublicEventType,
  OpenMontagePublishedAsset,
  OpenMontageRunActionRequest,
  OpenMontageRunStatus,
  OpenMontageSseEvent,
} from '../../shared/openmontage-agent.ts';
import { openMontageProjectRevision } from '../../shared/openmontage-agent.ts';
import { readStore } from './project-store.ts';
import {
  isSafeUploadName,
  resolveOrHydrateUploadFile,
  uploadDir,
} from '../media-dir.ts';
import { ffprobeBin } from '../media-binaries.ts';
import { getKey, getServerOnly, KEY_NAMES, SERVER_ONLY_NAMES } from '../keystore.ts';

export const OPENMONTAGE_BODY_LIMIT = 64 * 1024;
export const OPENMONTAGE_RUNTIME_LINE_LIMIT = 512 * 1024;
export const OPENMONTAGE_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;
export const OPENMONTAGE_MAX_REFERENCE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_EVENTS_PER_RUN = 2_048;
const MAX_RUNS = 1_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;
const RUN_ID = /^[a-f0-9-]{36}$/;
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const ASSET_ID = /^[a-zA-Z0-9:_-]{1,200}$/;
const REQUEST_ID = /^[a-zA-Z0-9:_-]{1,200}$/;
const REVISION = /^[a-zA-Z0-9_-]{1,128}$/;
const STAGE = /^[a-zA-Z0-9_.-]{1,100}$/;
const PUBLIC_EVENT_TYPES = new Set<OpenMontagePublicEventType>([
  'run.started', 'stage.started', 'model.started', 'tool.started', 'tool.completed',
  'stage.reviewed', 'stage.approved', 'stage.revision_requested',
  'stage.awaiting_approval', 'stage.completed', 'run.completed',
  'run.failed', 'run.cancelled',
]);

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

interface ProjectAsset {
  id: string;
  name: string;
  kind: string;
  src: string;
}

interface ProjectDocument {
  version: number;
  assets: ProjectAsset[];
  timelines: Array<{ id?: string; fps?: number }>;
  activeTimelineId?: string;
  [key: string]: unknown;
}

export interface OpenMontageRuntimeAsset {
  readonly assetId: string;
  readonly path: string;
  readonly mimeType?: string;
  readonly name?: string;
}

export interface OpenMontageRuntimeInput {
  readonly action: 'start' | 'approve' | 'revise';
  readonly runId: string;
  readonly projectId: string;
  readonly message?: string;
  readonly allowPlanningOnly?: boolean;
  readonly workspace: string;
  readonly assets: readonly OpenMontageRuntimeAsset[];
  readonly stage?: string;
  readonly feedback?: string;
}

export interface OpenMontageRuntimeHandle {
  cancel(): void;
}

export type OpenMontageRuntimeLauncher = (
  input: OpenMontageRuntimeInput,
  onEvent: (event: unknown) => Promise<void> | void,
  onExit: (error?: Error) => Promise<void> | void,
) => OpenMontageRuntimeHandle;

interface PublishedVideoInput {
  path: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

interface OpenMontageAgentDependencies {
  loadStore: typeof readStore;
  resolveUpload: typeof resolveOrHydrateUploadFile;
  workspaceRoot: string;
  uploadDirectory: () => string;
  launchRuntime: OpenMontageRuntimeLauncher;
  publishVideo: (
    output: PublishedVideoInput,
    runId: string,
    fps: number,
    workspace: string,
  ) => Promise<OpenMontagePublishedAsset>;
  now: () => number;
  id: () => string;
}

interface RunRecord {
  id: string;
  request: OpenMontageCreateRunRequest;
  fingerprint: string;
  createdAt: number;
  status: OpenMontageRunStatus;
  workspace: string;
  fps: number;
  assets: OpenMontageRuntimeAsset[];
  events: OpenMontageSseEvent[];
  nextEventId: number;
  subscribers: Set<ServerResponse>;
  process: OpenMontageRuntimeHandle | null;
  published: OpenMontagePublishedAsset | null;
  terminalEvent: boolean;
}

const object = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function requestProtocol(req: IncomingMessage): 'http' | 'https' {
  return (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? 'https' : 'http';
}

/** Browser requests carrying an Origin must match this exact server origin. */
export function isOpenMontageSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (Array.isArray(origin) || Array.isArray(host) || !host) return false;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  try {
    return new URL(origin).origin === new URL(`${requestProtocol(req)}://${host}`).origin;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > OPENMONTAGE_BODY_LIMIT) {
    req.resume();
    throw new HttpError(413, 'body_too_large', 'request body too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > OPENMONTAGE_BODY_LIMIT) {
      req.resume();
      throw new HttpError(413, 'body_too_large', 'request body too large');
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid_json', 'body must be valid JSON');
  }
  const body = object(parsed);
  if (!body) throw new HttpError(400, 'invalid_body', 'body must be a JSON object');
  return body;
}

function createRunRequest(value: Record<string, unknown>): OpenMontageCreateRunRequest {
  const allowed = new Set([
    'projectId', 'message', 'referenceAssetIds', 'baseRevision', 'clientRequestId', 'askOnly',
  ]);
  if (!exactKeys(value, allowed)) throw new HttpError(400, 'unknown_field', 'request contains an unsupported field');
  const projectId = typeof value.projectId === 'string' ? value.projectId : '';
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  const baseRevision = typeof value.baseRevision === 'string' ? value.baseRevision : '';
  const clientRequestId = typeof value.clientRequestId === 'string' ? value.clientRequestId : '';
  if (!PROJECT_ID.test(projectId)) throw new HttpError(400, 'invalid_project_id', 'invalid projectId');
  if (!message || message.length > 32_000) throw new HttpError(400, 'invalid_message', 'message must contain 1 to 32000 characters');
  if (!REVISION.test(baseRevision)) throw new HttpError(400, 'invalid_revision', 'invalid baseRevision');
  if (!REQUEST_ID.test(clientRequestId)) throw new HttpError(400, 'invalid_request_id', 'invalid clientRequestId');
  if (value.askOnly !== undefined && typeof value.askOnly !== 'boolean') {
    throw new HttpError(400, 'invalid_ask_only', 'askOnly must be a boolean');
  }
  if (!Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 32) {
    throw new HttpError(400, 'invalid_asset_ids', 'referenceAssetIds must be an array of at most 32 ids');
  }
  const referenceAssetIds = value.referenceAssetIds.map((id) => {
    if (typeof id !== 'string' || !ASSET_ID.test(id)) {
      throw new HttpError(400, 'invalid_asset_ids', 'referenceAssetIds contains an invalid id');
    }
    return id;
  });
  if (new Set(referenceAssetIds).size !== referenceAssetIds.length) {
    throw new HttpError(400, 'duplicate_asset_id', 'referenceAssetIds must not contain duplicates');
  }
  return { projectId, message, referenceAssetIds, baseRevision, clientRequestId, askOnly: value.askOnly === true };
}

function actionRequest(value: Record<string, unknown>): OpenMontageRunActionRequest {
  if (!exactKeys(value, new Set(['action', 'stage', 'feedback']))) {
    throw new HttpError(400, 'unknown_field', 'action request contains an unsupported field');
  }
  if (value.action !== 'approve' && value.action !== 'revise') {
    throw new HttpError(400, 'invalid_action', 'action must be approve or revise');
  }
  const stage = value.stage === undefined ? undefined : String(value.stage);
  const feedback = value.feedback === undefined ? undefined : String(value.feedback).trim();
  if (stage !== undefined && !STAGE.test(stage)) throw new HttpError(400, 'invalid_stage', 'invalid stage');
  if (feedback !== undefined && feedback.length > 8_000) throw new HttpError(400, 'invalid_feedback', 'feedback is too long');
  if (value.action === 'revise' && !feedback) throw new HttpError(400, 'feedback_required', 'revise requires feedback');
  return { action: value.action, ...(stage ? { stage } : {}), ...(feedback ? { feedback } : {}) };
}

function projectDocument(value: unknown): ProjectDocument | null {
  const doc = object(value);
  if (!doc || typeof doc.version !== 'number' || !Array.isArray(doc.assets) || !Array.isArray(doc.timelines)) return null;
  const assets: ProjectAsset[] = [];
  for (const value of doc.assets) {
    const asset = object(value);
    if (!asset || typeof asset.id !== 'string' || typeof asset.name !== 'string'
      || typeof asset.kind !== 'string' || typeof asset.src !== 'string') return null;
    // Preserve the complete JSON object: project revision hashing is structural.
    assets.push(asset as unknown as ProjectAsset);
  }
  return { ...doc, version: doc.version, assets, timelines: doc.timelines as ProjectDocument['timelines'] };
}

/** Resolve only canonical OpenChatCut upload URLs, never arbitrary client paths. */
export function openMontageUploadName(src: string): string | null {
  const prefix = '/media/uploads/';
  if (!src.startsWith(prefix) || src.includes('?') || src.includes('#')) return null;
  const name = src.slice(prefix.length);
  try {
    // Project documents persist raw upload names. Encoded separators introduce a
    // second interpretation at an HTTP/filesystem boundary, so reject all such
    // ambiguous paths instead of decoding client-controlled text.
    if (decodeURIComponent(name) !== name) return null;
  } catch {
    return null;
  }
  return isSafeUploadName(name) ? name : null;
}

function mimeFromName(name: string): string | undefined {
  const extension = extname(name).toLowerCase();
  if (['.mp4', '.m4v'].includes(extension)) return 'video/mp4';
  if (extension === '.mov') return 'video/quicktime';
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.m4a') return 'audio/mp4';
  return undefined;
}

function projectFps(doc: ProjectDocument): number {
  const timeline = doc.timelines.find((candidate) => candidate.id === doc.activeTimelineId) ?? doc.timelines[0];
  const fps = Number(timeline?.fps);
  return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30;
}

function requestFingerprint(request: OpenMontageCreateRunRequest): string {
  return JSON.stringify({
    projectId: request.projectId,
    message: request.message,
    referenceAssetIds: request.referenceAssetIds,
    baseRevision: request.baseRevision,
    askOnly: request.askOnly === true,
  });
}

/** True only when candidate resolves beneath root (not root itself). */
export function isOpenMontagePathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function runtimeVideo(value: unknown): PublishedVideoInput | null {
  const entry = object(value);
  if (!entry || entry.kind !== 'video' || typeof entry.path !== 'string') return null;
  return {
    path: entry.path,
    durationSeconds: numberOrUndefined(entry.durationSeconds),
    width: numberOrUndefined(entry.width),
    height: numberOrUndefined(entry.height),
  };
}

function completedVideo(event: Record<string, unknown>): PublishedVideoInput | null {
  const data = object(event.data);
  const artifacts = object(event.artifacts) ?? object(data?.artifacts);
  const compose = object(artifacts?.compose);
  return runtimeVideo(event.output)
    ?? runtimeVideo(data?.output)
    ?? runtimeVideo(compose?.output);
}

function sanitized(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.length > 16_000 ? `${value.slice(0, 16_000)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitized(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (/^(?:path|workspace|prompt|systemPrompt|skills?|toolSchemas?)$/i.test(key)) continue;
    result[key] = sanitized(child, depth + 1);
  }
  return result;
}

function eventData(event: Record<string, unknown>): unknown {
  const type = event.type;
  const string = (key: string) => typeof event[key] === 'string' ? event[key] : undefined;
  if (type === 'tool.started' || type === 'tool.completed') {
    return { stage: string('stage'), tool: string('tool') };
  }
  if (type === 'model.started') {
    return { stage: string('stage'), mode: string('mode'), round: numberOrUndefined(event.round) };
  }
  if (type === 'stage.started' || type === 'stage.completed' || type === 'stage.approved') {
    return { stage: string('stage') };
  }
  if (type === 'stage.revision_requested') {
    return { stage: string('stage'), feedback: string('feedback') };
  }
  if (type === 'stage.reviewed') {
    return {
      stage: string('stage'), round: numberOrUndefined(event.round),
      decision: string('decision'), findings: sanitized(event.findings),
    };
  }
  if (type === 'stage.awaiting_approval') {
    return { stage: string('stage'), review: sanitized(event.review), artifacts: sanitized(event.artifacts) };
  }
  if (type === 'run.failed') {
    const error = object(event.error);
    return { message: typeof error?.message === 'string' ? error.message : 'OpenMontage runtime failed' };
  }
  if (type === 'run.cancelled') return { reason: string('reason') };
  const { runId: _runId, seq: _seq, type: _type, timestamp: _timestamp, ...rest } = event;
  return sanitized(rest);
}

function writeSse(res: ServerResponse, event: OpenMontageSseEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function terminal(status: OpenMontageRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function probeVideo(file: string): Promise<{ durationSeconds: number; width?: number; height?: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height', '-of', 'json', file,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-64_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
        const durationSeconds = Number(parsed.format?.duration);
        if (code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
        resolvePromise({
          durationSeconds,
          width: numberOrUndefined(parsed.streams?.[0]?.width),
          height: numberOrUndefined(parsed.streams?.[0]?.height),
        });
      } catch {
        reject(new Error('unable to probe OpenMontage output video'));
      }
    });
  });
}

/** Validate the runtime path and atomically publish a verified MP4 into OpenChatCut storage. */
export async function publishOpenMontageVideo(
  output: PublishedVideoInput,
  runId: string,
  fps: number,
  workspace: string,
  directory = uploadDir(),
  probe: (file: string) => Promise<{ durationSeconds: number; width?: number; height?: number }> = probeVideo,
): Promise<OpenMontagePublishedAsset> {
  if (extname(output.path).toLowerCase() !== '.mp4') throw new Error('OpenMontage output must be an MP4');
  const workspaceReal = await realpath(workspace);
  const outputInfo = await lstat(output.path);
  if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) throw new Error('OpenMontage output must be a regular file');
  const outputReal = await realpath(output.path);
  if (!isOpenMontagePathInside(workspaceReal, outputReal)) throw new Error('OpenMontage output escaped its run workspace');
  if (outputInfo.size <= 0 || outputInfo.size > OPENMONTAGE_MAX_OUTPUT_BYTES) throw new Error('OpenMontage output has an invalid size');
  const handle = await open(outputReal, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead < 12 || header.subarray(4, 8).toString('ascii') !== 'ftyp') {
      throw new Error('OpenMontage output is not an MP4 file');
    }
  } finally {
    await handle.close();
  }

  // Runtime metadata is model/tool output and therefore advisory only. The
  // published editor asset always uses independently probed media facts.
  const probed = await probe(outputReal);
  await mkdir(directory, { recursive: true });
  const filename = `openmontage-${runId}.mp4`;
  if (!isSafeUploadName(filename)) throw new Error('invalid OpenMontage publication name');
  const target = join(directory, filename);
  const partial = join(directory, `.${filename}.${randomUUID()}.part`);
  try {
    await copyFile(outputReal, partial, fsConstants.COPYFILE_EXCL);
    // Hard-link gives an atomic, no-overwrite publication boundary.
    await link(partial, target);
  } finally {
    await unlink(partial).catch(() => undefined);
  }
  const published = await stat(target);
  return {
    id: `openmontage_${runId.replaceAll('-', '')}`,
    name: basename(filename),
    kind: 'video',
    src: `/media/uploads/${filename}`,
    durationInFrames: Math.max(1, Math.round(probed.durationSeconds * fps)),
    ...(probed.width ? { width: Math.round(probed.width) } : {}),
    ...(probed.height ? { height: Math.round(probed.height) } : {}),
    sourceSize: published.size,
    sourceModifiedAt: published.mtimeMs,
  };
}

function defaultRuntimeLauncher(
  input: OpenMontageRuntimeInput,
  onEvent: (event: unknown) => Promise<void> | void,
  onExit: (error?: Error) => Promise<void> | void,
): OpenMontageRuntimeHandle {
  const executable = getServerOnly('OPENMONTAGE_PYTHON') || process.env.OPENMONTAGE_PYTHON?.trim() || 'python3';
  const runtimeEnv = { ...process.env };
  for (const name of KEY_NAMES) {
    const value = getKey(name);
    if (value) runtimeEnv[name] = value;
  }
  for (const name of SERVER_ONLY_NAMES) {
    const value = getServerOnly(name);
    if (value) runtimeEnv[name] = value;
  }
  const child = spawn(executable, ['-m', 'server.openmontage_runtime.cli'], {
    cwd: process.cwd(),
    env: runtimeEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputQueue = Promise.resolve();
  let exited = false;
  let invalidOutput: Error | undefined;

  const acceptLine = (line: string) => {
    if (!line.trim()) return;
    outputQueue = outputQueue.then(async () => {
      if (Buffer.byteLength(line) > OPENMONTAGE_RUNTIME_LINE_LIMIT) {
        invalidOutput = new Error('OpenMontage runtime event exceeded the size limit');
        child.kill('SIGKILL');
        return;
      }
      try {
        await onEvent(JSON.parse(line));
      } catch (error) {
        invalidOutput = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGKILL');
      }
    });
  };
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (Buffer.byteLength(stdout) > OPENMONTAGE_RUNTIME_LINE_LIMIT) {
      invalidOutput = new Error('OpenMontage runtime output line exceeded the size limit');
      child.kill('SIGKILL');
      return;
    }
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      acceptLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_000); });
  child.once('error', (error) => {
    if (exited) return;
    exited = true;
    void outputQueue.finally(() => onExit(error));
  });
  child.once('close', (code, signal) => {
    if (exited) return;
    exited = true;
    if (stdout.trim()) acceptLine(stdout);
    void outputQueue.finally(() => {
      const error = invalidOutput ?? (code === 0 ? undefined : new Error(
        `OpenMontage runtime exited ${signal ?? code}: ${stderr.trim() || 'no diagnostic output'}`,
      ));
      return onExit(error);
    });
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return { cancel: () => child.kill('SIGTERM') };
}

const defaultDependencies: OpenMontageAgentDependencies = {
  loadStore: readStore,
  resolveUpload: resolveOrHydrateUploadFile,
  workspaceRoot: join(homedir(), '.openchatcut', 'openmontage-runs'),
  uploadDirectory: uploadDir,
  launchRuntime: defaultRuntimeLauncher,
  publishVideo: (output, runId, fps, workspace) => publishOpenMontageVideo(output, runId, fps, workspace),
  now: Date.now,
  id: randomUUID,
};

export interface OpenMontageAgentHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): void;
}

/** Connect-compatible handler. Its mounted paths are /runs and /runs/:id/*. */
export function createOpenMontageAgentHandler(
  overrides: Partial<OpenMontageAgentDependencies> = {},
): OpenMontageAgentHandler {
  const dependencies = { ...defaultDependencies, ...overrides };
  const runs = new Map<string, RunRecord>();
  const idempotency = new Map<string, { runId: string; fingerprint: string; createdAt: number }>();

  const append = <T>(run: RunRecord, type: OpenMontagePublicEventType, data: T): OpenMontageSseEvent<T> => {
    const event: OpenMontageSseEvent<T> = {
      id: run.nextEventId++, runId: run.id, type, timestamp: dependencies.now(), data,
    };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
    for (const subscriber of run.subscribers) writeSse(subscriber, event);
    if (terminal(run.status)) {
      for (const subscriber of run.subscribers) subscriber.end();
      run.subscribers.clear();
    }
    return event;
  };

  const fail = (run: RunRecord, error: unknown) => {
    if (terminal(run.status)) return;
    run.status = 'failed';
    run.process = null;
    run.terminalEvent = true;
    append(run, 'run.failed', { message: error instanceof Error ? error.message : String(error) });
  };

  const handleRuntimeEvent = async (run: RunRecord, raw: unknown): Promise<void> => {
    if (terminal(run.status)) return;
    const event = object(raw);
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!event || !PUBLIC_EVENT_TYPES.has(type as OpenMontagePublicEventType)) {
      throw new Error('OpenMontage runtime emitted an invalid event');
    }
    if (event.runId !== undefined && event.runId !== run.id) throw new Error('OpenMontage runtime emitted a foreign run id');
    if (type === 'run.started') run.status = 'running';
    if (type === 'stage.awaiting_approval') run.status = 'awaiting_approval';
    if (type === 'run.failed') {
      run.status = 'failed';
      run.terminalEvent = true;
    }
    if (type === 'run.cancelled') {
      run.status = 'cancelled';
      run.terminalEvent = true;
    }
    if (type === 'run.completed') {
      const output = completedVideo(event);
      const completedData = object(event.data);
      const summary = typeof event.summary === 'string' ? event.summary
        : typeof completedData?.summary === 'string' ? completedData.summary
          : run.request.askOnly
            ? 'OpenMontage 已完成方案分析。'
            : 'OpenMontage 已生成完整视频，可添加到当前时间线。';
      if (output) {
        if (run.published) throw new Error('OpenMontage runtime emitted more than one final video');
        run.published = await dependencies.publishVideo(output, run.id, run.fps, run.workspace);
        const proposal: OpenMontageEditorProposalData = {
          baseRevision: run.request.baseRevision,
          summary: summary.slice(0, 4_000),
          asset: run.published,
        };
        append(run, 'editor.proposal', proposal);
      } else if (!run.request.askOnly) {
        throw new Error('OpenMontage completed without a final video');
      }
      run.status = 'completed';
      run.terminalEvent = true;
      append(run, 'run.completed', { hasProposal: Boolean(run.published), summary: summary.slice(0, 4_000) });
      return;
    }
    append(run, type as OpenMontagePublicEventType, eventData(event));
  };

  const launch = (run: RunRecord, input: OpenMontageRuntimeInput) => {
    if (run.process) throw new HttpError(409, 'run_busy', 'run already has an active runtime');
    run.status = 'running';
    try {
      let handle: OpenMontageRuntimeHandle | null = null;
      handle = dependencies.launchRuntime(
        input,
        (event) => handleRuntimeEvent(run, event),
        (error) => {
          if (run.process !== handle) return;
          run.process = null;
          if (error) fail(run, error);
          else if (!run.terminalEvent && run.status !== 'awaiting_approval') {
            fail(run, new Error('OpenMontage runtime exited before a terminal event'));
          }
        },
      );
      run.process = handle;
    } catch (error) {
      fail(run, error);
    }
  };

  const resolveReferences = async (
    doc: ProjectDocument,
    ids: readonly string[],
  ): Promise<OpenMontageRuntimeAsset[]> => {
    const byId = new Map(doc.assets.map((asset) => [asset.id, asset]));
    const resolved: OpenMontageRuntimeAsset[] = [];
    let totalBytes = 0;
    for (const id of ids) {
      const asset = byId.get(id);
      if (!asset) throw new HttpError(400, 'asset_not_in_project', `reference asset does not belong to project: ${id}`);
      const name = openMontageUploadName(asset.src);
      if (!name) throw new HttpError(400, 'invalid_asset_path', `reference asset has an invalid upload path: ${id}`);
      const file = await dependencies.resolveUpload(name);
      if (!file) throw new HttpError(400, 'asset_unavailable', `reference asset is unavailable: ${id}`);
      const info = await stat(file.file);
      if (!info.isFile()) throw new HttpError(400, 'asset_unavailable', `reference asset is not a file: ${id}`);
      totalBytes += info.size;
      if (totalBytes > OPENMONTAGE_MAX_REFERENCE_BYTES) {
        throw new HttpError(413, 'references_too_large', 'reference assets exceed the total size limit');
      }
      resolved.push({ assetId: id, path: file.file, name: asset.name, mimeType: file.contentType || mimeFromName(name) });
    }
    return resolved;
  };

  const prune = () => {
    const cutoff = dependencies.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of idempotency) if (entry.createdAt < cutoff) idempotency.delete(key);
    if (runs.size <= MAX_RUNS) return;
    for (const [id, run] of runs) {
      if (runs.size <= MAX_RUNS) break;
      if (terminal(run.status) && run.subscribers.size === 0) runs.delete(id);
    }
  };

  const createRun = async (req: IncomingMessage, res: ServerResponse) => {
    const request = createRunRequest(await readJson(req));
    const fingerprint = requestFingerprint(request);
    const key = `${request.projectId}\0${request.clientRequestId}`;
    prune();
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new HttpError(409, 'idempotency_conflict', 'clientRequestId was already used with a different request');
      }
      const run = runs.get(prior.runId);
      if (!run) throw new HttpError(409, 'idempotency_expired', 'the idempotent run is no longer available');
      const response: OpenMontageCreateRunResponse = {
        runId: run.id, status: run.status, eventsUrl: `/api/agent/runs/${run.id}/events`,
        createdAt: run.createdAt, reused: true,
      };
      sendJson(res, 200, response);
      return;
    }

    const store = await dependencies.loadStore();
    const doc = projectDocument(store.entries[`project:${request.projectId}`]);
    if (!doc) throw new HttpError(404, 'project_not_found', 'project was not found');
    const currentRevision = openMontageProjectRevision(doc);
    if (request.baseRevision !== currentRevision) {
      throw new HttpError(409, 'stale_revision', 'project changed; refresh before starting OpenMontage');
    }
    const assets = await resolveReferences(doc, request.referenceAssetIds);
    const id = dependencies.id();
    if (!RUN_ID.test(id)) throw new Error('run id generator returned an unsafe id');
    const workspace = join(dependencies.workspaceRoot, id);
    if (!isOpenMontagePathInside(dependencies.workspaceRoot, workspace)) throw new Error('invalid run workspace');
    await mkdir(dependencies.workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: false, mode: 0o700 });
    const run: RunRecord = {
      id, request, fingerprint, createdAt: dependencies.now(), status: 'queued', workspace,
      fps: projectFps(doc), assets, events: [], nextEventId: 1, subscribers: new Set(),
      process: null, published: null, terminalEvent: false,
    };
    runs.set(id, run);
    idempotency.set(key, { runId: id, fingerprint, createdAt: run.createdAt });
    append(run, 'run.accepted', { status: run.status });
    const response: OpenMontageCreateRunResponse = {
      runId: id, status: run.status, eventsUrl: `/api/agent/runs/${id}/events`,
      createdAt: run.createdAt, reused: false,
    };
    sendJson(res, 201, response);
    queueMicrotask(() => launch(run, {
      action: 'start', runId: id, projectId: request.projectId, message: request.message,
      allowPlanningOnly: request.askOnly, workspace, assets,
    }));
  };

  const streamEvents = (req: IncomingMessage, res: ServerResponse, run: RunRecord) => {
    const rawLastId = req.headers['last-event-id'];
    const lastId = rawLastId === undefined ? 0 : Number(rawLastId);
    if (Array.isArray(rawLastId) || !Number.isSafeInteger(lastId) || lastId < 0) {
      throw new HttpError(400, 'invalid_event_id', 'invalid Last-Event-ID');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    for (const event of run.events) if (event.id > lastId) writeSse(res, event);
    if (terminal(run.status)) {
      res.end();
      return;
    }
    run.subscribers.add(res);
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      run.subscribers.delete(res);
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
  };

  const takeAction = async (req: IncomingMessage, res: ServerResponse, run: RunRecord) => {
    if (run.status !== 'awaiting_approval') {
      throw new HttpError(409, 'run_not_awaiting_approval', 'run is not awaiting approval');
    }
    const action = actionRequest(await readJson(req));
    // The checkpoint event is emitted immediately before the one-shot Python
    // process exits. Give that process a short drain window so a fast click on
    // “approve” cannot race with its close callback.
    for (let attempt = 0; run.process && attempt < 80; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (run.process) throw new HttpError(409, 'run_busy', 'previous OpenMontage stage is still closing');
    launch(run, {
      action: action.action, runId: run.id, projectId: run.request.projectId,
      workspace: run.workspace, assets: run.assets, stage: action.stage, feedback: action.feedback,
    });
    sendJson(res, 202, { runId: run.id, status: run.status });
  };

  const cancelRun = async (req: IncomingMessage, res: ServerResponse, run: RunRecord) => {
    const body = await readJson(req);
    if (Object.keys(body).length) throw new HttpError(400, 'unknown_field', 'cancel request body must be empty');
    if (terminal(run.status)) {
      sendJson(res, 200, { runId: run.id, status: run.status });
      return;
    }
    const process = run.process;
    run.process = null;
    run.status = 'cancelled';
    run.terminalEvent = true;
    process?.cancel();
    append(run, 'run.cancelled', { message: 'cancelled by user' });
    sendJson(res, 202, { runId: run.id, status: run.status });
  };

  const handler = (async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isOpenMontageSameOrigin(req)) throw new HttpError(403, 'cross_origin', 'cross-origin agent requests are not allowed');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/runs') {
        await createRun(req, res);
        return;
      }
      const match = /^\/runs\/([a-f0-9-]{36})\/(events|actions|cancel)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'not_found', 'agent endpoint not found');
      const run = runs.get(match[1]!);
      if (!run) throw new HttpError(404, 'run_not_found', 'run was not found');
      if (req.method === 'GET' && match[2] === 'events') {
        streamEvents(req, res, run);
        return;
      }
      if (req.method === 'POST' && match[2] === 'actions') {
        await takeAction(req, res, run);
        return;
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        await cancelRun(req, res, run);
        return;
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      const message = error instanceof HttpError ? error.message : 'OpenMontage agent request failed';
      sendJson(res, status, { error: message, code });
    }
  }) as OpenMontageAgentHandler;
  handler.close = () => {
    for (const run of runs.values()) {
      run.process?.cancel();
      for (const subscriber of run.subscribers) subscriber.end();
      run.subscribers.clear();
    }
    runs.clear();
    idempotency.clear();
  };
  return handler;
}

export function openMontageAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-openmontage-agent',
    configureServer(server) {
      const handler = createOpenMontageAgentHandler();
      server.middlewares.use('/api/agent', (req, res) => {
        void handler(req, res).catch((error) => {
          server.config.logger.error(`[openmontage-agent] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'OpenMontage agent request failed', code: 'internal_error' });
        });
      });
      return () => handler.close();
    },
  };
}
