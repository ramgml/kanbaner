"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { RotateCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import type { RegisteredUiContribution } from "../../ui/registry";

interface ContributionBoundaryProps {
  readonly contribution: RegisteredUiContribution;
  readonly children: ReactNode;
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
}

interface ContributionBoundaryState {
  readonly failed: boolean;
}

/**
 * Локальная граница ошибок одного UI-вклада.
 *
 * Падение рендера не затрагивает shell и другие вклады. Текст исключения
 * не выводится: он может содержать данные плагина или внутренние детали.
 */
export class ContributionBoundary extends Component<
  ContributionBoundaryProps,
  ContributionBoundaryState
> {
  override state: ContributionBoundaryState = { failed: false };

  static getDerivedStateFromError(): ContributionBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    const title = this.props.contribution.contribution.title ?? "Без названия";

    return (
      <Alert
        variant="destructive"
        role="alert"
        data-testid="contribution-error"
        data-contribution-id={this.props.contribution.contribution.id}
        className="my-2"
      >
        <AlertTitle>Не удалось показать вклад</AlertTitle>
        <AlertDescription>
          <p>
            Вклад «{title}» ({this.props.contribution.contribution.id}) недоступен. Остальной
            интерфейс продолжает работать.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={this.retry}>
            <RotateCcw data-icon="inline-start" />
            Повторить
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
}
