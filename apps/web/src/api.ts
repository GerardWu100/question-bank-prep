/** A server error with its stable code and, for conflicts, the current server value. */
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string | undefined,
    public current: any,
  ) {
    super(message);
  }
}
/** All browser API requests share credentials and surface committed server errors. */
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response
    .json()
    .catch(() => ({ error: response.statusText }));
  if (!response.ok)
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : data.error?.message || data.message || "Request failed",
      data.error?.code,
      data.error?.current,
    );
  return data;
}
/** Byte 6 holds the UUID version in its high nibble; byte 8 holds the variant bits. */
const UUID_VERSION_BYTE = 6;
const UUID_VARIANT_BYTE = 8;
/**
 * A random UUID version 4 (RFC 4122 / RFC 9562), e.g. "1b4e28ba-2fa1-41d2-883f-0016d3cca427".
 * Browsers offer crypto.randomUUID only in a secure context (HTTPS or localhost), so a
 * server reached over plain HTTP by IP address or host name builds the same format from
 * crypto.getRandomValues, which every context has. Never Math.random: operation IDs
 * keep retried writes from being applied twice, so they must not collide.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 = 0100 in the top four bits; variant 10xx in the top two bits.
  bytes[UUID_VERSION_BYTE] = (bytes[UUID_VERSION_BYTE] & 0x0f) | 0x40;
  bytes[UUID_VARIANT_BYTE] = (bytes[UUID_VARIANT_BYTE] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  // 16 bytes -> 8-4-4-4-12 hex digits.
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((group) => group.join(""))
    .join("-");
}
/** A unique operationId for one write, so a retried request is applied once. */
export const operation = randomId;
