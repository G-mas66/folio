import { useEffect, useRef, type RefObject } from 'react';

export type ChatTurnNavigationItem = { id: string | number; excerpt: string };

export function ChatTurnNavigation({ turns, activeId, containerRef, onNavigate }: {
  turns: readonly ChatTurnNavigationItem[];
  activeId?: string | number | null;
  containerRef: RefObject<HTMLElement | null>;
  onNavigate?: (id: string | number) => void;
}) {
  const activeMarkRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeMarkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  if (!turns.length) return null;

  function navigate(turn: ChatTurnNavigationItem) {
    const container = containerRef.current;
    const target = Array.from(container?.querySelectorAll<HTMLElement>('[data-chat-turn-id]') || [])
      .find((node) => node.dataset.chatTurnId === String(turn.id));
    if (container && target) {
      const containerBox = container.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const top = container.scrollTop + targetBox.top - containerBox.top - (container.clientHeight - target.clientHeight) / 2;
      container.scrollTo({ top, behavior: 'smooth' });
    }
    onNavigate?.(turn.id);
  }

  return <nav className="chat-turn-navigation" aria-label="对话问题导航">
    <div className="chat-turn-navigation-list" style={{
      height: `max(100%, ${turns.length * 22}px)`,
      gridTemplateRows: `repeat(${turns.length}, minmax(22px, 1fr))`,
    }}>
      {turns.map((turn) => <button key={turn.id} type="button"
        ref={String(activeId) === String(turn.id) ? activeMarkRef : null}
        className={`chat-turn-mark${String(activeId) === String(turn.id) ? ' is-active' : ''}`}
        aria-label={`跳到问题：${turn.excerpt}`} aria-current={String(activeId) === String(turn.id) ? 'location' : undefined}
        title={turn.excerpt} data-excerpt={turn.excerpt} onClick={() => navigate(turn)} />)}
    </div>
  </nav>;
}
