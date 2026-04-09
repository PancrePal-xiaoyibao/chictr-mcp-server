export enum AppErrorCode {
  NETWORK_ERROR = "NETWORK_ERROR",
  TARGET_5XX = "TARGET_5XX",
  CHALLENGE_ERROR = "CHALLENGE_ERROR",
  PARSE_ERROR = "PARSE_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export interface AppErrorShape {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  state?: "NORMAL" | "SUSPECTED" | "CHALLENGED" | "COOLDOWN" | "RECOVERY";
}

export function classifyError(input: unknown): AppErrorShape {
  const message = input instanceof Error ? input.message : String(input);
  const lower = message.toLowerCase();

  if (
    lower.includes("验证") ||
    lower.includes("滑动") ||
    lower.includes("verification") ||
    lower.includes("challenge") ||
    lower.includes("captcha") ||
    lower.includes("slider")
  ) {
    return {
      code: AppErrorCode.CHALLENGE_ERROR,
      message,
      retryable: false,
      state: "CHALLENGED",
    };
  }

  if (lower.includes("invalid") || lower.includes("参数") || lower.includes("required")) {
    return {
      code: AppErrorCode.INVALID_INPUT,
      message,
      retryable: false,
    };
  }

  if (lower.includes("parse") || lower.includes("解析")) {
    return {
      code: AppErrorCode.PARSE_ERROR,
      message,
      retryable: false,
    };
  }

  if (/(status|http)\s*5\d\d/.test(lower) || lower.includes("5xx")) {
    return {
      code: AppErrorCode.TARGET_5XX,
      message,
      retryable: true,
    };
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("net::")
  ) {
    return {
      code: AppErrorCode.NETWORK_ERROR,
      message,
      retryable: true,
    };
  }

  return {
    code: AppErrorCode.UNKNOWN_ERROR,
    message,
    retryable: true,
  };
}

export function toMcpErrorText(input: unknown): string {
  const normalized = classifyError(input);
  return JSON.stringify(normalized, null, 2);
}

