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
 * Identity новых или изменённых сообщений для unread. Чистое удаление истории и
 * canonical no-op с тем же текстом ничего не добавляют; streamed delta и
 * canonical replacement с другим текстом считаются изменением своего message ID.
 */
export function chatUnreadIDs(
  previous: readonly ChatScrollMessage[],
  next: readonly ChatScrollMessage[],
): string[] {
  const previousText = new Map(previous.map((message) => [message.id, message.text]));
  const ids: string[] = [];
  for (const message of next) {
    if (previousText.get(message.id) !== message.text) ids.push(message.id);
  }
  return ids;
}

/** Счётчик новых сообщений для badge; большие значения не ломают layout. */
export function formatChatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ChatGeometrySnapshot {
  readonly maxScrollTop: number;
}

interface ChatMessagesSnapshot {
  readonly sessionID: string | null;
  readonly messages: readonly ChatScrollMessage[];
}

/**
 * Управляет прокруткой ленты чата без виртуализации и IntersectionObserver:
 *
 * - follow включается только у нижней границы фактического контейнера;
 * - при чтении выше streaming/tool/canonical обновления не меняют scrollTop;
 * - смена session открывает конец новой истории и сбрасывает unread;
 * - динамические высоты (ResizeObserver контейнера/контента, window resize,
 *   capture load/error изображений, toggle/details и pointer/keyboard fallback)
 *   удерживают низ только в режиме follow.
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
  const unreadIDsRef = useRef<Set<string>>(new Set());
  const previousRef = useRef<ChatMessagesSnapshot | null>(null);
  const geometryRef = useRef<ChatGeometrySnapshot | null>(null);

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

  const recordGeometry = useCallback((element: ChatScrollGeometry): void => {
    geometryRef.current = { maxScrollTop: chatMaxScrollTop(element) };
  }, []);

  const clearUnread = useCallback((): void => {
    unreadIDsRef.current.clear();
    applyUnread(0);
  }, [applyUnread]);

  /**
   * Unread синхронизируется с текущей историей: transient IDs (streaming →
   * assistant → canonical) удаляются, changedIDs добавляются заново. Поэтому
   * один логический ответ остаётся одним unread, а удаление последнего unread
   * обнуляет badge даже без добавлений.
   */
  const reconcileUnread = useCallback(
    (current: readonly ChatScrollMessage[], changedIDs: readonly string[]): void => {
      const present = new Set(current.map((message) => message.id));
      for (const id of unreadIDsRef.current) {
        if (!present.has(id)) unreadIDsRef.current.delete(id);
      }
      for (const id of changedIDs) unreadIDsRef.current.add(id);
      applyUnread(unreadIDsRef.current.size);
    },
    [applyUnread],
  );

  /**
   * Пользователь мог изменить scrollTop без доставленного scroll event. Тогда
   * followingRef ещё true, но offset уже выше прежней нижней границы. Сверяем
   * текущую позицию с последней сохранённой геометрией, а не только с ref-флагом.
   */
  const movedAbovePreviousBottom = useCallback((element: ChatScrollGeometry): boolean => {
    if (isChatNearBottom(element)) return false;
    const previous = geometryRef.current;
    if (previous === null) return false;
    return element.scrollTop < previous.maxScrollTop - CHAT_NEAR_BOTTOM_THRESHOLD_PX;
  }, []);

  /**
   * Следование и unread пересчитываются после commit сообщений, поэтому высота
   * уже отражает новый контент. Перед любой записью scrollTop проверяется
   * фактический offset: stale followingRef не возвращает пользователя вниз.
   */
  useIsomorphicLayoutEffect(() => {
    const element = containerElementRef.current;
    const previous = previousRef.current;
    const sessionChanged = previous === null || previous.sessionID !== sessionID;
    const changedIDs = previous === null ? [] : chatUnreadIDs(previous.messages, messages);
    previousRef.current = { sessionID, messages };

    if (sessionChanged) {
      unreadIDsRef.current.clear();
      if (previous !== null) {
        applyFollowing(true);
        applyUnread(0);
      }
      if (element !== null) {
        scrollChatToBottom(element);
        recordGeometry(element);
      }
      return;
    }

    if (element === null) {
      if (!followingRef.current) reconcileUnread(messages, changedIDs);
      return;
    }

    if (!followingRef.current) {
      reconcileUnread(messages, changedIDs);
      // Shrink или выросший clientHeight могли сами привести к нижней границе.
      if (isChatNearBottom(element)) {
        applyFollowing(true);
        clearUnread();
        scrollChatToBottom(element);
      }
      recordGeometry(element);
      return;
    }

    if (movedAbovePreviousBottom(element)) {
      // Silent scroll без события: не пишем scrollTop, показываем возврат.
      applyFollowing(false);
      reconcileUnread(messages, changedIDs);
      recordGeometry(element);
      return;
    }

    scrollChatToBottom(element);
    clearUnread();
    recordGeometry(element);
  }, [
    applyFollowing,
    applyUnread,
    clearUnread,
    container,
    messages,
    movedAbovePreviousBottom,
    reconcileUnread,
    recordGeometry,
    sessionID,
  ]);

  /** Passive scroll listener: ручной уход от низа выключает follow. */
  useEffect(() => {
    if (container === null) return;
    const onScroll = (): void => {
      const near = isChatNearBottom(container);
      applyFollowing(near);
      if (near) clearUnread();
      recordGeometry(container);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [applyFollowing, clearUnread, container, recordGeometry]);

  /**
   * Динамические высоты: content/container ResizeObserver, window resize как
   * fallback без ResizeObserver, capture load/error для image preview, а также
   * раскрытие tool `<details>` и resize textarea/панели. При чтении выше
   * обработчики не прокручивают контейнер и не отключают native scroll anchoring.
   */
  useEffect(() => {
    if (container === null) return;
    const maintain = (): void => {
      if (!followingRef.current) {
        // Геометрия могла сама вернуть контент к низу без scroll event.
        if (isChatNearBottom(container)) {
          applyFollowing(true);
          clearUnread();
          scrollChatToBottom(container);
        }
        recordGeometry(container);
        return;
      }
      if (movedAbovePreviousBottom(container)) {
        applyFollowing(false);
        recordGeometry(container);
        return;
      }
      scrollChatToBottom(container);
      recordGeometry(container);
    };
    const Resize = globalThis.ResizeObserver;
    const observer = typeof Resize === "function" ? new Resize(maintain) : null;
    observer?.observe(container);
    if (content !== null) observer?.observe(content);

    window.addEventListener("resize", maintain);
    container.addEventListener("load", maintain, true);
    container.addEventListener("error", maintain, true);
    if (observer === null) {
      // Без ResizeObserver высоту меняют раскрытие details и resize мышью/клавиатурой.
      container.addEventListener("toggle", maintain, true);
      window.addEventListener("pointerup", maintain);
      window.addEventListener("keyup", maintain);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", maintain);
      container.removeEventListener("load", maintain, true);
      container.removeEventListener("error", maintain, true);
      container.removeEventListener("toggle", maintain, true);
      window.removeEventListener("pointerup", maintain);
      window.removeEventListener("keyup", maintain);
    };
  }, [applyFollowing, clearUnread, container, content, movedAbovePreviousBottom, recordGeometry]);

  const followNow = useCallback((): void => {
    applyFollowing(true);
    clearUnread();
    const element = containerElementRef.current;
    if (element !== null) {
      scrollChatToBottom(element);
      recordGeometry(element);
    }
  }, [applyFollowing, clearUnread, recordGeometry]);

  const jumpToLatest = useCallback(
    (options?: { readonly focus?: boolean }): void => {
      applyFollowing(true);
      clearUnread();
      const element = containerElementRef.current;
      if (element === null) return;
      scrollChatToBottom(element);
      recordGeometry(element);
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
    [applyFollowing, clearUnread, recordGeometry],
  );

  return { containerRef, contentRef, following, unread, followNow, jumpToLatest };
}
