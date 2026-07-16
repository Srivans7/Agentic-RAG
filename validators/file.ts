const ALLOWED_EXTENSIONS = [".md", ".txt", ".pdf"] as const;
const ALLOWED_MIME_TYPES = ["text/markdown", "text/plain", "application/pdf", ""] as const;

export const ALLOWED_UPLOAD_EXTENSIONS = [...ALLOWED_EXTENSIONS];
export const ALLOWED_UPLOAD_MIME_TYPES = ALLOWED_MIME_TYPES.filter(Boolean);

function getExtension(name: string) {
  const lastDotIndex = name.lastIndexOf(".");

  if (lastDotIndex < 0) {
    return "";
  }

  return name.slice(lastDotIndex).toLowerCase();
}

export function sanitizeFileName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-");
}

export function isAllowedUploadFile(file: Pick<File, "name" | "type">) {
  const extension = getExtension(file.name);
  const mimeType = file.type.toLowerCase();
  const isExtensionAllowed = ALLOWED_EXTENSIONS.includes(extension as (typeof ALLOWED_EXTENSIONS)[number]);
  const isMimeAllowed = mimeType === "" || ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number]);
  const isPdfByType = mimeType === "application/pdf" || extension === ".pdf";

  return isExtensionAllowed && (isMimeAllowed || isPdfByType);
}

export function getUploadValidationMessage(fileName: string) {
  return `Only ${ALLOWED_EXTENSIONS.join(", ")} files are supported. \`${fileName}\` is not allowed.`;
}
