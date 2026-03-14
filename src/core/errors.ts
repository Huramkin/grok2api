import type { ErrorResponse } from "../types";

export enum ErrorType {
  INVALID_REQUEST = "invalid_request_error",
  AUTHENTICATION = "authentication_error",
  PERMISSION = "permission_error",
  NOT_FOUND = "not_found_error",
  RATE_LIMIT = "rate_limit_error",
  SERVER = "server_error",
  SERVICE_UNAVAILABLE = "service_unavailable_error",
}

export function errorResponse(
  message: string,
  errorType: string = ErrorType.INVALID_REQUEST,
  param: string | null = null,
  code: string | null = null,
): ErrorResponse {
  return {
    error: { message, type: errorType, param, code },
  };
}

export class AppException extends Error {
  errorType: string;
  code: string | null;
  param: string | null;
  statusCode: number;

  constructor(
    message: string,
    errorType: string = ErrorType.SERVER,
    code: string | null = null,
    param: string | null = null,
    statusCode: number = 500,
  ) {
    super(message);
    this.errorType = errorType;
    this.code = code;
    this.param = param;
    this.statusCode = statusCode;
  }

  toResponse(): Response {
    return Response.json(
      errorResponse(this.message, this.errorType, this.param, this.code),
      { status: this.statusCode },
    );
  }
}

export class ValidationException extends AppException {
  constructor(message: string, param: string | null = null, code: string = "invalid_value") {
    super(message, ErrorType.INVALID_REQUEST, code, param, 400);
  }
}

export class AuthenticationException extends AppException {
  constructor(message: string = "Invalid API key") {
    super(message, ErrorType.AUTHENTICATION, "invalid_api_key", null, 401);
  }
}

export class UpstreamException extends AppException {
  details: Record<string, unknown>;

  constructor(
    message: string,
    details: Record<string, unknown> = {},
    statusCode: number = 502,
    code: string = "upstream_error",
  ) {
    super(message, ErrorType.SERVER, code, null, statusCode);
    this.details = details;
  }
}
