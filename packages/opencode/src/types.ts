import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

export type { OpenCodeEvent } from "@opencode/client";

export interface OpenCodeProviderView {
  readonly id: string;
  readonly name: string;
  readonly activation: string;
}

export interface OpenCodeModelView {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly type: string;
  readonly variants: readonly string[];
}

export interface OpenCodeAgentView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface OpenCodeModelRefView {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** Источник tool: стандартный инструмент OpenCode или ручной Kanbaner MCP allowlist. */
export type OpenCodeToolSource = "builtin" | "mcp";

export interface OpenCodeToolView {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write";
  /**
   * Поле необязательно для совместимости: built-in tools не имеют доменного
   * operationId, а старые catalog payloads могли не содержать source.
   */
  readonly source?: OpenCodeToolSource;
  readonly operationId?: string;
  readonly requiresExpectedVersion?: boolean;
}

export interface OpenCodeCatalog {
  readonly providers: readonly OpenCodeProviderView[];
  readonly models: readonly OpenCodeModelView[];
  readonly agents: readonly OpenCodeAgentView[];
  readonly tools: readonly OpenCodeToolView[];
  readonly defaultModel: OpenCodeModelRefView | null;
}

export interface OpenCodeStatus {
  readonly available: true;
  readonly version: string;
}

export interface OpenCodeAttachmentView {
  readonly name: string;
  readonly mime: string;
  readonly size?: number;
}

export interface OpenCodeAttachmentPayload {
  readonly name: string;
  readonly mime: string;
  readonly base64: string;
}

export interface OpenCodePromptAttachment {
  readonly name: string;
  readonly dataUri: string;
}

/** Бинарный preview вложения из canonical history; никогда не попадает в JSON сессии. */
export interface OpenCodeAttachmentPreview {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export type OpenCodeChatMessage =
  | {
      readonly id: string;
      readonly role: "user";
      readonly text: string;
      readonly attachments?: readonly OpenCodeAttachmentView[];
    }
  | {
      readonly id: string;
      readonly role: "assistant" | "system";
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly role: "tool";
      readonly name: string;
      /**
       * `cancelled` — UI-only terminal для прерванного turn или canonical tool
       * с `error.type=aborted`; upstream streaming такого статуса не отдаёт.
       */
      readonly status: "running" | "completed" | "error" | "cancelled";
      readonly text: string;
      /**
       * Время начала/окончания tool call в epoch milliseconds. История берёт
       * canonical `part.time`, stream — approximate top-level `event.created`
       * до canonical reload. Невалидные значения не попадают в payload.
       */
      readonly startedAt?: number;
      readonly endedAt?: number;
      /** Сериализованный input инструмента; `metadata` и `native` не передаются. */
      readonly input?: string;
      /** Ограниченный текст результата без upstream error.message. */
      readonly output?: string;
    };

export interface OpenCodeSessionView {
  readonly id: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly model: OpenCodeModelRefView | null;
  readonly messages: readonly OpenCodeChatMessage[];
}

export interface OpenCodeSessionCreate {
  readonly agent?: string;
  readonly model?: OpenCodeModelRefView;
}

/**
 * Whitelist-запись списка сессий. Metadata, location, projectID, стоимость,
 * токены, разрешения, модель, агент, outcome и archived наружу не передаются.
 */
export interface OpenCodeSessionSummary {
  readonly id: string;
  readonly title: string | null;
  /** Canonical `time.updated` в epoch milliseconds. */
  readonly updatedAt: number;
}

export interface OpenCodeSessionRename {
  readonly id: string;
  readonly title: string;
}

/** Canonical outcome точного prompt-turn, вычисленный gateway по raw history. */
export type OpenCodeTurnOutcome = "done" | "error" | "cancelled" | "pending" | "missing";

export interface OpenCodeTurnStatus {
  readonly session: OpenCodeSessionView;
  readonly outcome: OpenCodeTurnOutcome;
}

export interface OpenCodeGateway {
  status(): Promise<OpenCodeStatus>;
  catalog(): Promise<OpenCodeCatalog>;
  createSession(input?: OpenCodeSessionCreate): Promise<OpenCodeSessionView>;
  listSessions(): Promise<readonly OpenCodeSessionSummary[]>;
  renameSession(sessionID: string, title: string): Promise<OpenCodeSessionRename>;
  getSession(sessionID: string): Promise<OpenCodeSessionView>;
  getTurnStatus(sessionID: string, turnID: string): Promise<OpenCodeTurnStatus>;
  getAttachmentPreview(
    sessionID: string,
    messageID: string,
    attachmentIndex: number,
  ): Promise<OpenCodeAttachmentPreview>;
  switchModel(sessionID: string, model: OpenCodeModelRefView): Promise<void>;
  prompt(
    sessionID: string,
    text: string,
    signal: AbortSignal,
    attachments?: readonly OpenCodePromptAttachment[],
    turnID?: string,
  ): AsyncIterable<OpenCodeEvent>;
}

export interface OpenCodeStreamEvent {
  readonly kind:
    | "connected"
    | "admitted"
    | "delta"
    | "text"
    | "tool"
    | "finalizing"
    | "done"
    | "cancelled"
    | "error";
  readonly id?: string;
  readonly text?: string;
  readonly name?: string;
  readonly status?: "running" | "completed" | "error" | "cancelled";
  /**
   * Approximate время tool call из top-level `event.created`; canonical
   * timestamps приходят только со следующим history reload.
   */
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly input?: string;
  readonly output?: string;
  /**
   * Машинный признак ошибки, когда canonical outcome не удалось подтвердить.
   * UI не повторяет prompt автоматически и предлагает ручную проверку статуса.
   */
  readonly reason?: "unconfirmed";
  /**
   * Явное подтверждение сервера, что prompt не был принят (ошибка до
   * `client.session.prompt` admission). Только такой ответ разрешает retry.
   */
  readonly nonAdmission?: true;
  /** Retryable только вместе с `nonAdmission` и только для 408/429/5xx. */
  readonly retryable?: boolean;
}

/** Client-generated stable turn ID; совпадает с inbox ID, если Service его не заменил. */
const TURN_ID_PATTERN = /^msg_[A-Za-z0-9_-]{8,64}$/u;

export function isOpenCodeTurnID(value: unknown): value is string {
  return typeof value === "string" && TURN_ID_PATTERN.test(value);
}

/**
 * Bounded SessionMessageID, который Service вернул как admitted ID. SDK
 * описывает его как string без гарантированного префикса, поэтому для
 * status query допускается безопасный charset без требования `msg_`.
 * Значение не логируется и не раскрывается клиенту сверх самого ID.
 */
const ADMITTED_TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isOpenCodeAdmittedTurnID(value: unknown): value is string {
  return typeof value === "string" && ADMITTED_TURN_ID_PATTERN.test(value);
}

export type OpenCodeGatewayErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "DEPENDENCY_UNAVAILABLE";

/** Публичная ошибка адаптера без upstream response, headers и provider settings. */
export class OpenCodeGatewayError extends Error {
  constructor(
    readonly code: OpenCodeGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeGatewayError";
  }
}

export type OpenCodeClientFactory = () => Promise<OpenCodeClient>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function truncated(value: string, limit = 6000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
