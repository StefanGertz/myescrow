export class AppError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "AppError";
  }
}

export function assert(condition: any, message: string, statusCode = 400): asserts condition {
  if (!condition) {
    throw new AppError(message, statusCode);
  }
}
