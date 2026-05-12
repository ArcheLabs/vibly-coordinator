export interface Artifact {
  id: string;
  taskId?: string;
  organizationId: string;
  createdBy: string;
  status?: "submitted" | "accepted" | "rejected" | "merged";
  mimeType: string;
  title: string;
  description?: string;
  /** CID or external URL — never raw bytes */
  contentRef: string;
  contentHash?: string;
  sizeBytes?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}
