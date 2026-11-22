import { handleOpenCodePrompt } from "../../../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PromptRouteContext {
  readonly params: Promise<{ readonly sessionID: string }>;
}

export async function POST(request: Request, context: PromptRouteContext): Promise<Response> {
  const { sessionID } = await context.params;
  return handleOpenCodePrompt(sessionID, request);
}
