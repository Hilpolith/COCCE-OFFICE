import { describe, expect, it } from 'vitest';
import { formatMoney, journalBalance, minorUnitsToDecimal, normalizeMoney, parseMinorUnits, sumMoney } from './officeMoney';

describe('exact Office money', () => {
  it('adds decimal strings without binary rounding or large-number precision loss', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney(['999999999999999999.99', '0.01'])).toBe('1000000000000000000.00');
    expect(parseMinorUnits('-0.01')).toBe(-1n);
    expect(minorUnitsToDecimal(-10001n)).toBe('-100.01');
    expect(normalizeMoney(' 12.3 ')).toBe('12.30');
    expect(normalizeMoney('-0.00')).toBe('0.00');
    expect(normalizeMoney('-2.5', true)).toBe('-2.50');
  });
  it.each(['1e3','NaN','Infinity','1,000','01.00','1.001','+1','--1','1.','', ' ', '0xFF'])('rejects ambiguous or inexact amount %s', value => {
    expect(() => parseMinorUnits(value)).toThrow();
  });
  it('does not accept runtime numbers, negative form amounts or oversized input', () => {
    expect(() => parseMinorUnits(0.1 as unknown as string)).toThrow();
    expect(() => normalizeMoney('-0.01')).toThrow('cannot be negative');
    expect(() => parseMinorUnits('9'.repeat(261))).toThrow();
  });
  it('formats signed values and complete large integer parts without floating-point conversion', () => {
    expect(formatMoney('1234.5')).toBe('TZS 1,234.50');
    expect(formatMoney('-9007199254740993.01', 'USD', 'en-US')).toBe('USD -9,007,199,254,740,993.01');
    expect(formatMoney('1234.5', 'EUR', 'de-DE')).toBe('EUR 1.234,50');
    expect(() => formatMoney('1', 'bad-code')).toThrow();
  });
  it('checks both sides of a journal with exact decimal arithmetic', () => {
    expect(journalBalance([{ debit:'0.10', credit:'0' }, { debit:'0.20', credit:'0' }, { debit:'0', credit:'0.30' }])).toEqual({debit:'0.30',credit:'0.30',difference:'0.00',balanced:true});
    expect(journalBalance([{debit:'20',credit:'0'},{debit:'0',credit:'19.99'}]).difference).toBe('0.01');
    expect(journalBalance([]).balanced).toBe(false);
    for (const line of [{debit:'0',credit:'0'},{debit:'1',credit:'1'},{debit:'-1',credit:'0'}]) expect(() => journalBalance([line])).toThrow();
  });
});
