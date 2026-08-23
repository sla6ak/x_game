/**
 * browser.js — хелперы для Playwright-страниц.
 */

/**
 * Блокировщик лишних ресурсов (картинки, шрифты, стили, медиа).
 * @param {import('playwright').Page} page
 */
function blockResources(page) {
  return page.route("**/*", (route) => {
    const blocked = ["image", "media", "font", "stylesheet"];
    blocked.includes(route.request().resourceType())
      ? route.abort()
      : route.continue();
  });
}

module.exports = { blockResources };
