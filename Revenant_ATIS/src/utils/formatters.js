/**
 * Formats a number as Uzbek Soum (UZS) currency.
 * Example: 1200000 -> "1,200,000 UZS"
 * @param {number} amount - The amount to format
 * @returns {string} - Formatted currency string
 */
export const formatUZS = (amount) => {
    if (typeof amount !== 'number') return '0 UZS';

    return new Intl.NumberFormat('en-US', {
        style: 'decimal',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(amount) + ' UZS';
};
