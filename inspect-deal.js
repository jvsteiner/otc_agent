const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Navigating to deal page...');
    await page.goto('http://213.199.61.236:8080/d/2b282a0717717f766e12b64d6cdf180d/b/52d3e09f0d45a6c15d5929dc01d534b2', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    console.log('Page loaded, taking screenshot...');
    await page.screenshot({ path: '/home/vrogojin/otc_agent/deal-screenshot.png', fullPage: true });

    console.log('Extracting page content...');
    const textContent = await page.textContent('body');
    console.log('\n=== PAGE TEXT CONTENT ===\n');
    console.log(textContent);

    console.log('\n=== PAGE HTML (for structure) ===\n');
    const htmlContent = await page.content();
    console.log(htmlContent);

    // Try to extract specific elements
    console.log('\n=== SPECIFIC ELEMENTS ===\n');

    // Look for deal status
    const statusElements = await page.$$('text=/stage|status|CREATED|COLLECTION|WAITING|SWAP|CLOSED|REVERTED/i');
    console.log('Status elements found:', statusElements.length);

    // Look for timing information
    const timeElements = await page.$$('text=/created|countdown|expires|time/i');
    console.log('Time elements found:', timeElements.length);

    // Look for addresses
    const addressElements = await page.$$('text=/0x[a-fA-F0-9]{40}/');
    console.log('Address elements found:', addressElements.length);

    // Look for transaction info
    const txElements = await page.$$('text=/transaction|refund|MATIC|deposit/i');
    console.log('Transaction elements found:', txElements.length);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
