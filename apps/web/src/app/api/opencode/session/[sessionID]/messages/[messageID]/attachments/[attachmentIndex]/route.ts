import { handleOpenCodeAttachmentPreview } from "../../../../../../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AttachmentPreviewRouteContext {
  readonly params: Promise<{
    readonly sessionID: string;
    readonly messageID: string;
    readonly attachmentIndex: string;
  }>;
}

export async function GET(
  request: Request,
  context: AttachmentPreviewRouteContext,
): Promise<Response> {
  const { sessionID, messageID, attachmentIndex } = await context.params;
  return handleOpenCodeAttachmentPreview(sessionID, messageID, attachmentIndex, request);
}
