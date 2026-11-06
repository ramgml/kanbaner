import type { Relation, ResourceLink, ResourceRef } from "@kanbaner/plugin-sdk";

/** Результат атомарной вставки связи. */
export interface LinkStoreAddResult {
  /** `true`, если связь создана; `false` для уже существующей пары. */
  readonly inserted: boolean;
  /** Созданная или ранее сохранённая связь. */
  readonly link: ResourceLink;
}

/**
 * Backend-neutral порт хранения универсальных связей.
 *
 * Порт не знает о SQL, таблицах и транзакциях конкретной СУБД. Реализация
 * хранения входит в задачу Storage Provider; in-memory реализация в этом
 * каталоге предназначена только для тестов и локальной разработки и не
 * обеспечивает персистентность.
 *
 * Контракт реализации:
 * - уникальность определяется тройкой `sourceRef` + `targetRef` + `relation`;
 * - `add` атомарен и при дубликате возвращает существующую связь;
 * - `remove` идемпотентен и возвращает `true`, только если связь была удалена;
 * - `listByRef` возвращает связи, где ref является source или target;
 * - `deleteByRef` удаляет связи с обеих сторон и возвращает их количество.
 */
export interface LinkStore {
  add(link: ResourceLink): Promise<LinkStoreAddResult>;
  remove(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<boolean>;
  listByRef(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]>;
  deleteByRef(ref: ResourceRef): Promise<number>;
}
