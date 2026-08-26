export type WorkspaceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PATH_DENIED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'PROCESS_FAILED';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof WorkspaceError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: 'The operation failed unexpectedly; see the local server log.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Unknown error' };
}
