import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentContext, AgentReference } from './context';
import { makeDraft, replayActions } from '../editor/store';
import type { MediaAsset } from '../editor/types';
import { buildOperation, buildProposal, isProposalStale, type Proposal } from './proposal';
import { loadChat, saveChat } from '../persist/projectStore';
import { clearProposal, loadProposal, saveProposal } from '../persist/proposalStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import {
  appendAgentChange,
  canRollbackAgentChange,
  createAgentChangeSession,
  parseAgentChangeLog,
  rollbackAgentChange,
  type AgentChangeSession,
} from './changeLog';
import { actOnOpenMontageRun, cancelOpenMontageRun, createOpenMontageRun, subscribeOpenMontageRun } from './openmontageClient';
import { openMontageProjectRevision, type OpenMontageEditorProposalData, type OpenMontageSseEvent } from '../../shared/openmontage-agent';

export interface OpenMontageDisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'continue';
  text: string;
  thinking?: string;
  tool?: { name: string; args: unknown; result: unknown };
}

type ActiveRun = {
  runId: string;
  baseRevision: string;
  eventsUrl: string;
  awaitingApproval: boolean;
  hasProposal: boolean;
  seenEventIds: Set<number>;
};

type PendingGuardSkill = 'image-gen' | 'motion-graphic-gen' | 'video-gen' | 'audio-gen' | 'gpu-operation' | 'irreversible-export' | 'high-cost-operation';
type PendingGuard = {
  skill: PendingGuardSkill;
  requestedTool?: string;
  tool?: string;
  operationId?: string;
  summary?: string;
  resolve: (decision: 'allow-once' | 'allow-scope' | 'deny') => void;
};

const approvalText = /^(approve|approved|ok|yes|confirm|continue|同意|确认|继续|可以|好的|通过)$/iu;
const sourceKinds = new Set(['video', 'image', 'audio', 'gif', 'svg']);

function referencedAssetIds(ctx: AgentContext, references: AgentReference[]): string[] {
  const doc = ctx.getDoc();
  const state = ctx.getState();
  const bySrc = new Map(doc.assets.map((asset) => [asset.src, asset.id]));
  const ids = new Set<string>();
  const addItem = (itemId: unknown) => {
    if (typeof itemId !== 'string') return;
    const item = state.items.find((candidate) => candidate.id === itemId);
    const assetId = item?.src ? bySrc.get(item.src) : undefined;
    if (assetId) ids.add(assetId);
  };
  for (const reference of references) {
    if (sourceKinds.has(reference.kind) && doc.assets.some((asset) => asset.id === reference.id)) {
      ids.add(reference.id);
      continue;
    }
    const metadata = reference.metadata as unknown as Record<string, unknown> | undefined;
    addItem(metadata?.itemId);
    if (Array.isArray(metadata?.containedItems)) {
      for (const itemId of metadata.containedItems) addItem(itemId);
    }
  }
  return [...ids].slice(0, 32);
}

function eventText(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const item = data as Record<string, unknown>;
    for (const key of ['message', 'summary', 'detail', 'tool', 'stage']) {
      if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
    }
  }
  return fallback;
}

function isEditorProposal(value: unknown): value is OpenMontageEditorProposalData {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OpenMontageEditorProposalData>;
  const asset = item.asset;
  return typeof item.baseRevision === 'string'
    && typeof item.summary === 'string'
    && !!asset
    && typeof asset.id === 'string'
    && typeof asset.name === 'string'
    && asset.kind === 'video'
    && typeof asset.src === 'string'
    && typeof asset.durationInFrames === 'number';
}

function proposalAsset(data: OpenMontageEditorProposalData): MediaAsset {
  return {
    id: data.asset.id,
    name: data.asset.name,
    kind: 'video',
    src: data.asset.src,
    durationInFrames: data.asset.durationInFrames,
    width: data.asset.width,
    height: data.asset.height,
    sourceSize: data.asset.sourceSize,
    sourceModifiedAt: data.asset.sourceModifiedAt,
  };
}

/** Browser adapter for the server-owned OpenMontage pipeline. */
export function useOpenMontageAgent(ctx: AgentContext, projectId: string) {
  const [messages, setMessages] = useState<OpenMontageDisplayMessage[]>([]);
  const [changeLog, setChangeLog] = useState<AgentChangeSession[]>([]);
  const [running, setRunning] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposalStale, setProposalStale] = useState(false);
  // OpenMontage checkpoints are represented by server stage events, not local
  // skill guards. Keep the legacy-shaped field so the chat shell stays stable.
  const [pendingGuard] = useState<PendingGuard | null>(null);
  const [liveTool, setLiveTool] = useState<{ name: string; partial: string } | null>(null);
  const ctxRef = useRef(ctx);
  const proposalRef = useRef<Proposal | null>(null);
  const hydratedRef = useRef(false);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const closeEventsRef = useRef<(() => void) | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);
  const applyingProposalRef = useRef(false);
  ctxRef.current = ctx;
  proposalRef.current = proposal;

  const closeEvents = useCallback(() => {
    closeEventsRef.current?.();
    closeEventsRef.current = null;
  }, []);

  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    setHydrated(false);
    setMessages([]);
    setChangeLog([]);
    setProposal(null);
    setProposalStale(false);
    activeRunRef.current = null;
    closeEvents();
    void Promise.all([loadChat(projectId), loadProposal(projectId)]).then(([saved, pending]) => {
      if (!alive) return;
      setMessages(saved ? saved.messages as OpenMontageDisplayMessage[] : []);
      setChangeLog(parseAgentChangeLog(saved?.changeLog));
      if (pending && !isProposalStale(pending, ctxRef.current.getDoc())) setProposal(pending);
      else if (pending) void clearProposal(projectId);
      hydratedRef.current = true;
      setHydrated(true);
    });
    return () => {
      alive = false;
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      closeEvents();
    };
  }, [projectId, closeEvents]);

  useEffect(() => {
    if (!hydratedRef.current || running) return;
    void saveChat(projectId, { messages, llm: [], changeLog, llmFormat: 'ai-sdk-v1', llmProvider: 'openai' });
    if (proposal) void saveProposal(projectId, proposal);
    else void clearProposal(projectId);
  }, [messages, changeLog, running, proposal, projectId]);

  const finishRun = useCallback((runId: string) => {
    if (activeRunRef.current?.runId !== runId) return;
    closeEvents();
    activeRunRef.current = null;
    setLiveTool(null);
    setRunning(false);
  }, [closeEvents]);

  const consumeEvent = useCallback((event: OpenMontageSseEvent) => {
    const active = activeRunRef.current;
    if (!active || active.runId !== event.runId || active.seenEventIds.has(event.id)) return;
    active.seenEventIds.add(event.id);
    if (event.type === 'stage.started') {
      setLiveTool({ name: eventText(event.data, 'OpenMontage'), partial: '' });
    } else if (event.type === 'tool.started') {
      setLiveTool({ name: eventText(event.data, 'OpenMontage tool'), partial: '' });
    } else if (event.type === 'tool.completed' || event.type === 'stage.completed') {
      setLiveTool(null);
    } else if (event.type === 'stage.awaiting_approval') {
      active.awaitingApproval = true;
      setLiveTool(null);
      setRunning(false);
      const stage = event.data && typeof event.data === 'object' && typeof (event.data as Record<string, unknown>).stage === 'string'
        ? String((event.data as Record<string, unknown>).stage)
        : '当前';
      setMessages((current) => [...current, { role: 'assistant', text: `${stage} 阶段方案已准备好。回复“确认”继续，或直接输入修改意见。` }]);
    } else if (event.type === 'editor.proposal') {
      if (!isEditorProposal(event.data)) {
        setMessages((current) => [...current, { role: 'error', text: '服务端返回了无效的编辑提案。' }]);
        finishRun(event.runId);
        return;
      }
      const currentDoc = ctxRef.current.getDoc();
      if (event.data.baseRevision !== active.baseRevision || event.data.baseRevision !== openMontageProjectRevision(currentDoc)) {
        setMessages((current) => [...current, { role: 'error', text: '生成期间工程发生了修改；为避免覆盖，成片未加入时间线。请重新发送请求。' }]);
        finishRun(event.runId);
        return;
      }
      // Build the existing Proposal against the live document only after the
      // server-supplied revision has proved it is still the run's base.
      const draft = makeDraft(currentDoc);
      const asset = proposalAsset(event.data);
      draft.commands.addAsset(asset);
      draft.commands.addMediaItem(asset);
      const actions = draft.takeActions();
      const operation = buildOperation('openmontage_publish', {
        assetId: asset.id, name: asset.name, rationale: event.data.summary,
      }, actions);
      active.hasProposal = true;
      setProposalStale(false);
      setProposal(buildProposal([operation], event.data.summary, currentDoc, draft.getState()));
      setMessages((current) => [...current, { role: 'assistant', text: event.data.summary }]);
    } else if (event.type === 'run.failed') {
      setMessages((current) => [...current, { role: 'error', text: eventText(event.data, 'OpenMontage 运行失败。') }]);
      finishRun(event.runId);
    } else if (event.type === 'run.cancelled') {
      setMessages((current) => [...current, { role: 'assistant', text: '已停止生成。' }]);
      finishRun(event.runId);
    } else if (event.type === 'run.completed') {
      if (!active.hasProposal) setMessages((current) => [...current, { role: 'assistant', text: eventText(event.data, '任务已完成。') }]);
      finishRun(event.runId);
    }
  }, [finishRun]);

  const connectEvents = useCallback((run: ActiveRun) => {
    closeEvents();
    closeEventsRef.current = subscribeOpenMontageRun(run.eventsUrl, consumeEvent, () => {
      // EventSource reconnects automatically. A terminal event remains the source
      // of truth so transient network failures do not incorrectly fail a run.
    });
  }, [closeEvents, consumeEvent]);

  const send = useCallback(async (text: string, opts?: { askOnly?: boolean; references?: AgentReference[] }) => {
    const message = text.trim();
    if (!message || running || proposalRef.current) return;
    const waiting = activeRunRef.current;
    setMessages((current) => [...current, { role: 'user', text: message }]);
    if (waiting?.awaitingApproval) {
      setRunning(true);
      waiting.awaitingApproval = false;
      try {
        await actOnOpenMontageRun(waiting.runId, approvalText.test(message)
          ? { action: 'approve' }
          : { action: 'revise', feedback: message });
      } catch (error) {
        waiting.awaitingApproval = true;
        setRunning(false);
        setMessages((current) => [...current, { role: 'error', text: error instanceof Error ? error.message : '无法提交审批回复。' }]);
      }
      return;
    }
    const baseDoc = ctxRef.current.getDoc();
    const baseRevision = openMontageProjectRevision(baseDoc);
    const runAbort = new AbortController();
    createAbortRef.current = runAbort;
    setRunning(true);
    try {
      const created = await createOpenMontageRun({
        projectId,
        message,
        referenceAssetIds: referencedAssetIds(ctxRef.current, opts?.references ?? []),
        baseRevision,
        clientRequestId: crypto.randomUUID(),
        askOnly: opts?.askOnly,
      }, runAbort.signal);
      const run: ActiveRun = {
        runId: created.runId,
        baseRevision,
        eventsUrl: created.eventsUrl,
        awaitingApproval: created.status === 'awaiting_approval',
        hasProposal: false,
        seenEventIds: new Set(),
      };
      createAbortRef.current = null;
      activeRunRef.current = run;
      connectEvents(run);
      if (run.awaitingApproval) setRunning(false);
    } catch (error) {
      if (!runAbort.signal.aborted) {
        setMessages((current) => [...current, { role: 'error', text: error instanceof Error ? error.message : '无法创建 OpenMontage 任务。' }]);
      }
      createAbortRef.current = null;
      setRunning(false);
    }
  }, [running, projectId, connectEvents]);

  const stop = useCallback(() => {
    const active = activeRunRef.current;
    if (!active) {
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      setRunning(false);
      return;
    }
    closeEvents();
    activeRunRef.current = null;
    setLiveTool(null);
    setRunning(false);
    void cancelOpenMontageRun(active.runId).catch((error: unknown) => {
      setMessages((current) => [...current, { role: 'error', text: error instanceof Error ? error.message : '无法取消 OpenMontage 任务。' }]);
    });
  }, [closeEvents]);

  const enhance = useCallback(async (draft: string) => draft, []);

  const doApply = useCallback(async (selected: Set<number>) => {
    const current = proposalRef.current;
    if (!current || applyingProposalRef.current) return;
    applyingProposalRef.current = true;
    const currentDoc = ctxRef.current.getDoc();
    const chosen = current.options[0].operations.filter((_, index) => selected.has(index));
    const result = replayActions(currentDoc, chosen.flatMap((operation) => operation.actions));
    try {
      await saveAutomaticVersion(projectId, 'Agent 修改前', currentDoc);
      if (proposalRef.current !== current || ctxRef.current.getDoc() !== currentDoc) {
        setProposalStale(true);
        return;
      }
      ctxRef.current.commands.applyDoc(result);
      setChangeLog((sessions) => appendAgentChange(sessions, createAgentChangeSession(current.summary, chosen, currentDoc, result)));
      setProposalStale(false);
      setProposal(null);
    } catch {
      setMessages((items) => [...items, { role: 'error', text: '无法创建修改前版本，提案未应用。请检查本地存储后重试。' }]);
    } finally {
      applyingProposalRef.current = false;
    }
  }, [projectId]);

  const applyProposal = useCallback((selected: Set<number>) => {
    const current = proposalRef.current;
    if (!current) return;
    if (isProposalStale(current, ctxRef.current.getDoc())) { setProposalStale(true); return; }
    void doApply(selected);
  }, [doApply]);
  const forceApplyProposal = useCallback((selected: Set<number>) => { void doApply(selected); }, [doApply]);
  const reProposeStale = useCallback(() => {
    setProposalStale(false);
    setProposal(null);
    setMessages((items) => [...items, { role: 'assistant', text: '工程已变化，请重新描述希望生成的成片。' }]);
  }, []);
  const rejectProposal = useCallback(() => { setProposalStale(false); setProposal(null); }, []);
  const clearHistory = useCallback(() => {
    if (running) return;
    setMessages([]);
    setProposal(null);
    void clearProposal(projectId);
  }, [running, projectId]);
  const rollbackChangeSession = useCallback((id: string, force = false) => {
    const session = changeLog.find((item) => item.id === id);
    const previous = session && rollbackAgentChange(session, ctxRef.current.getDoc(), force);
    if (!previous) return false;
    ctxRef.current.commands.applyDoc(previous);
    return true;
  }, [changeLog]);
  const canRollbackChangeSession = useCallback((id: string) => {
    const session = changeLog.find((item) => item.id === id);
    return !!session && canRollbackAgentChange(session, ctxRef.current.getDoc());
  }, [changeLog]);

  return {
    messages, running, hydrated, send, stop, enhance, clearHistory,
    proposal, applyProposal, rejectProposal, proposalStale, forceApplyProposal, reProposeStale,
    pendingGuard, liveTool, changeLog, rollbackChangeSession, canRollbackChangeSession,
  };
}
