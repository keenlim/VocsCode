/**
 * Right-click menus. One host, mounted by App, renders whatever `showContextMenu` was last handed,
 * anchored at the cursor — the same imperative shape as askConfirm, so any row or panel can offer a
 * menu without threading state through its parents.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export type ContextMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      /** Name from the renderer icon set; the label indents to match when the menu has any icon. */
      icon?: string;
      /** Right-aligned hint, typically the keyboard shortcut that does the same thing. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

interface OpenMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Anything with the bits of a mouse event the menu needs, so callers can pass React or DOM events. */
interface MenuEvent {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

let menuHost: ((m: OpenMenu | null) => void) | null = null;

/** Drops separators that would render at an edge or next to another one. */
function tidy(items: ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push(item);
    } else out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * Opens the menu at the event's cursor and swallows the browser's own. A target that should keep
 * the native menu — a text field, where cut/copy/paste/undo matter — must not call this.
 */
export function showContextMenu(e: MenuEvent, items: ContextMenuItem[]): void {
  const usable = tidy(items);
  if (!menuHost || usable.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  menuHost({ x: e.clientX, y: e.clientY, items: usable });
}

/** Closes whatever menu is open; a no-op when there is none. */
export function closeContextMenu(): void {
  menuHost?.(null);
}

/** True when the event started inside something that owns its own editing menu. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
  );
}

const ITEM_SELECTOR = '.menu-item:not(:disabled)';

/** Mounted once by App; renders whatever showContextMenu is currently offering. */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuHost = setMenu;
    return () => {
      menuHost = null;
    };
  }, []);

  // Keep the menu on screen: it opens at the cursor and flips back over it near an edge.
  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const maxX = window.innerWidth - w - 4;
    const maxY = window.innerHeight - h - 4;
    setPos({ x: Math.max(4, Math.min(menu.x, maxX)), y: Math.max(4, Math.min(menu.y, maxY)) });
    el?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const focusAt = (index: number) => {
        e.preventDefault();
        items[(index + items.length) % items.length].focus();
      };
      if (e.key === 'ArrowDown') focusAt(at === -1 ? 0 : at + 1);
      else if (e.key === 'ArrowUp') focusAt(at === -1 ? items.length - 1 : at - 1);
      else if (e.key === 'Home') focusAt(0);
      else if (e.key === 'End') focusAt(items.length - 1);
    };
    // A right-click elsewhere closes this menu before the new target opens its own: this listener
    // is on the document in capture, so it always runs before React's delegated handler.
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('contextmenu', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    // Scrolling the list under an open menu would leave it pointing at the wrong row.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('contextmenu', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  const withIcons = menu.items.some((i) => !i.separator && i.icon);
  return (
    <div
      ref={ref}
      className="context-menu dropdown-menu"
      role="menu"
      data-testid="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="menu-sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              setMenu(null);
              item.onSelect();
            }}
          >
            {withIcons && (item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu-item-gap" aria-hidden />)}
            <span className="menu-item-label">{item.label}</span>
            {item.hint && <span className="menu-item-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  );
}
