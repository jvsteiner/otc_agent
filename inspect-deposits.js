const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to Bob\'s page...');
    await page.goto('http://213.199.61.236:8080/d/6b80fc473bf0612aebf82a3f3477cdb8/b/77959d691110bb721eb6cd818f83e0a9', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Take screenshot
    await page.screenshot({ path: '/home/vrogojin/otc_agent/deposits-screenshot.png', fullPage: true });
    console.log('Screenshot saved to deposits-screenshot.png');

    // Get transaction history section
    const txHistoryHTML = await page.evaluate(() => {
      const section = document.querySelector('h2:has-text("Transaction History")');
      if (section) {
        return section.parentElement?.innerHTML || 'Not found';
      }
      return 'Transaction History section not found';
    });

    console.log('\n=== TRANSACTION HISTORY HTML ===');
    console.log(txHistoryHTML);

    // Get all text content
    const pageText = await page.textContent('body');
    console.log('\n=== PAGE TEXT (deposits section) ===');
    const lines = pageText.split('\n');
    const depositLines = lines.filter(line =>
      line.toLowerCase().includes('usdt') ||
      line.toLowerCase().includes('deposit') ||
      line.toLowerCase().includes('transaction')
    );
    depositLines.forEach(line => console.log(line.trim()));

    // Try to find transaction rows
    const transactions = await page.evaluate(() => {
      const txElements = Array.from(document.querySelectorAll('[class*="transaction"], tr, .tx-row'));
      return txElements.map(el => el.textContent?.trim()).filter(Boolean);
    });

    console.log('\n=== TRANSACTION ELEMENTS ===');
    console.log(JSON.stringify(transactions, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: '/home/vrogojin/otc_agent/deposits-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
})();
