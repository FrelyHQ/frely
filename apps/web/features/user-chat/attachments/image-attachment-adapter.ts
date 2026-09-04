import {
  SimpleImageAttachmentAdapter,
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";

export const USER_CHAT_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
export const USER_CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Keep assistant-ui's browser data-URL implementation while adding the
 * User Console's small, single-image policy.
 */
export class UserChatImageAttachmentAdapter implements AttachmentAdapter {
  public readonly accept = USER_CHAT_IMAGE_ACCEPT;
  private readonly delegate = new SimpleImageAttachmentAdapter();
  private readonly pendingIds = new Set<string>();

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    if (!supportedImageTypes.has(file.type)) {
      throw new Error("Only JPEG, PNG, and WebP images are supported.");
    }
    if (file.size <= 0 || file.size > USER_CHAT_IMAGE_MAX_BYTES) {
      throw new Error("Images must be between 1 byte and 5 MiB.");
    }
    if (this.pendingIds.size > 0) {
      throw new Error("Attach one image per message.");
    }

    const attachment = await this.delegate.add({ file });
    this.pendingIds.add(attachment.id);
    return attachment;
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    try {
      return await this.delegate.send(attachment);
    } finally {
      this.pendingIds.delete(attachment.id);
    }
  }

  async remove(attachment: Attachment): Promise<void> {
    this.pendingIds.delete(attachment.id);
    await this.delegate.remove();
  }
}
