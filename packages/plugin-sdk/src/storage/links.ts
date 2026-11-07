import type { Relation } from "../plugin-id.ts";
import type { ResourceLink, ResourceRef } from "../resources.ts";

/** Результат атомарной вставки связи. */
export interface LinkStoreAddResult {
  /** `true`, если связь создана; `false` для уже существующей тройки. */
  readonly inserted: boolean;
  /** Созданная или ранее сохранённая связь. */
  readonly link: ResourceLink;
}

/**
 * Backend-neutral хранилище универсальных связей.
 *
 * Контракт совместим с портом `LinkStore` ядра из KAN-005 и не знает SQL,
 * таблиц или драйвера БД. Уникальность определяется тройкой
 * `sourceRef` + `targetRef` + `relation`.
 */
export interface LinkStore {
  /** Атомарная вставка; дубликат возвращает существующую связь. */
  add(link: ResourceLink): Promise<LinkStoreAddResult>;
  /** Идемпотентное удаление; `true`, только если связь существовала. */
  remove(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<boolean>;
  /** Связи, где ref является source или target; необязательный фильтр relation. */
  listByRef(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]>;
  /** Удаляет связи с обеих сторон и возвращает их количество. */
  deleteByRef(ref: ResourceRef): Promise<number>;
}
