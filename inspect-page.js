const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to Alice\'s page...');
    await page.goto('http://213.199.61.236:8080/d/03305b87aac1a965fe455cac3673f551/a/3f72e1a04cd59fa082cd5b388d851157', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    console.log('Taking screenshot...');
    await page.screenshot({ path: '/home/vrogojin/otc_agent/alice-page.png', fullPage: true });

    console.log('\n=== PAGE TITLE ===');
    const title = await page.title();
    console.log(title);

    console.log('\n=== TRANSACTION HISTORY SECTION ===');
    const txHistoryHTML = await page.evaluate(() => {
      const section = document.querySelector('.transaction-history') ||
                      document.querySelector('[class*="transaction"]') ||
                      document.querySelector('[class*="history"]');
      return section ? section.outerHTML : 'Section not found';
    });
    console.log(txHistoryHTML.substring(0, 2000));

    console.log('\n=== VISIBLE TRANSACTIONS ===');
    const transactions = await page.evaluate(() => {
      const txElements = Array.from(document.querySelectorAll('[class*="transaction"], [class*="deposit"], tr'));
      return txElements.map(el => ({
        text: el.innerText?.trim(),
        html: el.outerHTML.substring(0, 300)
      })).filter(tx => tx.text && (tx.text.includes('ALPHA') || tx.text.includes('MATIC') || tx.text.includes('0x') || tx.text.includes('alpha1')));
    });
    console.log(JSON.stringify(transactions, null, 2));

    console.log('\n=== ALL PAGE TEXT ===');
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log(bodyText);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
