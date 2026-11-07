import { sqliteError } from "./errors.ts";

const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);

function isWordStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isWordPart(character: string): boolean {
  return /[A-Za-z0-9_$]/u.test(character);
}

function isTriggerKeywordSequence(words: readonly string[]): boolean {
  if (words[0] !== "CREATE") {
    return false;
  }

  let index = 1;

  if (words[index] === "TEMP" || words[index] === "TEMPORARY") {
    index += 1;
  }

  return words[index] === "TRIGGER";
}

/**
 * Ищет реальные transaction-control statements, не полагаясь на substring.
 *
 * Scanner понимает `--` и `/* *\/` комментарии, строковые литералы,
 * quoted/bracket identifiers, границы statements и trigger body `BEGIN … END`.
 * Слова `COMMIT`/`ROLLBACK` внутри строки или комментария не считаются
 * statement-ами.
 */
export function findTransactionControlStatement(
  sql: string,
): { readonly keyword: string; readonly index: number } | null {
  let index = 0;
  let atStatementStart = true;
  let statementWords: string[] = [];
  let triggerHeader = false;
  let inTriggerBody = false;
  let triggerDepth = 0;
  let caseDepth = 0;

  while (index < sql.length) {
    const character = sql[index] ?? "";

    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }

    if (character === "-" && sql[index + 1] === "-") {
      index += 2;

      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }

      continue;
    }

    if (character === "/" && sql[index + 1] === "*") {
      index += 2;

      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }

      index = Math.min(sql.length, index + 2);
      continue;
    }

    if (character === "'") {
      index += 1;

      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }

          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    if (character === '"' || character === "`") {
      const delimiter = character;
      index += 1;

      while (index < sql.length) {
        if (sql[index] === delimiter) {
          if (sql[index + 1] === delimiter) {
            index += 2;
            continue;
          }

          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    if (character === "[") {
      index += 1;

      while (index < sql.length && sql[index] !== "]") {
        index += 1;
      }

      index = Math.min(sql.length, index + 1);
      continue;
    }

    if (character === ";") {
      if (!inTriggerBody) {
        atStatementStart = true;
        statementWords = [];
        triggerHeader = false;
      }

      index += 1;
      continue;
    }

    if (isWordStart(character)) {
      const start = index;

      index += 1;

      while (index < sql.length && isWordPart(sql[index] ?? "")) {
        index += 1;
      }

      const word = sql.slice(start, index).toUpperCase();

      if (inTriggerBody) {
        if (word === "CASE") {
          caseDepth += 1;
        } else if (word === "END") {
          if (caseDepth > 0) {
            caseDepth -= 1;
          } else {
            triggerDepth -= 1;

            if (triggerDepth === 0) {
              inTriggerBody = false;
            }
          }
        }

        continue;
      }

      if (atStatementStart) {
        if (TRANSACTION_CONTROL.has(word)) {
          return { keyword: word, index: start };
        }

        statementWords = [word];
        atStatementStart = false;
      } else {
        statementWords.push(word);
      }

      triggerHeader = isTriggerKeywordSequence(statementWords);

      if (triggerHeader && word === "BEGIN") {
        inTriggerBody = true;
        triggerDepth = 1;
        caseDepth = 0;
      }

      continue;
    }

    index += 1;
  }

  return null;
}

/** Отклоняет SQL миграции до выполнения первого statement. */
export function assertNoTransactionControlStatements(sql: string): void {
  const match = findTransactionControlStatement(sql);

  if (match !== null) {
    throw sqliteError("INVALID_ARGUMENT", "SQL миграции не может управлять транзакцией", {
      details: {
        reason: "transaction_control",
        keyword: match.keyword,
        offset: match.index,
      },
    });
  }
}
