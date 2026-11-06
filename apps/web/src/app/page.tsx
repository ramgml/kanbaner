import Link from "next/link";

import { Blocks, CheckCircle2, Settings, ShieldCheck } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { UiSlot } from "../components/shell/ui-slot";

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Badge variant="outline" className="w-fit">
          Plugin shell
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Обзор</h1>
        <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
          Локальный каркас Kanbaner. Доменные плагины подключаются через публичный контракт, а shell
          отвечает только за слоты, навигацию и состояние runtime.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link
          href="/plugins"
          className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Card className="h-full transition-colors hover:bg-accent/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Blocks aria-hidden="true" className="size-4" />
                Плагины
              </CardTitle>
              <CardDescription>Версии, зависимости, диагностика и safe mode.</CardDescription>
            </CardHeader>
          </Card>
        </Link>

        <Link
          href="/settings"
          className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Card className="h-full transition-colors hover:bg-accent/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings aria-hidden="true" className="size-4" />
                Настройки
              </CardTitle>
              <CardDescription>Слоты настроек и параметры локального запуска.</CardDescription>
            </CardHeader>
          </Card>
        </Link>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck aria-hidden="true" className="size-4" />
              Локально
            </CardTitle>
            <CardDescription>Без аккаунтов, облака и встроенного ИИ.</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <section aria-labelledby="plugin-main-title" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="plugin-main-title" className="text-lg font-semibold tracking-tight">
            Представления плагинов
          </h2>
          <Badge variant="secondary">
            <CheckCircle2 aria-hidden="true" />
            app.main
          </Badge>
        </div>

        <UiSlot
          slot="app.main"
          onlyWithoutRoute
          className="flex flex-col gap-3"
          empty={
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                Пока нет активных UI-вкладов без собственного маршрута. Если плагин зарегистрирует
                маршрут через публичный API, он появится в навигации и откроется по своему адресу.
              </CardContent>
            </Card>
          }
        />
      </section>
    </div>
  );
}
