import BizError from '../error/biz-error.js';

function integer(value, fallback, minimum, code) {
  if (value === undefined) return fallback;
  if (!/^\d{1,16}$/.test(String(value))) throw new BizError(code, 400);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new BizError(code, 400);
  return number;
}

export const mailPageSize = value => Math.min(50, integer(value, 10, 1, 'INVALID_PAGE_SIZE'));
export const mailCursor = value => integer(value, 0, 0, 'INVALID_MAIL_CURSOR');
