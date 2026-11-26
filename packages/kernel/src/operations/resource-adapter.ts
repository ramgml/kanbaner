import type {
  OperationResult,
  Relation,
  ResourceDescriptor,
  ResourceLink,
  ResourceRef,
  ResourceService,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "./errors.ts";

/**
 * Явный маппер ошибок сервиса ресурсов.
 *
 * Возвращает `OperationFailure` только для распознанной ошибки. `undefined`
 * означает, что ошибка не принадлежит сервису ресурсов и должна продолжить
 * путь к общей безопасной обработке шины.
 */
export type ResourceErrorMapper = (error: unknown) => OperationFailure | undefined;

/**
 * Оборачивает `ResourceService` в безопасный маппер ошибок.
 *
 * Шина операций не импортирует конкретную реализацию ресурсов и не доверяет
 * структурным `code`/`message` произвольных исключений. Composition root
 * передаёт маппер, который распознаёт свой класс ошибки через `instanceof` и
 * создаёт `OperationFailure`; только такой результат превращается в
 * стабильный код `OperationResult`.
 */
export function adaptResourceServiceErrors(
  service: ResourceService,
  mapError: ResourceErrorMapper,
): ResourceService {
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      const mapped = mapError(error);

      if (mapped !== undefined) {
        throw mapped;
      }

      throw error;
    }
  };

  return Object.freeze({
    link(
      sourceRef: ResourceRef,
      targetRef: ResourceRef,
      relation: Relation,
    ): Promise<ResourceLink> {
      return run(() => service.link(sourceRef, targetRef, relation));
    },
    unlink(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<void> {
      return run(() => service.unlink(sourceRef, targetRef, relation));
    },
    list(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]> {
      return run(() => service.list(ref, relation));
    },
    resolve(ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>> {
      return run(() => service.resolve(ref));
    },
    canOpen(ref: ResourceRef): Promise<boolean> {
      return run(() => service.canOpen(ref));
    },
    open(ref: ResourceRef): Promise<void> {
      return run(() => service.open(ref));
    },
  });
}
