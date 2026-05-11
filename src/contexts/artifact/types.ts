export interface Artifact {
  id: string;
  taskId?: string;
  organizationId: string;
  createdBy: string;
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
