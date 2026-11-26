export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_BODY", "Se requiere un objeto JSON.");
  }
  return value as Record<string, unknown>;
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "INVALID_INPUT", `${field} debe ser un UUID.`);
  }
  return value.toLowerCase();
}

export function integerQuery(
  value: unknown, field: string, min: number, max: number, fallback: number,
): number {
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpError(400, "INVALID_INPUT", `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return number;
}
