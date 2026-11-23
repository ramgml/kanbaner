import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_NEAR_BOTTOM_THRESHOLD_PX,
  chatMaxScrollTop,
  chatScrollDistanceFromBottom,
  chatUnreadIDs,
  formatChatUnread,
  isChatNearBottom,
  scrollChatToBottom,
  useChatScroll,
  type ChatScrollMessage,
} from "./chat-scroll.ts";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  trigger(): void {
    if (this.disconnected) return;
    // ResizeObserver в браузере приходит вне React-события, но state hook'а
    // должен быть виден в тесте сразу после callback.
    act(() => {
      this.callback([], this as unknown as ResizeObserver);
    });
  }

  static triggerAll(): void {
    for (const instance of FakeResizeObserver.instances) instance.trigger();
  }
}

interface ControlledGeometry {
  grow(delta: number): void;
  setScrollHeight(value: number): void;
  setClientHeight(value: number): void;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Управляемая геометрия реального div: jsdom не считает layout. */
function controlledGeometry(
  element: HTMLElement,
  initial: {
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly scrollTop?: number;
  },
): ControlledGeometry {
  let scrollHeight = initial.scrollHeight;
  let clientHeight = initial.clientHeight;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  element.scrollTop = initial.scrollTop ?? Math.max(0, scrollHeight - clientHeight);
  return {
    grow(delta) {
      scrollHeight += delta;
    },
    setScrollHeight(value) {
      scrollHeight = value;
    },
    setClientHeight(value) {
      clientHeight = value;
    },
    get scrollHeight() {
      return scrollHeight;
    },
    get clientHeight() {
      return clientHeight;
    },
  };
}

function scrollElement(): HTMLElement {
  return screen.getByTestId("scroll");
}

function contentElement(): HTMLElement {
  return screen.getByTestId("content");
}

function isFollowing(): boolean {
  return screen.getByTestId("following").textContent === "true";
}

function unread(): number {
  return Number(screen.getByTestId("unread").textContent);
}

function chatMessages(count: number, prefix = "m"): ChatScrollMessage[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${prefix}-${index}`,
    text: `сообщение ${index}`,
  }));
}

function Harness({
  sessionID,
  messages,
}: {
  readonly sessionID: string | null;
  readonly messages: readonly ChatScrollMessage[];
}) {
  const { containerRef, contentRef, following, unread, jumpToLatest } = useChatScroll({
    sessionID,
    messages,
  });
  return (
    <div>
      <div data-testid="scroll" ref={containerRef} tabIndex={-1}>
        <div data-testid="content" ref={contentRef}>
          {messages.map((message) => (
            <p key={message.id}>{message.text}</p>
          ))}
          <details data-testid="tool">
            <summary>tool</summary>
            <p>payload</p>
          </details>
        </div>
      </div>
      <p data-testid="following">{String(following)}</p>
      <p data-testid="unread">{String(unread)}</p>
      {!following ? (
        <button type="button" onClick={() => jumpToLatest({ focus: true })}>
          К новому сообщению
        </button>
      ) : null}
    </div>
  );
}

function readAbove(element: HTMLElement): void {
  element.scrollTop = 0;
  fireEvent.scroll(element);
}

/** Меняет offset без synthetic scroll event: проверяет stale followingRef. */
function readAboveSilently(element: HTMLElement): void {
  element.scrollTop = 0;
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat scroll geometry", () => {
  it("считает near-bottom по документированному порогу 48 px", () => {
    const near = { scrollHeight: 1000, clientHeight: 400, scrollTop: 560 };
    const above = { scrollHeight: 1000, clientHeight: 400, scrollTop: 540 };

    expect(CHAT_NEAR_BOTTOM_THRESHOLD_PX).toBe(48);
    expect(chatScrollDistanceFromBottom(near)).toBe(40);
    expect(chatScrollDistanceFromBottom(above)).toBe(60);
    expect(isChatNearBottom(near)).toBe(true);
    expect(isChatNearBottom(above)).toBe(false);
    expect(chatMaxScrollTop(near)).toBe(600);
  });

  it("не выходит за границы и не пишет scrollTop без изменения", () => {
    const element = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
    expect(scrollChatToBottom(element)).toBe(false);
    element.scrollTop = 0;
    expect(scrollChatToBottom(element)).toBe(true);
    expect(element.scrollTop).toBe(600);
    expect(chatMaxScrollTop({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 })).toBe(0);
  });

  it("считает unread по identity и изменению текста, а не по net length", () => {
    expect(chatUnreadIDs([{ id: "a", text: "123" }], [{ id: "a", text: "123" }])).toEqual([]);
    expect(
      chatUnreadIDs(
        [
          { id: "a", text: "123" },
          { id: "b", text: "old" },
        ],
        [
          { id: "a", text: "1234" },
          { id: "c", text: "new" },
        ],
      ),
    ).toEqual(["a", "c"]);
    // Чистое удаление не является новым сообщением.
    expect(
      chatUnreadIDs(
        [
          { id: "a", text: "123" },
          { id: "b", text: "x" },
        ],
        [{ id: "a", text: "123" }],
      ),
    ).toEqual([]);
    expect(formatChatUnread(4)).toBe("4");
    expect(formatChatUnread(100)).toBe("99+");
  });
});

describe("useChatScroll", () => {
  it("удерживает низ при росте контента только в follow", () => {
    const initial = chatMessages(2);
    const { rerender } = render(<Harness sessionID="ses-1" messages={initial} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    fireEvent.scroll(element);
    expect(isFollowing()).toBe(true);

    geometry.grow(300);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(3)} />);

    expect(isFollowing()).toBe(true);
    expect(element.scrollTop).toBe(1300 - 400);
  });

  it("не двигает scrollTop при чтении выше и считает новые сообщения", () => {
    const { rerender } = render(<Harness sessionID="ses-1" messages={chatMessages(5)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    readAbove(element);
    expect(isFollowing()).toBe(false);
    expect(screen.getByRole("button", { name: "К новому сообщению" })).toBeVisible();
    expect(unread()).toBe(0);

    geometry.grow(200);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(6)} />);
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(1);

    // Streaming delta того же сообщения не увеличивает счётчик сверх одного.
    rerender(
      <Harness
        sessionID="ses-1"
        messages={[...chatMessages(5), { id: "m-5", text: "другой текст" }]}
      />,
    );
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(1);

    rerender(<Harness sessionID="ses-1" messages={chatMessages(7)} />);
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(2);
    expect(screen.getByTestId("unread")).toBeInTheDocument();
  });

  it("возвращает к новому низу кнопкой, скрывает её и снова следует", () => {
    const { rerender } = render(<Harness sessionID="ses-1" messages={chatMessages(5)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    readAbove(element);
    geometry.grow(100);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(6)} />);

    const button = screen.getByRole("button", { name: /К новому сообщению/u });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);

    expect(element.scrollTop).toBe(1100 - 400);
    expect(isFollowing()).toBe(true);
    expect(screen.queryByRole("button", { name: /К новому сообщению/u })).toBeNull();
    expect(unread()).toBe(0);

    geometry.grow(100);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(7)} />);
    expect(element.scrollTop).toBe(1200 - 400);
  });

  it("canonical refresh той же сессии не сбрасывает и не двигает чтение выше", () => {
    const messages = chatMessages(4);
    const { rerender } = render(<Harness sessionID="ses-1" messages={messages} />);
    const element = scrollElement();
    controlledGeometry(element, { scrollHeight: 900, clientHeight: 300 });
    readAbove(element);

    // Тот же контент в новом массиве: canonical no-op.
    rerender(<Harness sessionID="ses-1" messages={[...messages]} />);
    expect(isFollowing()).toBe(false);
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(0);

    // Canonical done с новым содержимым: unread растёт, scrollTop нет.
    rerender(<Harness sessionID="ses-1" messages={chatMessages(5)} />);
    expect(isFollowing()).toBe(false);
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(1);
    expect(screen.getByRole("button", { name: /К новому сообщению/u })).toBeVisible();
  });

  it("не возвращает вниз при silent scroll без scroll event", () => {
    const { rerender } = render(<Harness sessionID="ses-1" messages={chatMessages(3)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    // Фиксируем нижнюю границу до ухода: это baseline для сверки offset.
    fireEvent.scroll(element);
    expect(isFollowing()).toBe(true);

    readAboveSilently(element);
    geometry.grow(300);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(4)} />);
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);
    expect(unread()).toBe(1);

    // Resize callback не маскирует уход: запись scrollTop запрещена.
    FakeResizeObserver.triggerAll();
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);

    // Последующий scroll event только подтверждает чтение выше.
    fireEvent.scroll(element);
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);
    expect(unread()).toBe(1);
  });

  it("silent scroll не перезаписывается resize/load fallback без ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<Harness sessionID="ses-1" messages={chatMessages(2)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 700, clientHeight: 250 });
    fireEvent.scroll(element);

    readAboveSilently(element);
    geometry.grow(100);
    fireEvent(window, new Event("resize"));
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);

    fireEvent.load(contentElement());
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);
  });

  it("чистое сокращение history не создаёт unread и не залипает при росте clientHeight", () => {
    const messages = chatMessages(6);
    const { rerender } = render(<Harness sessionID="ses-1" messages={messages} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1200, clientHeight: 400 });
    readAbove(element);
    expect(unread()).toBe(0);
    expect(isFollowing()).toBe(false);

    // Pure canonical shrink: те же identity/текст, меньше сообщений.
    geometry.setScrollHeight(700);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(3)} />);
    expect(isFollowing()).toBe(false);
    expect(element.scrollTop).toBe(0);
    expect(unread()).toBe(0);

    // clientHeight вырос без scroll event: контент сам дошёл до низа.
    geometry.setClientHeight(1000);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(3)} />);
    expect(isFollowing()).toBe(true);
    expect(unread()).toBe(0);
    expect(element.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: /К новому сообщению/u })).toBeNull();
  });

  it("ResizeObserver пересчитывает near-bottom при following=false", () => {
    const messages = chatMessages(5);
    render(<Harness sessionID="ses-1" messages={messages} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    readAbove(element);
    expect(isFollowing()).toBe(false);

    geometry.setClientHeight(1000);
    FakeResizeObserver.triggerAll();
    expect(isFollowing()).toBe(true);
    expect(unread()).toBe(0);
    expect(element.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: /К новому сообщению/u })).toBeNull();
  });

  it("смена session сбрасывает unread и открывает конец новой истории", () => {
    const { rerender } = render(<Harness sessionID="ses-1" messages={chatMessages(5)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 1000, clientHeight: 400 });
    readAbove(element);
    geometry.grow(100);
    rerender(<Harness sessionID="ses-1" messages={chatMessages(6)} />);
    expect(unread()).toBe(1);

    geometry.grow(200);
    rerender(<Harness sessionID="ses-2" messages={chatMessages(3, "new")} />);
    expect(isFollowing()).toBe(true);
    expect(unread()).toBe(0);
    expect(element.scrollTop).toBe(1300 - 400);
    expect(screen.queryByRole("button", { name: /К новому сообщению/u })).toBeNull();
  });

  it("ResizeObserver удерживает низ в follow и не scroll'ит при чтении выше", () => {
    const { rerender } = render(<Harness sessionID="ses-1" messages={chatMessages(3)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 800, clientHeight: 300 });
    const observer = FakeResizeObserver.instances[0];
    expect(observer?.targets.has(element)).toBe(true);
    expect(observer?.targets.has(contentElement())).toBe(true);

    geometry.grow(250);
    FakeResizeObserver.triggerAll();
    expect(element.scrollTop).toBe(1050 - 300);

    readAbove(element);
    geometry.grow(250);
    FakeResizeObserver.triggerAll();
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);

    // Panel/textarea resize, меняющий высоту контейнера, тоже не двигает чтение.
    geometry.setClientHeight(200);
    FakeResizeObserver.triggerAll();
    expect(element.scrollTop).toBe(0);

    rerender(<Harness sessionID="ses-1" messages={chatMessages(4)} />);
    expect(element.scrollTop).toBe(0);
  });

  it("window resize и load/error работают без ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<Harness sessionID="ses-1" messages={chatMessages(2)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 700, clientHeight: 250 });

    geometry.grow(100);
    fireEvent(window, new Event("resize"));
    expect(element.scrollTop).toBe(800 - 250);

    geometry.grow(100);
    fireEvent.load(contentElement());
    expect(element.scrollTop).toBe(900 - 250);

    geometry.grow(100);
    fireEvent.error(contentElement());
    expect(element.scrollTop).toBe(1000 - 250);

    readAbove(element);
    geometry.grow(100);
    fireEvent(window, new Event("resize"));
    fireEvent.load(contentElement());
    fireEvent.error(contentElement());
    expect(element.scrollTop).toBe(0);
  });

  it("без ResizeObserver реагирует на toggle details и pointerup/keyup", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<Harness sessionID="ses-1" messages={chatMessages(2)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 700, clientHeight: 250 });
    const details = screen.getByTestId("tool");
    expect(details.tagName).toBe("DETAILS");

    // Реальный toggle от раскрытия tool `<details>` приходит из content, а
    // listener висит в capture-фазе на контейнере.
    geometry.grow(100);
    fireEvent(details, new Event("toggle"));
    expect(element.scrollTop).toBe(800 - 250);

    // Resize перетаскиванием панели и клавиатурой без ResizeObserver.
    geometry.grow(100);
    fireEvent.pointerUp(window);
    expect(element.scrollTop).toBe(900 - 250);

    geometry.grow(100);
    fireEvent.keyUp(window);
    expect(element.scrollTop).toBe(1000 - 250);

    // Чтение выше: fallback не возвращает вниз.
    readAbove(element);
    geometry.grow(100);
    fireEvent(details, new Event("toggle"));
    fireEvent.pointerUp(window);
    fireEvent.keyUp(window);
    expect(element.scrollTop).toBe(0);
    expect(isFollowing()).toBe(false);
  });

  it("без ResizeObserver очищает toggle/pointerup/keyup listeners", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removeSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness sessionID="ses-1" messages={chatMessages(2)} />);
    const element = scrollElement();
    const geometry = controlledGeometry(element, { scrollHeight: 700, clientHeight: 250 });

    const toggleAdd = addSpy.mock.calls.find(
      ([type, , options]) =>
        type === "toggle" &&
        (options === true ||
          (typeof options === "object" &&
            options !== null &&
            (options as AddEventListenerOptions).capture === true)),
    );
    expect(toggleAdd).toBeDefined();
    expect(windowAddSpy.mock.calls.some(([type]) => type === "pointerup")).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "keyup")).toBe(true);

    unmount();
    expect(removeSpy.mock.calls.some(([type]) => type === "toggle")).toBe(true);
    expect(windowRemoveSpy.mock.calls.some(([type]) => type === "pointerup")).toBe(true);
    expect(windowRemoveSpy.mock.calls.some(([type]) => type === "keyup")).toBe(true);

    // После unmount поздние события не трогают scrollTop.
    geometry.grow(500);
    fireEvent(screen.queryByTestId("tool") ?? element, new Event("toggle"));
    fireEvent.pointerUp(window);
    fireEvent.keyUp(window);
    expect(element.scrollTop).toBe(700 - 250);
  });

  it("passive scroll listener и observers очищаются, включая StrictMode", () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removeSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <StrictMode>
        <Harness sessionID="ses-1" messages={chatMessages(2)} />
      </StrictMode>,
    );

    const scrollCalls = addSpy.mock.calls.filter(([type]) => type === "scroll");
    expect(
      scrollCalls.some(
        ([, , options]) =>
          typeof options === "object" &&
          options !== null &&
          (options as AddEventListenerOptions).passive === true,
      ),
    ).toBe(true);

    const observers = FakeResizeObserver.instances;
    // StrictMode не должен оставлять дубли: контейнер появляется после commit,
    // поэтому observer создаётся ровно один раз, а не два.
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnected).toBe(false);

    unmount();
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    expect(
      removeSpy.mock.calls.some(
        ([type, listener]) => type === "scroll" && typeof listener === "function",
      ),
    ).toBe(true);
    expect(removeSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
    expect(windowRemoveSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(removeSpy.mock.calls.some(([type]) => type === "load")).toBe(true);
    expect(removeSpy.mock.calls.some(([type]) => type === "error")).toBe(true);
  });

  it("кнопка нативная, клавиатура не отменяется, фокус уходит на контейнер", () => {
    render(<Harness sessionID="ses-1" messages={chatMessages(4)} />);
    const element = scrollElement();
    controlledGeometry(element, { scrollHeight: 900, clientHeight: 300 });
    readAbove(element);

    const button = screen.getByRole("button", { name: "К новому сообщению" });
    // Native button сам обрабатывает Enter/Space; наш keydown не preventDefault'ит.
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);

    const focusSpy = vi.spyOn(element, "focus");
    fireEvent.click(button);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(element);
  });
});
