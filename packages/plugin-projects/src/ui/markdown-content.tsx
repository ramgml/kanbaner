"use client";

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

const headingClass = "mt-3 mb-2 font-semibold break-words first:mt-0";
const listItemClass = "my-0.5";

/** Единое оформление CommonMark/GFM без dangerouslySetInnerHTML и raw HTML. */
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className={`${headingClass} text-[1.2em]`}>{children}</h1>,
  h2: ({ children }) => <h2 className={`${headingClass} text-[1.15em]`}>{children}</h2>,
  h3: ({ children }) => <h3 className={`${headingClass} text-[1.08em]`}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingClass}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingClass}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingClass}>{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => {
    if (!href) {
      return <span>{children}</span>;
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer nofollow"
        className="break-words text-blue-700 underline underline-offset-2 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-300 dark:hover:text-blue-200"
      >
        {children}
      </a>
    );
  },
  ul: ({ children, className }) => {
    const taskList = className?.split(" ").includes("contains-task-list") === true;

    return (
      <ul className={`${taskList ? "list-none pl-1" : "list-disc pl-5"} my-2 ${className ?? ""}`}>
        {children}
      </ul>
    );
  },
  ol: ({ children, className }) => (
    <ol className={`my-2 list-decimal pl-5 ${className ?? ""}`}>{children}</ol>
  ),
  li: ({ children, className }) => (
    <li className={`${listItemClass} ${className ?? ""}`}>{children}</li>
  ),
  input: ({ checked, disabled, type }) => (
    <input
      type={type}
      checked={checked}
      disabled={disabled}
      readOnly
      className="mr-1.5 size-3.5 translate-y-0.5 accent-[var(--primary)]"
    />
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code className={`rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] ${className ?? ""}`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-muted p-2 text-xs leading-relaxed whitespace-pre">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <table className="my-2 w-full border-collapse text-left text-xs">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-1.5 py-1 align-top font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-1.5 py-1 align-top">{children}</td>,
  hr: () => <hr className="my-3 border-border" />,
  img: ({ alt, src }) => (
    // Remote-изображение не получает referrer локального приложения.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="my-2 h-auto max-w-full rounded-md"
    />
  ),
};

export interface MarkdownContentProps {
  readonly source: string;
  readonly className?: string;
}

export function MarkdownContent({ source, className = "text-sm" }: MarkdownContentProps) {
  return (
    <div data-markdown-content className={`min-w-0 leading-relaxed break-words ${className}`}>
      <Markdown remarkPlugins={REMARK_PLUGINS} skipHtml components={MARKDOWN_COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
}
