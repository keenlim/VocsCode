/** Agatho: a floating assistant that drives the app through its capability allowlist.
 *  Portalled to the body and mounted outside the view switch, so it stays put wherever
 *  the user goes and wherever they drag it. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentItem, AgentProposal } from '../../../shared/agent';
import { AGENT_NAME } from '../../../shared/agent';
import { invoke } from '../api';
import { useStore, toastError } from '../store';
import { askConfirm, Button, Icon, Spinner } from './ui';

const PANEL_W = 360;
const PANEL_H = 460;
const AVATAR = 52;
/** Pointer travel below this counts as a click, not a drag. */
const DRAG_SLOP = 4;

interface Point {
  x: number;
  y: number;
}

function clamp(p: Point, w: number, h: number): Point {
  return {
    x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - h - 8))
  };
}

export function Agatho() {
  const settings = useStore((s) => s.settings);
  const agent = useStore((s) => s.agent);
  const activeId = useStore((s) => s.activeId);
  const view = useStore((s) => s.view);
  const prefill = useStore((s) => s.agentPrefill);
  const stored = settings?.agent;

  // Collapsed lives in settings so other parts of the UI can open Agatho (see store.openAgatho).
  const collapsed = stored?.collapsed !== false;
  const [pos, setPos] = useState<Point | null>(null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const width = collapsed ? AVATAR : PANEL_W;
  const height = collapsed ? AVATAR : PANEL_H;

  // First paint: use the stored corner, else park it bottom-right out of the composer's way.
  useLayoutEffect(() => {
    if (pos) return;
    const x = typeof stored?.x === 'number' ? stored.x : window.innerWidth - PANEL_W - 24;
    const y = typeof stored?.y === 'number' ? stored.y : window.innerHeight - PANEL_H - 24;
    setPos(clamp({ x, y }, width, height));
  }, [pos, stored?.x, stored?.y, width, height]);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p, width, height) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width, height]);

  useEffect(() => {
    if (!collapsed) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [agent.items, collapsed]);

  useEffect(() => {
    if (!prefill || collapsed) return;
    setText(prefill.text);
    inputRef.current?.focus();
  }, [prefill, collapsed]);

  const persist = useCallback((patch: { x?: number; y?: number; collapsed?: boolean }) => {
    void invoke('settings:update', { agent: { ...(useStore.getState().settings?.agent ?? {}), ...patch } }).catch(() => undefined);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pos) return;
    if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = { x: e.clientX - d.dx, y: e.clientY - d.dy };
    if (Math.abs(next.x - (pos?.x ?? 0)) > DRAG_SLOP || Math.abs(next.y - (pos?.y ?? 0)) > DRAG_SLOP) d.moved = true;
    setPos(clamp(next, width, height));
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) {
      if (pos) persist({ x: Math.round(pos.x), y: Math.round(pos.y) });
    } else if (collapsed) {
      toggle();
    }
  };

  const toggle = () => persist({ collapsed: !collapsed });

  const send = () => {
    const message = text.trim();
    if (!message || agent.busy) return;
    setText('');
    void invoke('agent:send', { text: message, context: { sessionId: activeId ?? undefined, view } }).catch(toastError);
  };

  if (!settings || settings.agent?.enabled === false || !pos) return null;

  const style: React.CSSProperties = { left: pos.x, top: pos.y, width, height: collapsed ? AVATAR : undefined };

  if (collapsed) {
    return createPortal(
      <div
        className={`agatho agatho-avatar ${agent.busy ? 'busy' : ''}`}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="button"
        tabIndex={0}
        aria-label={`Open ${AGENT_NAME}`}
        title={`${AGENT_NAME} — the in-app assistant`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {agent.busy ? <Spinner size={18} /> : <Icon name="sparkles" size={22} />}
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="agatho agatho-panel" style={style} role="dialog" aria-label={AGENT_NAME}>
      <div className="agatho-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <Icon name="sparkles" size={15} />
        <strong>{AGENT_NAME}</strong>
        {agent.model && <span className="agatho-model" title="Model answering — set it under Settings → Models">{agent.model}</span>}
        <span className="spacer" />
        <button className="icon-btn" title="Clear the conversation" aria-label="Clear the conversation" onClick={() => void invoke('agent:reset', undefined).catch(toastError)}>
          <Icon name="trash" size={13} />
        </button>
        <button className="icon-btn" title="Minimize" aria-label="Minimize" onClick={toggle}>
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="agatho-list" ref={listRef}>
        {agent.unavailable ? (
          <div className="agatho-empty">
            <Icon name="alert" size={15} />
            <span>{agent.unavailable}</span>
          </div>
        ) : agent.items.length === 0 ? (
          <div className="agatho-empty">
            <span>
              I can set up MCP servers, start sessions and tidy branches. Try <em>“set up the https://mcp.example.com/mcp server”</em> or{' '}
              <em>“which branches here are older than a day?”</em>
            </span>
          </div>
        ) : (
          agent.items.map((item) => <AgathoRow key={item.id} item={item} />)
        )}
      </div>

      <div className="agatho-compose">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          placeholder={`Ask ${AGENT_NAME}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {agent.busy ? (
          <button className="icon-btn danger" title="Stop" aria-label="Stop" onClick={() => void invoke('agent:cancel', undefined).catch(toastError)}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button className="icon-btn" title="Send" aria-label="Send" disabled={!text.trim()} onClick={send}>
            <Icon name="send" size={14} />
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}

function AgathoRow({ item }: { item: AgentItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="agatho-msg agatho-user">{item.text}</div>;
    case 'assistant':
      return <div className="agatho-msg agatho-assistant">{item.text}</div>;
    case 'error':
      return (
        <div className="agatho-msg agatho-err">
          <Icon name="alert" size={12} /> {item.text}
        </div>
      );
    case 'tool':
      return (
        <div className={`agatho-tool ${item.ok ? '' : 'failed'}`} title={item.detail}>
          <Icon name={item.ok ? 'check' : 'alert'} size={11} /> <span>{item.summary}</span>
        </div>
      );
    case 'proposal':
      return <ProposalCard proposal={item.proposal} />;
  }
}

function ProposalCard({ proposal }: { proposal: AgentProposal }) {
  const pending = proposal.status === 'pending';
  const danger = proposal.tier === 'destructive';
  const decide = async (approve: boolean) => {
    if (approve && danger) {
      const ok = await askConfirm({
        title: proposal.actions.length === 1 ? proposal.actions[0].summary : `Apply ${proposal.actions.length} destructive changes?`,
        body: (
          <ul className="agatho-confirm-list">
            {proposal.actions.map((a, i) => (
              <li key={i}>{a.summary}</li>
            ))}
          </ul>
        ),
        confirmLabel: 'Apply',
        danger: true
      });
      if (!ok) return;
    }
    await invoke('agent:resolve', { proposalId: proposal.id, approve }).catch(toastError);
  };
  return (
    <div className={`agatho-proposal ${danger ? 'danger' : ''} ${proposal.status}`}>
      <div className="agatho-proposal-head">
        <Icon name={danger ? 'alert' : 'bolt'} size={12} />
        <span>{proposal.title}</span>
      </div>
      <ul>
        {proposal.actions.map((a, i) => (
          <li key={i}>
            <span>{a.summary}</span>
            {proposal.results?.[i] && <em className={proposal.results[i] === 'Done' ? 'ok' : 'bad'}>{proposal.results[i]}</em>}
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="agatho-proposal-actions">
          <Button size="sm" variant={danger ? 'danger' : 'primary'} onClick={() => void decide(true)}>
            {proposal.actions.length === 1 ? 'Apply' : `Apply all ${proposal.actions.length}`}
          </Button>
          <Button size="sm" onClick={() => void decide(false)}>
            Decline
          </Button>
        </div>
      ) : (
        <div className="agatho-proposal-status">{proposal.status}</div>
      )}
    </div>
  );
}
