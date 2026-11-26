# @kanbaner/markdown-ui

Нейтральный клиентский пакет безопасного CommonMark/GFM-рендера для UI-плагинов.

`MarkdownContent` использует `react-markdown` и `remark-gfm`, отключает raw HTML,
оставляет стандартную sanitization URL и не применяет `dangerouslySetInnerHTML`.
Обычные ссылки открываются в новой вкладке с `rel="noreferrer nofollow"`;
отклонённые ссылки остаются текстом. Стили используют токены light/dark темы.

`MarkdownContent` принимает необязательный additive `codeBlockAction`
(`ComponentType<{ code: string }>`). Без prop разметка и поведение не меняются.
С prop action получает точный plain text только fenced/indented code block без
одного renderer-added trailing newline; inline code и пустые блоки action не
получают. Кнопка монтируется overlay-контейнером рядом с `pre`, не меняет
размеры и горизонтальный scroll блока. Извлечение текста идёт из HAST только по
text-узлам, без `dangerouslySetInnerHTML`, `innerHTML` и второго renderer;
`skipHtml` и стандартная sanitization URL сохраняются.

Пакет не содержит доменных типов, Storage, kernel или компонентов других
плагинов. Используется `kanbaner.projects` и `kanbaner.notes`.
