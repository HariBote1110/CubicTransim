import { describe, it, expect } from 'vitest';
import {
  LOAN_LIMIT,
  LOAN_STEP,
  ANNUAL_INTEREST_RATE,
  takeLoan,
  repayLoan,
  monthlyInterest,
  maxAdditionalLoan,
} from './loans';

describe('借入', () => {
  it('借りた額がそのまま所持金と借入残高に乗る', () => {
    expect(takeLoan({ money: 1_000, loan: 0 }, LOAN_STEP)).toEqual({
      money: 1_000 + LOAN_STEP,
      loan: LOAN_STEP,
    });
  });

  it('借入上限を超える分は借りられない(上限までに切り詰められる)', () => {
    const before = { money: 0, loan: LOAN_LIMIT - LOAN_STEP };
    expect(takeLoan(before, LOAN_STEP * 5)).toEqual({ money: LOAN_STEP, loan: LOAN_LIMIT });
  });

  it('上限に達していれば借りても何も変わらない', () => {
    const before = { money: 500, loan: LOAN_LIMIT };
    expect(takeLoan(before, LOAN_STEP)).toEqual(before);
  });

  it('負の額を渡しても借入残高は減らない', () => {
    const before = { money: 500, loan: LOAN_STEP };
    expect(takeLoan(before, -LOAN_STEP)).toEqual(before);
  });

  it('あと借りられる額は上限と残高の差', () => {
    expect(maxAdditionalLoan(LOAN_LIMIT - LOAN_STEP)).toBe(LOAN_STEP);
    expect(maxAdditionalLoan(LOAN_LIMIT)).toBe(0);
  });
});

describe('返済', () => {
  it('返した額だけ所持金と借入残高が減る', () => {
    expect(repayLoan({ money: 50_000, loan: LOAN_STEP * 3 }, LOAN_STEP)).toEqual({
      money: 50_000 - LOAN_STEP,
      loan: LOAN_STEP * 2,
    });
  });

  it('所持金を超えては返済できない(手持ちの範囲に切り詰められる)', () => {
    expect(repayLoan({ money: 3_000, loan: LOAN_STEP * 2 }, LOAN_STEP)).toEqual({
      money: 0,
      loan: LOAN_STEP * 2 - 3_000,
    });
  });

  it('借入残高を超えては返済できない', () => {
    expect(repayLoan({ money: 100_000, loan: 4_000 }, LOAN_STEP)).toEqual({
      money: 96_000,
      loan: 0,
    });
  });

  it('所持金がマイナスのときは返済できない', () => {
    const before = { money: -5_000, loan: LOAN_STEP };
    expect(repayLoan(before, LOAN_STEP)).toEqual(before);
  });
});

describe('利息', () => {
  it('月利は年利の1/12(整数に丸める)', () => {
    expect(monthlyInterest(120_000)).toBe(Math.round((120_000 * ANNUAL_INTEREST_RATE) / 12));
  });

  it('無借金なら利息は0', () => {
    expect(monthlyInterest(0)).toBe(0);
  });
});
