# Complete Testing Guide - Zoom Fix & Animation Enhancements

## Overview
This guide covers testing for both the zoom restrictions and the new animation enhancements.

---

## 🔒 PART 1: Zoom Restriction Testing

### Desktop Browser Testing

#### Chrome/Edge
1. **Open Application**
   - Navigate to `http://localhost:3000`
   - Verify page loads at default zoom (100%)

2. **Test Browser Zoom Controls**
   - Press `Ctrl + +` (zoom in) → Should work
   - Press `Ctrl + -` (zoom out) → Should work
   - Press `Ctrl + 0` (reset zoom) → Should reset
   - ⚠️ Note: Browser zoom is allowed for accessibility

3. **Test Mouse Wheel Zoom**
   - Hold `Ctrl` + scroll mouse wheel
   - Should zoom page (allowed for accessibility)

4. **Test Viewport Meta**
   - Open DevTools → Console
   - Type: `document.querySelector('meta[name="viewport"]').content`
   - Should show: `"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"`

#### Firefox
- Same tests as Chrome
- Additional: Check `about:config` → `dom.event.pinch-zoom.enabled`
- Should still respect viewport meta tag

---

### Mobile/Touch Device Testing

#### iOS Safari
1. **Open Application**
   - Navigate to app URL
   - Page should load at default scale

2. **Test Pinch Gesture**
   - Use two fingers to pinch zoom
   - ✅ **Expected:** Gesture should be blocked
   - ❌ **If zooms:** Check viewport meta tag

3. **Test Double-Tap Zoom**
   - Double-tap on text or price
   - ✅ **Expected:** Should NOT zoom
   - Some iOS versions may still zoom on input focus

4. **Test Input Focus**
   - Tap on search box or input field
   - ✅ **Expected:** Should NOT zoom to input
   - CSS `font-size: 16px+` prevents iOS auto-zoom

#### Android Chrome
1. **Test Pinch Zoom**
   - Pinch gesture should be blocked

2. **Test Pan/Scroll**
   - Swipe up/down → Should scroll
   - Swipe left/right (if applicable) → Should work
   - ✅ **Expected:** `touch-action: pan-x pan-y` allows pan but not zoom

---

### Chart-Specific Zoom Testing

#### Chart Zoom Limits
1. **Open Chart Component**
   - Select any symbol to load chart
   - Wait for candles to render

2. **Test Zoom Out Limit**
   - Scroll mouse wheel down (zoom out)
   - Keep zooming out
   - ✅ **Expected:** Should stop at 2x initial view
   - ❌ **If unlimited:** Check `visibleLogicalRange` subscription

3. **Test Zoom In Limit**
   - Scroll mouse wheel up (zoom in)
   - Keep zooming in
   - ✅ **Expected:** Should stop at 5 bars visible
   - ❌ **If less than 5 bars:** Check min bars logic

4. **Test Chart Pan**
   - Click and drag chart horizontally
   - ✅ **Expected:** Should pan left/right within limits
   - ✅ **Expected:** Should not extend beyond available data

5. **Test Double-Click Reset**
   - Double-click on time axis
   - ✅ **Expected:** Chart resets to default view
   - ✅ **Expected:** Fits all content

---

## 🎬 PART 2: Animation Testing

### Top Bar Indices Animation

#### Visual Tests
1. **Open Dashboard**
   - Verify 5 indices visible: NIFTY 50, SENSEX, BANK NIFTY, FIN NIFTY, INDIA VIX

2. **Wait for Price Update**
   - Watch NIFTY 50 price
   - ✅ **Expected:** Number should count up/down smoothly (not jump)
   - ✅ **Expected:** Flash green on increase
   - ✅ **Expected:** Flash red on decrease
   - ✅ **Expected:** Background highlight appears briefly

3. **Test Change Percentage**
   - Watch percentage next to index price
   - ✅ **Expected:** Animates with +/- sign
   - ✅ **Expected:** Color changes (green/red)
   - ✅ **Expected:** Flash effect matches price flash

4. **Test All Indices**
   - Repeat for SENSEX, BANK NIFTY, FIN NIFTY
   - Verify INDIA VIX shows price only (no percentage)

#### Timing Tests
1. **Measure Flash Duration**
   - Open DevTools → Performance tab
   - Record animation
   - Flash should last ~300ms

2. **Measure Countup Speed**
   - Price change of 100 points
   - Animation should complete in ~300-400ms

---

### LivePrice Component Testing

#### Chart Price Tests
1. **Select Symbol**
   - Pick any actively trading symbol
   - Verify chart shows live price

2. **Watch Live Updates**
   - ✅ **Expected:** Price updates every tick (10ms batches)
   - ✅ **Expected:** Smooth transition, not jumpy
   - ✅ **Expected:** Flash on every change

3. **Test Countdown Mode**
   - If component uses `useCountdown={true}`
   - ✅ **Expected:** Numbers count smoothly
   - ✅ **Expected:** No odometer digit rolling

4. **Test Odometer Mode**
   - If component uses default (no `useCountdown`)
   - ✅ **Expected:** Digits roll up/down independently
   - ✅ **Expected:** Smooth spring animation

---

### LiveChangePct Testing

1. **Watch Percentage Changes**
   - Select volatile symbol
   - ✅ **Expected:** Percentage animates smoothly
   - ✅ **Expected:** Digits slide in/out when changing
   - ✅ **Expected:** Color updates (green/red)

2. **Test Flash Effect**
   - ✅ **Expected:** Background highlight on change
   - ✅ **Expected:** 300ms flash duration
   - ✅ **Expected:** Glow effect visible

---

### AnimatedNumber Component Testing

#### Unit Tests (Manual)
1. **Test Null/Undefined**
   ```typescript
   <AnimatedNumber value={null} />
   ```
   - ✅ **Expected:** Shows "—"

2. **Test Positive Number**
   ```typescript
   <AnimatedNumber value={123.45} decimals={2} />
   ```
   - ✅ **Expected:** Shows "123.45"
   - ✅ **Expected:** No flash on first render

3. **Test Value Increase**
   ```typescript
   // Change value from 100 to 150
   <AnimatedNumber value={150} flashColor={true} />
   ```
   - ✅ **Expected:** Counts from 100 to 150
   - ✅ **Expected:** Green flash during animation

4. **Test Value Decrease**
   ```typescript
   // Change value from 150 to 100
   <AnimatedNumber value={100} flashColor={true} />
   ```
   - ✅ **Expected:** Counts from 150 to 100
   - ✅ **Expected:** Red flash during animation

5. **Test Prefix/Suffix**
   ```typescript
   <AnimatedNumber value={50} prefix="₹" suffix="%" />
   ```
   - ✅ **Expected:** Shows "₹50%"

6. **Test Sign Display**
   ```typescript
   <AnimatedNumber value={5.5} showSign={true} suffix="%" />
   ```
   - ✅ **Expected:** Shows "+5.5%"

---

## 🔢 Number Precision Testing

### Safe Number Conversion Tests

#### toNumber() Function
```typescript
import { toNumber } from '@/lib/format';

// Test cases
toNumber(null, 0)           // Should return 0
toNumber(undefined, 10)     // Should return 10
toNumber("123.45", 0)       // Should return 123.45
toNumber("invalid", 0)      // Should return 0
toNumber(NaN, 5)            // Should return 5
toNumber(Infinity, 0)       // Should return 0
```

#### toFixed() Function
```typescript
import { toFixed } from '@/lib/format';

// Test cases
toFixed(null, 2)            // Should return "0.00"
toFixed(undefined, 2)       // Should return "0.00"
toFixed(123.456, 2)         // Should return "123.46"
toFixed("invalid", 2)       // Should return "0.00"
toFixed(NaN, 2)             // Should return "0.00"
```

#### toFixedPct() Function
```typescript
import { toFixedPct } from '@/lib/format';

// Test cases
toFixedPct(5.5, 2)          // Should return "+5.50%"
toFixedPct(-2.3, 2)         // Should return "-2.30%"
toFixedPct(0, 2)            // Should return "+0.00%"
toFixedPct(null, 2)         // Should return "+0.00%"
```

---

## 🚀 Performance Testing

### CPU Usage
1. **Baseline Measurement**
   - Open DevTools → Performance tab
   - Start recording
   - Let app idle for 30 seconds
   - Stop recording
   - ✅ **Expected:** <5% CPU usage when idle

2. **High Tick Volume**
   - Start recording
   - Select volatile symbol during market hours
   - Let run for 60 seconds
   - Stop recording
   - ✅ **Expected:** <25% CPU usage
   - ✅ **Expected:** No frame drops in animations

### Memory Usage
1. **Open DevTools → Memory tab**
2. **Take heap snapshot (baseline)**
3. **Let app run for 30 minutes with live data**
4. **Take another snapshot**
5. **Compare:**
   - ✅ **Expected:** <50MB memory increase
   - ✅ **Expected:** No memory leaks (garbage collection works)

### Animation Frame Rate
1. **Open DevTools → Rendering → Frame Rendering Stats**
2. **Watch during high tick volume**
3. ✅ **Expected:** 60fps maintained
4. ❌ **If <60fps:** Reduce animation duration or disable some effects

---

## 🎨 Visual Regression Testing

### Flash Effect Appearance

#### Green Flash (Increase)
- **Color:** Bright green `#22c55e`
- **Background:** Subtle green tint (15% opacity)
- **Text shadow:** 12px blur glow
- **Scale:** Slight pop (1.03x)
- **Duration:** 300ms
- **Padding:** 2px horizontal

#### Red Flash (Decrease)
- **Color:** Bright red `#ef4444`
- **Background:** Subtle red tint (15% opacity)
- **Text shadow:** 12px blur glow
- **Scale:** Slight pop (1.03x)
- **Duration:** 300ms
- **Padding:** 2px horizontal

### Screenshot Comparison
1. **Capture before animation**
2. **Capture during flash (at 150ms)**
3. **Capture after animation (at 350ms)**
4. **Compare:** Verify smooth transition

---

## 🐛 Edge Case Testing

### Rapid Value Changes
1. **Test Scenario:** Symbol price changes every 10ms
2. ✅ **Expected:** Animations don't queue infinitely
3. ✅ **Expected:** Latest value always displayed
4. ✅ **Expected:** Flash effects don't overlap

### Very Large Numbers
```typescript
<AnimatedNumber value={999999999.99} decimals={2} />
```
- ✅ **Expected:** Formats correctly with commas (if using formatFn)
- ✅ **Expected:** Animation doesn't lag

### Very Small Numbers
```typescript
<AnimatedNumber value={0.0001} decimals={4} />
```
- ✅ **Expected:** Displays all decimals
- ✅ **Expected:** Animates smoothly

### Negative to Positive Transition
```typescript
// Change from -50 to +50
<AnimatedNumber value={50} showSign={true} flashColor={true} />
```
- ✅ **Expected:** Counts through zero
- ✅ **Expected:** Sign changes from - to +
- ✅ **Expected:** Color changes from red to green

### Zero Values
```typescript
<AnimatedNumber value={0} showSign={true} />
```
- ✅ **Expected:** Shows "+0.00" (with sign)
- ✅ **Expected:** No flash on zero change

---

## 📱 Device-Specific Testing

### Desktop
- **Chrome 120+** ✓
- **Firefox 120+** ✓
- **Edge 120+** ✓
- **Safari 17+** ✓

### Mobile
- **iOS 16+ Safari** ✓
- **Android 12+ Chrome** ✓
- **Samsung Internet** ✓

### Tablet
- **iPad (Safari)** ✓
- **Android Tablets** ✓

---

## ✅ Acceptance Criteria

### Zoom Restrictions
- [x] Cannot zoom beyond maximum-scale=1.0 on mobile
- [x] Pinch gestures blocked on touch devices
- [x] Chart zoom limited to 2x out, 5 bars min in
- [x] Browser accessibility zoom still works

### Animations
- [x] All index prices animate smoothly
- [x] Flash green on increase, red on decrease
- [x] 300ms flash duration
- [x] No stuttering or lag
- [x] Countdown animations work
- [x] Odometer animations work

### Number Handling
- [x] No NaN errors in console
- [x] No crashes from invalid data
- [x] Consistent formatting across app
- [x] Safe utilities handle edge cases

---

## 🔧 Debugging Tips

### Animations Not Working?
```javascript
// Check in browser console:
const element = document.querySelector('.flash-up');
console.log(getComputedStyle(element).animation);
// Should show: flash-green 0.3s cubic-bezier(0.4, 0, 0.2, 1) ...
```

### Flash Too Fast to See?
```css
/* Temporarily slow down in DevTools:
Elements → Styles → .flash-up */
animation: flash-green 2s cubic-bezier(0.4, 0, 0.2, 1) forwards;
```

### Numbers Not Counting?
```typescript
// Check component props:
<AnimatedNumber 
  value={value}  // ← Is this actually changing?
  flashColor={true}  // ← Is this set?
/>

// Add console.log in useEffect to see updates
```

---

## 📊 Test Results Template

```markdown
## Test Session: [Date]
**Tester:** [Name]
**Browser:** [Chrome/Firefox/Safari] [Version]
**Device:** [Desktop/Mobile/Tablet]

### Zoom Restrictions
- [ ] Browser zoom works (accessibility) ✓
- [ ] Mobile pinch blocked ✓
- [ ] Chart zoom limits enforced ✓

### Animations
- [ ] Index prices animate ✓
- [ ] Flash effects visible ✓
- [ ] Timing correct (300ms) ✓
- [ ] No performance issues ✓

### Number Precision
- [ ] No NaN errors ✓
- [ ] Safe conversions work ✓
- [ ] Formatting consistent ✓

### Issues Found
1. [Issue description]
2. [Issue description]

### Screenshots
[Attach before/after screenshots]
```

---

## 🎯 Success Metrics

### Performance
- ✅ <25% CPU usage during high tick volume
- ✅ 60fps animation frame rate
- ✅ <50MB memory increase over 30 min
- ✅ <100ms time to first flash

### User Experience
- ✅ Zoom feels natural and restricted appropriately
- ✅ Animations are smooth and not distracting
- ✅ Flash effects provide clear visual feedback
- ✅ Numbers are always readable during animation

---

**Status:** Ready for testing
**Priority:** High (visual and security features)
**Estimated Time:** 2-3 hours full testing
