/**
 * Asking the AI assistant from anywhere on the site: open it, or open it with the stock form in its box
 * (from the "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" page).
 */

export interface AiRequest {
    /** put the form for writing the stock (every product) in the box */
    template?: boolean;
}

const EVENT = 'milako:ai-request';

export function openAi(request: AiRequest = {}): void {
    window.dispatchEvent(new CustomEvent<AiRequest>(EVENT, { detail: request }));
}

export function onAiRequest(fn: (request: AiRequest) => void): () => void {
    const handler = (e: Event) => fn((e as CustomEvent<AiRequest>).detail || {});
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}
