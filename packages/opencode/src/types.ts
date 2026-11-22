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
      readonly status: "running" | "completed" | "error";
      readonly text: string;
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

export interface OpenCodeGateway {
  status(): Promise<OpenCodeStatus>;
  catalog(): Promise<OpenCodeCatalog>;
  createSession(input?: OpenCodeSessionCreate): Promise<OpenCodeSessionView>;
  getSession(sessionID: string): Promise<OpenCodeSessionView>;
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
  ): AsyncIterable<OpenCodeEvent>;
}

export interface OpenCodeStreamEvent {
  readonly kind: "connected" | "delta" | "text" | "tool" | "done" | "cancelled" | "error";
  readonly id?: string;
  readonly text?: string;
  readonly name?: string;
  readonly status?: "running" | "completed" | "error";
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
