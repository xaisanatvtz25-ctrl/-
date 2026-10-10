#!/usr/bin/env python3
"""Draws the app icons (home screen / install) from the site's logo: public/icons/*.png. Run once; the PNGs are kept."""
import asyncio, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'icons')
os.makedirs(OUT, exist_ok=True)

MARK = ("<path d='M87.7 24.5A45 45 0 1 0 93.4 90.1' fill='none' stroke='#4fb3e8' stroke-width='13' stroke-linecap='round'/>"
        "<path d='M41 81V41L60 63L79 41V81' fill='none' stroke='#ffffff' stroke-width='11' stroke-linecap='round' stroke-linejoin='round'/>")


def svg(size, maskable):
    if maskable:
        # full square, the mark inside the safe circle (80%)
        inner = f"<g transform='translate(60 60) scale(0.7) translate(-60 -60)'>{MARK}</g>"
        return f"<svg xmlns='http://www.w3.org/2000/svg' width='{size}' height='{size}' viewBox='0 0 120 120'><rect width='120' height='120' fill='#0f3d6a'/>{inner}</svg>"
    return f"<svg xmlns='http://www.w3.org/2000/svg' width='{size}' height='{size}' viewBox='0 0 120 120'><rect width='120' height='120' rx='28' fill='#0f3d6a'/>{MARK}</svg>"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()
        for name, size, maskable in (('icon-192.png', 192, False), ('icon-512.png', 512, False), ('maskable-512.png', 512, True), ('apple-touch-icon.png', 180, True)):
            await page.set_viewport_size({'width': size, 'height': size})
            await page.set_content(f"<html><body style='margin:0;background:transparent'>{svg(size, maskable)}</body></html>")
            await page.locator('svg').screenshot(path=os.path.join(OUT, name), omit_background=not maskable)
        await b.close()
    print('icons written to', OUT)


if __name__ == '__main__':
    asyncio.run(main())
