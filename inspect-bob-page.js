const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to Bob\'s page...');
  await page.goto('http://213.199.61.236:8080/d/04612e1576253ce5a61438c1a0064840/b/ed395ae3861eb4b6c3ef854a2b4d83d0');

  // Wait for content to load
  await page.waitForTimeout(2000);

  // Take screenshot
  await page.screenshot({ path: '/home/vrogojin/otc_agent/bob-page-screenshot.png', fullPage: true });
  console.log('Screenshot saved to bob-page-screenshot.png');

  // Extract transaction history section
  const txHistory = await page.evaluate(() => {
    const txSection = document.querySelector('body');
    return txSection ? txSection.innerHTML : 'Not found';
  });

  // Look for addresses in the HTML
  const addresses = await page.evaluate(() => {
    const results = [];
    const bodyText = document.body.innerText;

    // Find all address-like strings
    const addressMatches = bodyText.matchAll(/(?:alpha1[a-z0-9]+|0x[a-fA-F0-9]{40})/g);
    for (const match of addressMatches) {
      results.push(match[0]);
    }

    return results;
  });

  console.log('\n=== ADDRESSES FOUND ON PAGE ===');
  console.log(JSON.stringify(addresses, null, 2));

  // Get specific transaction rows
  const txRows = await page.evaluate(() => {
    const rows = [];
    const trs = document.querySelectorAll('tr');
    trs.forEach(tr => {
      const text = tr.innerText;
      if (text.includes('alpha1') || text.includes('0x')) {
        rows.push(text);
      }
    });
    return rows;
  });

  console.log('\n=== TRANSACTION ROWS ===');
  txRows.forEach((row, i) => {
    console.log(`Row ${i + 1}:`);
    console.log(row);
    console.log('---');
  });

  await browser.close();
})();
