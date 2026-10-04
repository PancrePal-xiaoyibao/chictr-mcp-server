const MAX_KEYWORD_LENGTH = 200;
const MAX_RESULTS = 100;
const MIN_YEAR = 2000;
const MAX_YEAR_OFFSET = 1;
const REGISTRATION_NUMBER_PATTERN = /^ChiCTR\d{8,}$/i;

export interface SearchInput {
  keyword?: string;
  registrationNumber?: string;
  year?: number;
  maxResults: number;
}

function optionalTrimmedString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${name} 长度不能超过 ${maxLength}`);
  return trimmed;
}

export function validateRegistrationNumber(value: unknown): string {
  const registrationNumber = optionalTrimmedString(value, "registration_number", 32);
  if (!registrationNumber || !REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) {
    throw new Error("registration_number 格式无效，应为 ChiCTR 后接至少 8 位数字");
  }
  return registrationNumber;
}

export function validateSearchInput(args: Record<string, unknown> | undefined): SearchInput {
  const keyword = optionalTrimmedString(args?.keyword, "keyword", MAX_KEYWORD_LENGTH);
  const registrationNumber =
    args?.registration_number === undefined || args.registration_number === null
      ? undefined
      : validateRegistrationNumber(args.registration_number);

  const rawYear = args?.year;
  let year: number | undefined;
  if (rawYear !== undefined && rawYear !== null) {
    if (typeof rawYear !== "number" || !Number.isInteger(rawYear)) {
      throw new Error("year 必须是整数");
    }
    const maxYear = new Date().getFullYear() + MAX_YEAR_OFFSET;
    if (rawYear < MIN_YEAR || rawYear > maxYear) {
      throw new Error(`year 必须在 ${MIN_YEAR} 到 ${maxYear} 之间`);
    }
    year = rawYear;
  }

  const rawMaxResults = args?.max_results;
  const maxResults = rawMaxResults === undefined || rawMaxResults === null ? 20 : rawMaxResults;
  if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new Error(`max_results 必须是 1 到 ${MAX_RESULTS} 之间的整数`);
  }

  return { keyword, registrationNumber, year, maxResults };
}
