import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const A4_W = 794;
const A4_H = 1123;
const PT_W = 595.28;
const PT_H = 841.89;

function wait(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isSafari(): boolean {
    const ua = navigator.userAgent;
    return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function mount(node: ReactNode, className: string) {
    const host = document.createElement('div');
    host.className = className;
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
    const root = createRoot(host);
    flushSync(() => root.render(node));
    try {
        await document.fonts.ready;
    } catch {
        // ignore
    }
    await wait(80);
    return {
        host,
        cleanup: () => {
            root.unmount();
            host.remove();
        },
    };
}

/** Render A4 sheets off-screen and save them as a PDF file. */
export async function exportPdf(node: ReactNode, filename: string, title: string): Promise<void> {
    const { host, cleanup } = await mount(node, 'pdf-host');
    try {
        const sheets = Array.from(host.querySelectorAll<HTMLElement>('.a4'));
        if (!sheets.length) {
            throw new Error('no pages');
        }
        const [{ toJpeg, getFontEmbedCSS }, { PDFDocument }] = await Promise.all([import('html-to-image'), import('pdf-lib')]);
        let fontEmbedCSS: string | undefined;
        try {
            fontEmbedCSS = await getFontEmbedCSS(sheets[0]);
        } catch (e) {
            console.warn('font embed failed, continuing without', e);
        }
        const pdf = await PDFDocument.create();
        pdf.setTitle(title);
        pdf.setAuthor('ບໍລິສັດ ມິລະໂກະ');
        pdf.setCreator('Milako Production Summary');
        const safari = isSafari();
        for (const sheet of sheets) {
            const options = {
                pixelRatio: 2,
                quality: 0.93,
                backgroundColor: '#ffffff',
                width: A4_W,
                height: A4_H,
                fontEmbedCSS,
            };
            let dataUrl = await toJpeg(sheet, options);
            if (safari) {
                // Safari sometimes paints fonts only on the second pass
                dataUrl = await toJpeg(sheet, options);
            }
            const image = await pdf.embedJpg(dataUrlToBytes(dataUrl));
            const page = pdf.addPage([PT_W, PT_H]);
            page.drawImage(image, { x: 0, y: 0, width: PT_W, height: PT_H });
        }
        const bytes = await pdf.save();
        downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), filename);
    } finally {
        cleanup();
    }
}

/** Fallback: open the browser print dialog with only the report pages. */
export async function printReport(node: ReactNode): Promise<void> {
    const { cleanup } = await mount(node, 'print-host');
    document.body.classList.add('is-printing');
    const done = () => {
        document.body.classList.remove('is-printing');
        cleanup();
        window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    // Some mobile browsers never fire afterprint
    window.setTimeout(() => {
        if (document.body.classList.contains('is-printing')) {
            done();
        }
    }, 60_000);
}
