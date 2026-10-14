import { getShortErrorMsg } from '@module-federation/error-codes';

const LOG_CATEGORY = '[ Federation Runtime ]';

// Same message format as the runtime-core logger's `error(code, descMap, ...)`,
// so callers that match on the error code (for example RUNTIME-008 in
// getRemoteEntry) see the same text.
export function error(
  code: string,
  descMap: Record<string, string>,
  args?: Record<string, unknown>,
  originalErrorMsg?: string,
): never {
  throw new Error(
    `${LOG_CATEGORY}: ${getShortErrorMsg(code, descMap, args, originalErrorMsg)}`,
  );
}
