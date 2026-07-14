# Number Handling Best Practices

## Problem Statement

JavaScript's `parseFloat()` and `.toFixed()` can cause runtime crashes when handling invalid or unexpected data:

```typescript
// ❌ BAD - Can crash the UI
const value = parseFloat(apiResponse.price);  // Returns NaN if invalid
const display = value.toFixed(2);             // 💥 Throws error on NaN

// ❌ BAD - Silent failures
const pct = (someValue / anotherValue).toFixed(2);  // Returns "NaN" string
```

---

## Solution: Safe Utility Functions

Import from `@/lib/format`:

```typescript
import { toNumber, toFixed, toFixedPct, fmtNum, fmtPct } from '@/lib/format';
```

---

## API Reference

### `toNumber(value, fallback = 0): number`
Safely converts any value to a number.

```typescript
// ✅ GOOD - Safe conversion with fallback
const price = toNumber(apiResponse.price, 0);        // 0 if invalid
const quantity = toNumber(position.quantity, 1);     // 1 if invalid
const percentage = toNumber(stats.winRate, NaN);     // NaN if invalid (for conditionals)
```

**Use When:**
- Parsing API responses
- Converting string decimals to numbers
- Need a fallback for invalid data

---

### `toFixed(value, decimals = 2): string`
Safely formats a number to fixed decimal places.

```typescript
// ✅ GOOD - Never crashes
const display = toFixed(price, 2);           // "0.00" if invalid
const winRate = toFixed(stats.winRate, 1);   // "0.0" if invalid
```

**Use When:**
- Displaying prices without currency symbols
- Showing raw percentages without % sign
- Need guaranteed string output

---

### `toFixedPct(value, decimals = 2): string`
Formats percentage with + sign for positive values.

```typescript
// ✅ GOOD - Consistent percentage formatting
const pnl = toFixedPct(pnlFromCurrent, 2);   // "+5.23%" or "-2.15%"
const change = toFixedPct(changePercent, 1); // "+1.5%" or "-0.3%"
```

**Use When:**
- Showing P&L percentages
- Displaying change percentages
- Need automatic +/- sign handling

---

### `fmtNum(value, decimals = 2): string`
Formats number with Indian locale (commas).

```typescript
// ✅ GOOD - Locale-aware formatting
const balance = fmtNum(account.balance, 2);    // "5,00,000.00"
const volume = fmtNum(tickData.volume, 0);     // "2,50,000"
```

**Use When:**
- Displaying currency amounts
- Showing large numbers (volume, capital)
- Need comma separators

---

### `fmtPct(value, decimals = 1): string`
Formats percentage with + sign and % suffix.

```typescript
// ✅ GOOD - Complete percentage formatting
const change = fmtPct(changePct, 1);          // "+2.5%" or "—" if invalid
const returns = fmtPct(totalReturn, 2);       // "+12.45%"
```

**Use When:**
- API provides percentage as number (not already formatted)
- Need null-safe rendering ("—" for invalid)
- Want automatic +/- sign

---

## Migration Patterns

### Pattern 1: parseFloat → Number/toNumber

```typescript
// ❌ BEFORE
const pnl = parseFloat(position.unrealizedPnl);
const entry = parseFloat(position.avgEntryPrice);

// ✅ AFTER
const pnl = Number(position.unrealizedPnl);
const entry = Number(position.avgEntryPrice);
```

---

### Pattern 2: .toFixed() → toFixed()

```typescript
// ❌ BEFORE
const display = value.toFixed(2);
const pct = percentage.toFixed(1);

// ✅ AFTER
const display = toFixed(value, 2);
const pct = toFixed(percentage, 1);
```

---

### Pattern 3: Manual % Formatting → toFixedPct()

```typescript
// ❌ BEFORE
const sign = value >= 0 ? '+' : '';
const formatted = `${sign}${value.toFixed(2)}%`;

// ✅ AFTER
const formatted = toFixedPct(value, 2);
```

---

### Pattern 4: Inline Calculations → Safe Utilities

```typescript
// ❌ BEFORE
<span>
  {((allocated / balance) * 100).toFixed(0)}%
</span>

// ✅ AFTER
<span>
  {toFixed((allocated / balance) * 100, 0)}%
</span>
```

---

## Common Scenarios

### Scenario 1: Displaying P&L

```typescript
// Component receiving position data
function PositionRow({ pos }) {
  const pnl = Number(pos.unrealizedPnl);           // Safe conversion
  const entry = Number(pos.avgEntryPrice);         // Safe conversion
  const pnlPct = entry > 0 
    ? (pnl / (entry * pos.quantity)) * 100 
    : 0;

  return (
    <div>
      <span>₹{fmtNum(Math.abs(pnl), 2)}</span>
      <span>{toFixedPct(pnlPct, 2)}</span>          // "+5.23%" or "-2.15%"
    </div>
  );
}
```

---

### Scenario 2: Calculating Win Rate

```typescript
// Stats calculation with safe division
const stats = useMemo(() => {
  const wins = history.filter(h => Number(h.realizedPnl) > 0);
  const total = history.length;
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;
  
  return { winRate };
}, [history]);

// Display with fallback
<span>
  {history.length > 0 ? `${toFixed(stats.winRate, 0)}%` : '—'}
</span>
```

---

### Scenario 3: API Response Handling

```typescript
// Fetching account data
const { data: accountData } = useQuery({
  queryKey: ['account'],
  queryFn: api.account,
});

// Safe extraction with fallbacks
const balance = toNumber(accountData?.balance, 0);
const allocated = toNumber(accountData?.allocatedMargin, 0);
const available = balance - allocated;  // Always safe numbers

// Display
<span>₹{fmtNum(balance, 2)}</span>
<span>Deployed: {toFixed((allocated / balance) * 100, 0)}%</span>
```

---

## Type Safety Tips

### Prefer Number() over parseFloat()

```typescript
// parseFloat stops at first non-digit, Number() is stricter
parseFloat("123abc")  // 123 (unexpected!)
Number("123abc")      // NaN (expected!)

// Both handle decimals fine
parseFloat("123.45")  // 123.45
Number("123.45")      // 123.45
```

### Check Before Display

```typescript
// ✅ GOOD - Check validity before formatting
const value = toNumber(apiData.value, NaN);
if (!Number.isNaN(value)) {
  display = toFixed(value, 2);
} else {
  display = '—';  // Fallback for truly invalid data
}
```

---

## Testing Numbers

### Unit Test Examples

```typescript
import { toNumber, toFixed, toFixedPct } from '@/lib/format';

describe('Number utilities', () => {
  it('handles null/undefined gracefully', () => {
    expect(toNumber(null, 0)).toBe(0);
    expect(toNumber(undefined, 10)).toBe(10);
    expect(toFixed(null, 2)).toBe('0.00');
  });

  it('handles NaN strings', () => {
    expect(toNumber('invalid', 0)).toBe(0);
    expect(toFixed('bad', 2)).toBe('0.00');
  });

  it('formats percentages with sign', () => {
    expect(toFixedPct(5.5, 2)).toBe('+5.50%');
    expect(toFixedPct(-2.3, 2)).toBe('-2.30%');
    expect(toFixedPct(0, 2)).toBe('+0.00%');
  });

  it('preserves precision', () => {
    expect(toFixed(123.456, 2)).toBe('123.46');  // Rounds correctly
    expect(toFixed(0.1 + 0.2, 2)).toBe('0.30');  // Handles float precision
  });
});
```

---

## Edge Cases to Consider

### Division by Zero
```typescript
// ✅ GOOD - Check denominator
const pnlPct = entry > 0 ? (pnl / entry) * 100 : 0;
```

### Very Large Numbers
```typescript
// ✅ GOOD - Use scientific notation check
const volume = toNumber(tick.volume, 0);
if (volume > 1e9) {
  display = `${toFixed(volume / 1e9, 2)}B`;
}
```

### Negative Zero
```typescript
// JavaScript quirk: -0 === 0 but displays differently
const value = -0.001;
const rounded = toFixed(value, 2);  // "-0.00" might appear
// Use Math.abs() if you want to avoid "-0.00"
```

### Infinity
```typescript
// Division by very small number can produce Infinity
const ratio = wins / losses;
if (!Number.isFinite(ratio)) {
  display = '∞' or 'N/A';  // Handle explicitly
}
```

---

## Checklist for New Components

When adding components that display numbers:

- [ ] Import safe utilities from `@/lib/format`
- [ ] Use `Number()` or `toNumber()` for API data conversion
- [ ] Use `toFixed()` or `toFixedPct()` for display formatting
- [ ] Check for division by zero before calculations
- [ ] Test with null/undefined/invalid API responses
- [ ] Verify percentages show +/- signs correctly
- [ ] Use `fmtNum()` for currency with commas

---

## Performance Notes

All utility functions have **O(1)** time complexity:
- No loops
- No recursion
- Minimal type checking
- Native `Number()` coercion

**Memory:** Negligible - functions are pure (no state)

**Bundle Size:** ~1KB minified (all utilities combined)

---

## References

- [MDN: Number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number)
- [MDN: toFixed](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/toFixed)
- [JavaScript Number Precision Issues](https://0.30000000000000004.com/)
