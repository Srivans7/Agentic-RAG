export type SupportedFileExtension = "md" | "txt" | "pdf";

export interface UploadedFileMetadata {
  id: string;
  userId: string;
  name: string;
  size: number;
  mimeType: string;
  bucket: string;
  path: string;
  extension: SupportedFileExtension;
  createdAt: string;
  downloadUrl: string | null;
}

export interface FileListResponse {
  files: UploadedFileMetadata[];
  message?: string;
}

export interface FileUploadResponse {
  file: UploadedFileMetadata;
  message?: string;
}
