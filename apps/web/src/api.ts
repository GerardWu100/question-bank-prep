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
export const operation = () => crypto.randomUUID();
