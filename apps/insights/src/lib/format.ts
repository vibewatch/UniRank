export const number = new Intl.NumberFormat('en-US');
export const decimal = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});
export const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function signedPercent(value: number | null): string {
  if (value === null) return 'New';
  return `${value > 0 ? '+' : ''}${decimal.format(value)}%`;
}
