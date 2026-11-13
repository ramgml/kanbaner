# @kanbaner/markdown-ui

Нейтральный клиентский пакет безопасного CommonMark/GFM-рендера для UI-плагинов.

`MarkdownContent` использует `react-markdown` и `remark-gfm`, отключает raw HTML,
оставляет стандартную sanitization URL и не применяет `dangerouslySetInnerHTML`.
Обычные ссылки открываются в новой вкладке с `rel="noreferrer nofollow"`;
отклонённые ссылки остаются текстом. Стили используют токены light/dark темы.

Пакет не содержит доменных типов, Storage, kernel или компонентов других
плагинов. Используется `kanbaner.projects` и `kanbaner.notes`.
