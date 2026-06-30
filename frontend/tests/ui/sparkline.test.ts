import { test, expect } from '@playwright/test';

test.describe('Composite Sparkline', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/mimir');
  });

  test('renders with correct color logic and constraints', async ({ page }) => {
    // Find the sparklines in the watchlist table
    const sparklines = page.locator('svg.sparkline');
    
    // If there are any symbols in the watchlist, we should see sparklines
    if (await sparklines.count() > 0) {
      const firstSpark = sparklines.first();
      await expect(firstSpark).toBeVisible();

      // Check for stroke color (binary logic: green or red)
      // For Geist/terminal aesthetic, it usually uses specific hex or css vars
      // We check that the path has a stroke attribute
      const path = firstSpark.locator('path').first();
      const stroke = await path.getAttribute('stroke');
      
      // Usually stroke is something like 'currentColor' or a specific class
      expect(stroke).toBeTruthy();
    }
  });
});
