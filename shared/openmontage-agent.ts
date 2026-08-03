/**
 * Public browser/BFF contract for the OpenMontage proof of concept.
 *
 * Deliberately absent: prompts, skills, tool schemas, provider credentials,
 * server paths and executable editor actions. Those are private server/runtime
 * implementation details.
 */

export const OPENMONTAGE_AGENT_API_PREFIX = '/api/agent' as const;

export interface OpenMontageCreateRunRequest {
  readonly projectId: string;
  readonly message: string;
  readonly referenceAssetIds: readonly string[];
  readonly baseRevision: string;
  readonly clientRequestId: string;
  readonly askOnly?: boolean;
}

export type OpenMontageRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface OpenMontageCreateRunResponse {
  readonly runId: string;
  readonly status: OpenMontageRunStatus;
  readonly eventsUrl: string;
  readonly createdAt: number;
  /** True when clientRequestId resolved to an already-created identical run. */
  readonly reused: boolean;
}

export interface OpenMontageRunActionRequest {
  readonly action: 'approve' | 'revise';
  readonly stage?: string;
  readonly feedback?: string;
}

export interface OpenMontageRunActionResponse {
  readonly runId: string;
  readonly status: OpenMontageRunStatus;
}

export interface OpenMontagePublishedAsset {
  readonly id: string;
  readonly name: string;
  readonly kind: 'video';
  /** Same-origin URL beneath /media/uploads; never a server filesystem path. */
  readonly src: string;
  readonly durationInFrames: number;
  readonly width?: number;
  readonly height?: number;
  readonly sourceSize: number;
  readonly sourceModifiedAt: number;
}

export interface OpenMontageEditorProposalData {
  /** The frontend must reject this proposal if its current revision differs. */
  readonly baseRevision: string;
  readonly summary: string;
  readonly asset: OpenMontagePublishedAsset;
}

export type OpenMontagePublicEventType =
  | 'run.accepted'
  | 'run.started'
  | 'stage.started'
  | 'model.started'
  | 'tool.started'
  | 'tool.completed'
  | 'stage.reviewed'
  | 'stage.approved'
  | 'stage.revision_requested'
  | 'stage.awaiting_approval'
  | 'stage.completed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'editor.proposal';

export interface OpenMontageSseEvent<T = unknown> {
  /** Monotonic within one run and used as the SSE Last-Event-ID. */
  readonly id: number;
  readonly runId: string;
  readonly type: OpenMontagePublicEventType;
  readonly timestamp: number;
  readonly data: T;
}

export interface OpenMontageErrorResponse {
  readonly error: string;
  readonly code?: string;
}

/** Must stay byte-for-byte compatible with the editor's revisionOf(ProjectDoc). */
export function openMontageProjectRevision(doc: { readonly version: number }): string {
  const input = JSON.stringify(doc);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v${doc.version}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
