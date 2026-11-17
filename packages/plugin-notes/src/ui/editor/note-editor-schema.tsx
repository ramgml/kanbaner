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

interface ExternalImageProps {
  readonly url: string;
  readonly name: string;
  readonly href?: string;
}

/**
 * Внешний HTML для inline image без React.
 *
 * BlockNote сериализует Markdown через external HTML exporter, а React-версия
 * `toExternalHTML` рендерит элемент через `elementRenderer` с `flushSync`.
 * Вызов из lifecycle (initial load, внешнее значение, `setEditable`) даёт
 * React console error и обрывает renderHTML, поэтому для Markdown-сериализации
 * используем обычный DOM-контракт `toExternalHTML`. Node view редактора
 * по-прежнему рисует React-компонент.
 */
function externalImageDom(type: string, props: ExternalImageProps): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.setAttribute("data-inline-content-type", type);
  if (props.url.length > 0) wrapper.setAttribute("data-url", props.url);
  if (props.name.length > 0) wrapper.setAttribute("data-name", props.name);

  const image = document.createElement("img");
  image.setAttribute("src", props.url);
  image.setAttribute("alt", props.name);

  if (props.href === undefined) {
    wrapper.append(image);
  } else {
    wrapper.setAttribute("data-href", props.href);
    const link = document.createElement("a");
    link.setAttribute("href", props.href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
    link.append(image);
    wrapper.append(link);
  }

  return wrapper;
}

/** Достаёт props inline content из непрозрачного аргумента exporter-а. */
function externalImageProps(inlineContent: unknown): ExternalImageProps {
  const props = (
    inlineContent as {
      readonly props?: {
        readonly url?: string;
        readonly name?: string;
        readonly href?: string;
      };
    }
  ).props;

  return {
    url: props?.url ?? "",
    name: props?.name ?? "",
    ...(props?.href === undefined ? {} : { href: props.href }),
  };
}

/**
 * Inline image для Markdown-конструкций, которые BlockNote не умеет хранить
 * отдельным image-блоком: image внутри emphasis/strong, списка, цитаты,
 * заголовка или ячейки таблицы. Рендерится тем же `<img>`, а в Markdown через
 * `toExternalHTML` возвращается в исходную inline-форму.
 */
const inlineImageBase = createReactInlineContentSpec(
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

// Markdown идёт через DOM, node view — через React.
const inlineImage = {
  ...inlineImageBase,
  implementation: {
    ...inlineImageBase.implementation,
    toExternalHTML: (inlineContent: unknown) => ({
      dom: externalImageDom("inlineImage", externalImageProps(inlineContent)),
    }),
  },
} satisfies typeof inlineImageBase;

/**
 * Image, обёрнутый в ссылку. BlockNote link-контент не допускает вложенный
 * atom, поэтому пара `<a><img></a>` хранится одним inline-узлом: ссылка и
 * картинка не теряются при round-trip.
 */
const linkedImageBase = createReactInlineContentSpec(
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

const linkedImage = {
  ...linkedImageBase,
  implementation: {
    ...linkedImageBase.implementation,
    toExternalHTML: (inlineContent: unknown) => {
      const props = externalImageProps(inlineContent);
      const href = safeHref(props.href ?? "");
      return {
        dom: externalImageDom(
          "linkedImage",
          href === null ? { url: props.url, name: props.name } : { ...props, href },
        ),
      };
    },
  },
} satisfies typeof linkedImageBase;

/** Схема редактора заметки: стандартные блоки плюс inline-представления image. */
export const noteEditorSchema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineImage,
    linkedImage,
  },
});
