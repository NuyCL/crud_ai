// Business-rule failures. The service knows nothing about HTTP: it throws ServiceError with a
// machine-readable code (the enum of spec/openapi.yaml) and the handler maps codes to statuses.

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "FLAG_NOT_FOUND"
  | "FLAG_EXISTS"
  | "INVALID_KEY"
  | "KEY_IMMUTABLE"
  | "INVALID_VARIANTS"
  | "VALIDATION_ERROR";

/** A failure the client caused and can act on. Anything else that is thrown is a bug or an outage. */
export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const validationError = (message: string): ServiceError => new ServiceError("VALIDATION_ERROR", message);
export const variantsError = (message: string): ServiceError => new ServiceError("INVALID_VARIANTS", message);
export const notFound = (key: string): ServiceError => new ServiceError("FLAG_NOT_FOUND", `flag ${JSON.stringify(key)} not found`);
