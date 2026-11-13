import { attachmentUrl, replaceMarkdownImageUrls } from "../markdown-attachments.ts";
import type { NoteAttachment, NoteAttachmentMimeType } from "../model.ts";

export class AttachmentUrlCache {
  private readonly dataUrls = new Map<string, string>();
  private readonly attachmentIds = new Map<string, string>();

  set(id: string, mimeType: NoteAttachmentMimeType, contentBase64: string): string {
    const dataUrl = `data:${mimeType};base64,${contentBase64}`;
    const previous = this.dataUrls.get(id);
    if (previous !== undefined && previous !== dataUrl) {
      this.attachmentIds.delete(previous);
    }
    this.dataUrls.set(id, dataUrl);
    this.attachmentIds.set(dataUrl, id);
    return dataUrl;
  }

  add(attachment: NoteAttachment): string {
    return this.set(attachment.id, attachment.mimeType, attachment.contentBase64);
  }

  toEditor(markdown: string): string {
    return replaceMarkdownImageUrls(markdown, (url) => {
      if (!url.startsWith("attachment://")) {
        return url;
      }
      return this.dataUrls.get(url.slice("attachment://".length)) ?? url;
    });
  }

  toCanonical(markdown: string): string {
    return replaceMarkdownImageUrls(markdown, (url) => {
      const id = this.attachmentIds.get(url);
      return id === undefined ? url : attachmentUrl(id);
    });
  }
}
