/* eslint-disable @next/next/no-img-element -- редактор показывает произвольные
   image URL из Markdown и attachment flow; next/image здесь неприменим. */
import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";

import { sanitizeImageSource, validateLinkHref } from "./editor-markdown.ts";

function safeImageUrl(url: string): string {
  return sanitizeImageSource(url) ?? "";
}

function safeHref(href: string): string | null {
  const validation = validateLinkHref(href);
  return validation.ok ? validation.href : null;
}

/**
 * Inline image для Markdown-конструкций, которые BlockNote не умеет хранить
 * отдельным image-блоком: image внутри emphasis/strong, списка, цитаты,
 * заголовка или ячейки таблицы. Рендерится тем же `<img>`, а в Markdown через
 * `toExternalHTML` возвращается в исходную inline-форму.
 */
const inlineImage = createReactInlineContentSpec(
  {
    type: "inlineImage",
    propSchema: {
      url: { default: "" },
      name: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <img
        className="kne-inline-image"
        src={safeImageUrl(inlineContent.props.url)}
        alt={inlineContent.props.name}
        draggable={false}
      />
    ),
    parse: (element) => {
      if (element.tagName !== "IMG") return undefined;
      const url = safeImageUrl(element.getAttribute("src") ?? "");
      if (url.length === 0) return undefined;
      return { url, name: element.getAttribute("alt") ?? "" };
    },
    toExternalHTML: ({ inlineContent }) => (
      <img src={inlineContent.props.url} alt={inlineContent.props.name} />
    ),
  },
);

/**
 * Image, обёрнутый в ссылку. BlockNote link-контент не допускает вложенный
 * atom, поэтому пара `<a><img></a>` хранится одним inline-узлом: ссылка и
 * картинка не теряются при round-trip.
 */
const linkedImage = createReactInlineContentSpec(
  {
    type: "linkedImage",
    propSchema: {
      url: { default: "" },
      name: { default: "" },
      href: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const href = safeHref(inlineContent.props.href);
      const image = (
        <img
          className="kne-inline-image"
          src={safeImageUrl(inlineContent.props.url)}
          alt={inlineContent.props.name}
          draggable={false}
        />
      );

      return href === null ? (
        image
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {image}
        </a>
      );
    },
    toExternalHTML: ({ inlineContent }) => {
      const href = safeHref(inlineContent.props.href);
      const image = <img src={inlineContent.props.url} alt={inlineContent.props.name} />;

      return href === null ? (
        image
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {image}
        </a>
      );
    },
  },
);

/** Схема редактора заметки: стандартные блоки плюс inline-представления image. */
export const noteEditorSchema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineImage,
    linkedImage,
  },
});
