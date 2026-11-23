"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefCallback } from "react";

/**
 * Порог near-bottom для фактического scroll container чата. Если пользователь
 * отстоит от нижней границы не дальше 48 px, новые сообщения и resize считаются
 * следованием за концом; дальше — это чтение выше, и scrollTop не меняется.
 */
export const CHAT_NEAR_BOTTOM_THRESHOLD_PX = 48;

export interface ChatScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Геометрия для записи scrollTop; контейнер — реальный HTMLElement. */
export interface WritableChatScrollGeometry {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface ChatScrollMessage {
  readonly id: string;
  readonly text: string;
}

export interface ChatScrollOptions {
  readonly sessionID: string | null;
  readonly messages: readonly ChatScrollMessage[];
}

export interface ChatScrollController {
  /** Реальный scroll container; focus target для возврата к концу. */
  readonly containerRef: RefCallback<HTMLDivElement>;
  /** Внутренний content wrapper; наблюдается ResizeObserver. */
  readonly contentRef: RefCallback<HTMLDivElement>;
  readonly following: boolean;
  readonly unread: number;
  /** Явно включает следование (новый prompt/retry) и прокручивает к концу. */
  readonly followNow: () => void;
  /** Возврат по кнопке: follow, конец истории и перенос фокуса на контейнер. */
  readonly jumpToLatest: (options?: { readonly focus?: boolean }) => void;
}

/** Расстояние от текущей позиции до нижней границы scroll container. */
export function chatScrollDistanceFromBottom(geometry: ChatScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight);
}

/** Near-bottom detection по реальным scrollTop/scrollHeight/clientHeight. */
export function isChatNearBottom(
  geometry: ChatScrollGeometry,
  threshold = CHAT_NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return chatScrollDistanceFromBottom(geometry) <= threshold;
}

/** Максимальный scrollTop контейнера без выхода за границы контента. */
export function chatMaxScrollTop(geometry: ChatScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
}

/**
 * Мгновенно удерживает низ. Smooth scroll намеренно не используется: промежуточные
 * scroll events от анимации нельзя надёжно отличить от ручной прокрутки.
 * Возвращает true, если позиция действительно изменилась.
 */
export function scrollChatToBottom(geometry: WritableChatScrollGeometry): boolean {
  const next = chatMaxScrollTop(geometry);
  if (geometry.scrollTop === next) return false;
  geometry.scrollTop = next;
  return true;
}

/**
 * Дешёвая подпись содержимого для unread: identity и длина текста сообщений.
 * Повторный canonical refresh с тем же содержимым не считается новым сообщением.
 */
export function chatContentSignature(messages: readonly ChatScrollMessage[]): string {
  let signature = "";
  for (const message of messages) signature += `${message.id}:${message.text.length};`;
  return signature;
}

/** Счётчик новых сообщений для badge; большие значения не ломают layout. */
export function formatChatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Управляет прокруткой ленты чата без виртуализации и IntersectionObserver:
 *
 * - follow включается только у нижней границы фактического контейнера;
 * - при чтении выше streaming/tool/canonical обновления не меняют scrollTop;
 * - смена session открывает конец новой истории и сбрасывает unread;
 * - динамические высоты (ResizeObserver контейнера/контента, window resize,
 *   capture load/error изображений) удерживают низ только в режиме follow.
 *
 * Generation/abort в scroll-логику не входят: stale messages уже отсекаются
 * существующими guards до setMessages.
 */
export function useChatScroll({ sessionID, messages }: ChatScrollOptions): ChatScrollController {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [following, setFollowingState] = useState(true);
  const [unread, setUnreadState] = useState(0);

  const containerElementRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const unreadRef = useRef(0);
  const previousRef = useRef<{
    readonly sessionID: string | null;
    readonly signature: string;
    readonly length: number;
  } | null>(null);

  const containerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    containerElementRef.current = node;
    setContainer(node);
  }, []);
  const contentRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setContent(node);
  }, []);

  const applyFollowing = useCallback((next: boolean): void => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const applyUnread = useCallback((next: number): void => {
    if (unreadRef.current === next) return;
    unreadRef.current = next;
    setUnreadState(next);
  }, []);

  const bumpUnread = useCallback((growth: number): void => {
    const next = growth > 0 ? unreadRef.current + growth : Math.max(unreadRef.current, 1);
    if (next === unreadRef.current) return;
    unreadRef.current = next;
    setUnreadState(next);
  }, []);

  /**
   * Следование и unread пересчитываются после commit сообщений, поэтому высота
   * уже отражает новый контент. StrictMode-повтор идемпотентен: повторный вызов
   * видит неизменившуюся подпись и уже нижний scrollTop.
   */
  useIsomorphicLayoutEffect(() => {
    const element = containerElementRef.current;
    const signature = chatContentSignature(messages);
    const previous = previousRef.current;
    const sessionChanged = previous === null || previous.sessionID !== sessionID;

    if (sessionChanged) {
      previousRef.current = { sessionID, signature, length: messages.length };
      if (previous !== null) {
        applyFollowing(true);
        applyUnread(0);
      }
      if (element !== null) scrollChatToBottom(element);
      return;
    }

    const changed = previous.signature !== signature || previous.length !== messages.length;
    previousRef.current = { sessionID, signature, length: messages.length };

    if (followingRef.current) {
      if (element !== null) scrollChatToBottom(element);
      applyUnread(0);
      return;
    }

    if (!changed) return;
    // Чтение выше: scrollTop не трогаем, только показываем новые сообщения.
    bumpUnread(Math.max(0, messages.length - previous.length));
  }, [applyFollowing, applyUnread, bumpUnread, container, messages, sessionID]);

  /** Passive scroll listener: ручной уход от низа выключает follow. */
  useEffect(() => {
    if (container === null) return;
    const onScroll = (): void => {
      const near = isChatNearBottom(container);
      applyFollowing(near);
      if (near) applyUnread(0);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [applyFollowing, applyUnread, container]);

  /**
   * Динамические высоты: content/container ResizeObserver, window resize как
   * fallback без ResizeObserver, capture load/error для image preview, а также
   * раскрытие tool `<details>` и resize textarea/панели через те же observers.
   * При чтении выше обработчики ничего не прокручивают.
   */
  useEffect(() => {
    if (container === null) return;
    const maintain = (): void => {
      if (!followingRef.current) return;
      scrollChatToBottom(container);
    };
    const Resize = globalThis.ResizeObserver;
    const observer = typeof Resize === "function" ? new Resize(maintain) : null;
    observer?.observe(container);
    if (content !== null) observer?.observe(content);

    window.addEventListener("resize", maintain);
    container.addEventListener("load", maintain, true);
    container.addEventListener("error", maintain, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", maintain);
      container.removeEventListener("load", maintain, true);
      container.removeEventListener("error", maintain, true);
    };
  }, [container, content]);

  const followNow = useCallback((): void => {
    applyFollowing(true);
    applyUnread(0);
    const element = containerElementRef.current;
    if (element !== null) scrollChatToBottom(element);
  }, [applyFollowing, applyUnread]);

  const jumpToLatest = useCallback(
    (options?: { readonly focus?: boolean }): void => {
      applyFollowing(true);
      applyUnread(0);
      const element = containerElementRef.current;
      if (element === null) return;
      scrollChatToBottom(element);
      if (options?.focus === true) {
        // Кнопка размонтируется после возврата; фокус переходит на контейнер,
        // не вызывая дополнительный scroll от браузера.
        try {
          element.focus({ preventScroll: true });
        } catch {
          element.focus();
        }
      }
    },
    [applyFollowing, applyUnread],
  );

  return { containerRef, contentRef, following, unread, followNow, jumpToLatest };
}
