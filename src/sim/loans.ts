// 借入(ローン)。純粋関数のみ。React/THREE には依存しない。
//
// 序盤に建設しすぎて資金が尽き、列車を買えないまま詰むのを防ぐための仕組み。
// OpenTTD と同じく「一定額まで自由に借りられ、毎月利息だけ引かれる」方式にした。
// 返済期限や信用審査は持たない ── 詰み回避が目的なので、判断材料を増やしたくない。

/** 借入の刻み(この単位でしか借りられない/返せない、というわけではなくUIの1回分)。 */
export const LOAN_STEP = 10_000;
/** 借入残高の上限。 */
export const LOAN_LIMIT = 200_000;
/** 年利。月末に loan × ANNUAL_INTEREST_RATE / 12 を利息として支払う。 */
export const ANNUAL_INTEREST_RATE = 0.05;

export interface Finances {
  money: number;
  loan: number;
}

/** あと借りられる額。 */
export function maxAdditionalLoan(loan: number): number {
  return Math.max(0, LOAN_LIMIT - loan);
}

/** 借りる。上限を超える分は切り詰める。 */
export function takeLoan(finances: Finances, amount: number): Finances {
  const borrowed = Math.min(Math.max(0, amount), maxAdditionalLoan(finances.loan));
  if (borrowed === 0) return finances;
  return { money: finances.money + borrowed, loan: finances.loan + borrowed };
}

/** 返す。手持ちと借入残高のどちらも超えられない。 */
export function repayLoan(finances: Finances, amount: number): Finances {
  const repaid = Math.min(Math.max(0, amount), finances.loan, Math.max(0, finances.money));
  if (repaid === 0) return finances;
  return { money: finances.money - repaid, loan: finances.loan - repaid };
}

/** 月末に支払う利息。 */
export function monthlyInterest(loan: number): number {
  return Math.round((loan * ANNUAL_INTEREST_RATE) / 12);
}
