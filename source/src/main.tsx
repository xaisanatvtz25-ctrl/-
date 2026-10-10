import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installTapSounds } from './lib/sound';

// never inside another website's frame (it could trick a click on the login or a button)
if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try {
        (window.top as Window).location.href = window.location.href;
    } catch {
        // the other site does not allow it: the page stays empty
    }
    throw new Error('framed');
}

installTapSounds();

// Inside the Apps Script frame, route hash links through location.hash ourselves
document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
    }
    const el = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
    if (!el) {
        return;
    }
    e.preventDefault();
    const target = el.getAttribute('href') || '#/';
    if (window.location.hash !== target) {
        window.location.hash = target;
    }
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
