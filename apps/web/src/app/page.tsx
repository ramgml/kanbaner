export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Каркас KAN-001
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Kanbaner</h1>
        <p className="text-lg text-muted-foreground">
          Локальная система управления задачами и заметками на plugin-ядре.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h2 className="text-lg font-medium">Приложение запущено</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Это стартовая страница каркаса. Storage Provider, доменные плагины, HTTP API и MCP
          подключаются в следующих задачах.
        </p>
      </section>

      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div className="rounded-lg border p-4">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="mt-1 font-medium">Node.js</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="text-muted-foreground">Framework</dt>
          <dd className="mt-1 font-medium">Next.js App Router</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="text-muted-foreground">Хранилище</dt>
          <dd className="mt-1 font-medium">SQLite WAL</dd>
        </div>
      </dl>
    </main>
  );
}
