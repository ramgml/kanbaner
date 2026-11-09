import Link from "next/link";

import { Blocks, Info, Palette, Settings } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { UiSlot } from "../../components/shell/ui-slot";
import { SETTINGS_PLUGINS_HREF } from "../../components/shell/nav-items";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Settings aria-hidden="true" className="size-5 text-muted-foreground" />
          <h1 className="text-3xl font-semibold tracking-tight">Настройки</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Раздел настроек shell-а. Плагины добавляют сюда свои панели через слот
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">app.settings</code>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Blocks aria-hidden="true" className="size-4" />
            Плагины
          </CardTitle>
          <CardDescription>
            Включение, отключение и диагностика доступны в plugin manager.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href={SETTINGS_PLUGINS_HREF}>Открыть plugin manager</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette aria-hidden="true" className="size-4" />
            Оформление
          </CardTitle>
          <CardDescription>
            Тема следует системным токенам Tailwind 4 и shadcn/ui. Отдельный design system в каркасе
            не создаётся.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info aria-hidden="true" className="size-4" />
            Локальный запуск
          </CardTitle>
          <CardDescription>
            Сервер слушает localhost. Аккаунтов, ролей, облачных AI-провайдеров и телеметрии нет.
          </CardDescription>
        </CardHeader>
      </Card>

      <section aria-labelledby="plugin-settings-title" className="flex flex-col gap-3">
        <h2 id="plugin-settings-title" className="text-lg font-semibold tracking-tight">
          Настройки плагинов
        </h2>
        <UiSlot slot="app.settings" className="flex flex-col gap-3" />
      </section>
    </div>
  );
}
