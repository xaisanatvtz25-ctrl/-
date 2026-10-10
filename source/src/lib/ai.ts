/**
 * The AI behind the assistant (ຖາມ AI), which also puts stock written as sentences into rows.
 *
 * The person brings a key from any of the big AI services (Gemini, ChatGPT, Claude, OpenRouter, Groq, DeepSeek,
 * Grok, or any OpenAI-compatible service). The key is kept only in this browser (encrypted with the data key of the
 * person logged in) and the requests go straight from the browser to that service: the website has no server of its own.
 *
 * Model names change often, so the models are taken from the service's own list when the key is checked
 * (a fast one for answers, a careful one for reading pictures); the person can change them.
 */

import { LOCAL, getLocal, onLocalChange, setLocal } from './vault';

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'groq' | 'deepseek' | 'xai' | 'custom';
type Wire = 'gemini' | 'openai' | 'anthropic';

export interface Provider {
    id: ProviderId;
    /** shown to the person */
    name: string;
    /** short name for the badge in the assistant */
    short: string;
    wire: Wire;
    base: string;
    keyHint: string;
    keyUrl: string;
    /** can read pictures (scans and photos of the stock sheet) */
    vision: boolean;
}

export const PROVIDERS: Provider[] = [
    { id: 'gemini', name: 'Google Gemini', short: 'Gemini', wire: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', keyHint: 'AIza… / AQ.…', keyUrl: 'https://aistudio.google.com/apikey', vision: true },
    { id: 'openai', name: 'OpenAI (ChatGPT)', short: 'ChatGPT', wire: 'openai', base: 'https://api.openai.com/v1', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys', vision: true },
    { id: 'anthropic', name: 'Anthropic (Claude)', short: 'Claude', wire: 'anthropic', base: 'https://api.anthropic.com/v1', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', vision: true },
    { id: 'openrouter', name: 'OpenRouter', short: 'OpenRouter', wire: 'openai', base: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…', keyUrl: 'https://openrouter.ai/keys', vision: true },
    { id: 'groq', name: 'Groq', short: 'Groq', wire: 'openai', base: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…', keyUrl: 'https://console.groq.com/keys', vision: true },
    { id: 'deepseek', name: 'DeepSeek', short: 'DeepSeek', wire: 'openai', base: 'https://api.deepseek.com', keyHint: 'sk-…', keyUrl: 'https://platform.deepseek.com/api_keys', vision: false },
    { id: 'xai', name: 'xAI (Grok)', short: 'Grok', wire: 'openai', base: 'https://api.x.ai/v1', keyHint: 'xai-…', keyUrl: 'https://console.x.ai', vision: true },
    { id: 'custom', name: 'OpenAI-compatible', short: 'AI', wire: 'openai', base: '', keyHint: '', keyUrl: '', vision: true },
];

export function providerOf(id: string | undefined): Provider {
    return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/** The service a key belongs to, from the way it starts (null: cannot tell). */
export function detectProvider(key: string): ProviderId | null {
    const k = key.trim();
    if (/^sk-ant-/.test(k)) return 'anthropic';
    if (/^sk-or-/.test(k)) return 'openrouter';
    if (/^gsk_/.test(k)) return 'groq';
    if (/^xai-/.test(k)) return 'xai';
    if (/^(AIza|AQ\.)/.test(k)) return 'gemini';
    if (/^sk-[0-9a-f]{32}$/.test(k)) return 'deepseek';
    if (/^sk-/.test(k)) return 'openai';
    return null;
}

/* ---------- the person's settings (this browser only) ---------- */

export interface AiConfig {
    provider: ProviderId;
    key: string;
    /** model for answers ('' = choose at first use) */
    model: string;
    /** model for reading pictures ('' = the answer model) */
    visionModel: string;
    /** address of an OpenAI-compatible service (custom only) */
    baseUrl?: string;
    /** the models the service offered, to choose from */
    models?: string[];
}

const listeners = new Set<() => void>();
let hooked = false;

function clean(raw: unknown): AiConfig | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!key || !PROVIDERS.some((p) => p.id === o.provider)) {
        return null;
    }
    const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    return {
        provider: o.provider as ProviderId,
        key,
        model: str(o.model),
        visionModel: str(o.visionModel),
        baseUrl: str(o.baseUrl) || undefined,
        models: Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === 'string').slice(0, 300) : undefined,
    };
}

export function getAiConfig(): AiConfig | null {
    try {
        const raw = getLocal(LOCAL.ai);
        return raw ? clean(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

export function setAiConfig(cfg: AiConfig | null): void {
    setLocal(LOCAL.ai, cfg ? JSON.stringify(cfg) : null); // tells onAiChange
}

/** called when the settings change (in this page, or in another tab of this browser) */
export function onAiChange(fn: () => void): () => void {
    if (!hooked) {
        hooked = true;
        onLocalChange(LOCAL.ai, () => listeners.forEach((f) => f()));
    }
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/* ---------- errors ---------- */

export type AiErrorKind = 'auth' | 'quota' | 'timeout' | 'network' | 'model' | 'vision' | 'other';

export class AiError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = '') {
        super(message);
        this.status = status;
        this.code = code;
    }

    get kind(): AiErrorKind {
        const text = `${this.message} ${this.code}`;
        if (this.code === 'TIMEOUT') return 'timeout';
        if (this.code === 'NETWORK' || this.code === 'OFFLINE') return 'network';
        if (this.code === 'NO_VISION') return 'vision';
        if (this.status === 402 || this.status === 429 || /quota|RESOURCE_EXHAUSTED|insufficient|credit|billing|rate.?limit/i.test(text)) return 'quota';
        if (this.status === 401 || this.status === 403) return 'auth';
        if (this.status === 400 && /api.?key|API_KEY|invalid.*key|key.*invalid|ACCESS_TOKEN|unauthori[sz]ed|credential|authentication/i.test(text)) return 'auth';
        if (this.status === 404 || this.code === 'NO_MODEL' || /model.*(not.?found|does not exist|not supported|unknown)|NOT_FOUND/i.test(text)) return 'model';
        return 'other';
    }

    /** short code shown to the person, e.g. "HTTP 401 · API_KEY_INVALID" */
    get shown(): string {
        return [this.status ? `HTTP ${this.status}` : '', this.code].filter(Boolean).join(' · ') || this.message.slice(0, 60);
    }
}

export function asAiError(e: unknown): AiError {
    if (e instanceof AiError) {
        return e;
    }
    return new AiError(e instanceof Error ? e.message : String(e), 0, 'ERROR');
}

/* ---------- requests ---------- */

interface Res {
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    raw: string;
}

async function http(url: string, init: RequestInit, ms: number): Promise<Res> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const raw = await res.text();
        let data: unknown = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch {
            data = null;
        }
        return { status: res.status, data, raw };
    } catch (e) {
        if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') {
            throw new AiError('timeout', 0, 'TIMEOUT');
        }
        throw new AiError('network', 0, typeof navigator !== 'undefined' && navigator.onLine === false ? 'OFFLINE' : 'NETWORK');
    } finally {
        window.clearTimeout(timer);
    }
}

function failure(res: Res): AiError {
    const d = res.data && typeof res.data === 'object' ? res.data : {};
    const e = d.error && typeof d.error === 'object' ? d.error : d;
    const message = String(e.message || (typeof d.error === 'string' ? d.error : '') || res.raw || `HTTP ${res.status}`).slice(0, 300);
    const details = Array.isArray(e.details) ? e.details.map((x: { reason?: string }) => x && x.reason).find(Boolean) : '';
    const code = String(details || e.status || e.code || e.type || '').slice(0, 60);
    return new AiError(message, res.status, code);
}

const ok = (res: Res) => res.status >= 200 && res.status < 300;

function baseOf(cfg: { provider: ProviderId; baseUrl?: string }): string {
    const p = providerOf(cfg.provider);
    return (cfg.provider === 'custom' ? cfg.baseUrl || '' : p.base).replace(/\/+$/, '');
}

function anthropicHeaders(key: string): Record<string, string> {
    return {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
    };
}

function bearer(key: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
}

/* ---------- the models a service offers, and the ones we use ---------- */

interface ModelList {
    ids: string[];
    /** models that read pictures, when the service says so */
    vision?: Set<string>;
    /** OpenRouter: the account has no credit (free models only) */
    free?: boolean;
}

async function listModels(provider: ProviderId, key: string, baseUrl?: string): Promise<ModelList> {
    const p = providerOf(provider);
    const base = baseOf({ provider, baseUrl });
    if (p.wire === 'gemini') {
        const res = await http(`${base}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } }, 20_000);
        if (!ok(res)) throw failure(res);
        const models = Array.isArray(res.data && res.data.models) ? res.data.models : [];
        return {
            ids: models
                .filter((m: { supportedGenerationMethods?: string[] }) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                .map((m: { name?: string }) => String(m.name || '').replace(/^models\//, ''))
                .filter(Boolean),
        };
    }
    if (p.wire === 'anthropic') {
        const res = await http(`${base}/models?limit=1000`, { headers: anthropicHeaders(key) }, 20_000);
        if (!ok(res)) throw failure(res);
        return { ids: (Array.isArray(res.data && res.data.data) ? res.data.data : []).map((m: { id?: string }) => String(m.id || '')).filter(Boolean) };
    }
    if (provider === 'openrouter') {
        // the model list is public: check the key on its own
        const who = await http(`${base}/key`, { headers: bearer(key) }, 20_000);
        if (!ok(who)) throw failure(who);
        const free = Boolean(who.data && who.data.data && who.data.data.is_free_tier);
        const res = await http(`${base}/models`, { headers: bearer(key) }, 20_000);
        if (!ok(res)) throw failure(res);
        const list = Array.isArray(res.data && res.data.data) ? res.data.data : [];
        const vision = new Set<string>();
        for (const m of list) {
            const mods = m && m.architecture && (m.architecture.input_modalities || []);
            if (Array.isArray(mods) && mods.includes('image')) vision.add(String(m.id));
        }
        return { ids: list.map((m: { id?: string }) => String(m.id || '')).filter(Boolean), vision, free };
    }
    const res = await http(`${base}/models`, { headers: bearer(key) }, 20_000);
    if (!ok(res)) throw failure(res);
    return { ids: (Array.isArray(res.data && res.data.data) ? res.data.data : []).map((m: { id?: string }) => String(m.id || '')).filter(Boolean) };
}

/** not models for answering in text */
const NOT_CHAT =
    /(embed|whisper|tts|speech|audio|realtime|transcri|moderation|dall-?e|imagen|image|veo|lyria|sora|search|codex|instruct-|davinci|babbage|computer-use|deep-research|robotics|-live|translate|banana|omni|guard|rerank|antigravity|aqa|learnlm|compound|distil|prompt|clip)/i;

/** the first number of a name: gemini-3.8-flash → 3.8, claude-haiku-5-5 → 5.5, gpt-6-luna → 6 */
function version(id: string): number {
    const s = id
        .replace(/^.*\//, '')
        .replace(/:.*$/, '')
        .replace(/-\d{4}-?\d{2}-?\d{2}.*$/, '')
        .replace(/-\d{4}$/, '');
    const m = s.match(/(?:^|[^\d])(\d{1,2})(?:[.-](\d))?(?!\d)/);
    return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
}

const unstable = (id: string) => /preview|exp|beta|alpha|test/i.test(id);

/** models in the order to try: the first pattern that matches wins, the newest stable version first */
function ranked(ids: string[], prefs: RegExp[]): string[] {
    const usable = ids.filter((id) => !NOT_CHAT.test(id.replace(/:free$/, '')));
    const out: string[] = [];
    for (const re of prefs) {
        const hits = usable
            .filter((id) => re.test(id.replace(/:free$/, '')) && !out.includes(id))
            .sort((a, b) => Number(unstable(a)) - Number(unstable(b)) || version(b) - version(a) || a.length - b.length);
        out.push(...hits);
    }
    return out;
}

const PREFS: Record<ProviderId, { chat: RegExp[]; vision: RegExp[]; fallback: { chat: string; vision: string } }> = {
    gemini: {
        chat: [/^gemini-[\d.]+-flash-lite$/, /^gemini-flash-lite-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-flash-latest$/, /^gemini-.*flash/, /^gemini-/],
        vision: [/^gemini-[\d.]+-flash$/, /^gemini-flash-latest$/, /^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash-lite$/, /^gemini-flash-lite-latest$/, /^gemini-/],
        fallback: { chat: 'gemini-flash-lite-latest', vision: 'gemini-flash-latest' },
    },
    openai: {
        chat: [/^gpt-[\d.]+-luna$/, /^gpt-[\d.]+o?-mini$/, /^gpt-[\d.]+-sol$/, /^gpt-[\d.]+o?$/, /^gpt-[\d.]+-[a-z]+$/, /^gpt-/, /^o\d/],
        vision: [/^gpt-[\d.]+-sol$/, /^gpt-[\d.]+o?-mini$/, /^gpt-[\d.]+-luna$/, /^gpt-[\d.]+o?$/, /^gpt-[\d.]+-[a-z]+$/, /^gpt-/],
        fallback: { chat: 'gpt-4o-mini', vision: 'gpt-4o-mini' },
    },
    anthropic: {
        chat: [/haiku/, /sonnet/, /claude/],
        vision: [/sonnet/, /haiku/, /claude/],
        fallback: { chat: 'claude-haiku-4-5', vision: 'claude-sonnet-4-5' },
    },
    openrouter: {
        chat: [/^google\/gemini-[\d.]+-flash-lite$/, /^google\/gemini-[\d.]+-flash$/, /^openai\/gpt-[\d.]+-(luna|mini)$/, /^openai\/gpt-[\d.]+o-mini$/, /^anthropic\/claude.*haiku/, /^deepseek\/deepseek-chat/, /^meta-llama\/llama-[\d.]+-.*instruct/, /^google\/gemini/],
        vision: [/^google\/gemini-[\d.]+-flash$/, /^openai\/gpt-[\d.]+-(sol|mini)$/, /^openai\/gpt-[\d.]+o-mini$/, /^anthropic\/claude.*sonnet/, /^google\/gemini-[\d.]+-flash-lite$/, /^google\/gemini/],
        fallback: { chat: 'google/gemini-2.5-flash', vision: 'google/gemini-2.5-flash' },
    },
    groq: {
        chat: [/gpt-oss-120b/, /kimi-k2/, /llama-3\.3-70b/, /llama-4-maverick/, /llama-4-scout/, /qwen/, /llama/],
        vision: [/llama-4-maverick/, /llama-4-scout/, /vision/],
        fallback: { chat: 'llama-3.3-70b-versatile', vision: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    },
    deepseek: { chat: [/^deepseek-chat$/, /deepseek/], vision: [], fallback: { chat: 'deepseek-chat', vision: '' } },
    xai: {
        chat: [/^grok-[\d.]+-fast-non-reasoning$/, /^grok-[\d.]+-mini$/, /^grok-[\d.]+-fast/, /^grok-[\d.]+$/, /^grok/],
        vision: [/^grok-[\d.]+$/, /^grok-[\d.]+-fast/, /vision/, /^grok/],
        fallback: { chat: 'grok-3-mini', vision: 'grok-4' },
    },
    custom: { chat: [], vision: [], fallback: { chat: '', vision: '' } },
};

function chooseModels(provider: ProviderId, list: ModelList, typed?: string): { chat: string[]; vision: string; all: string[] } {
    const prefs = PREFS[provider];
    let ids = list.ids;
    if (provider === 'openrouter' && list.free) {
        const free = ids.filter((id) => id.endsWith(':free'));
        if (free.length) ids = free; // an account without credit can only use the free models
    }
    const all = ids.filter((id) => !NOT_CHAT.test(id.replace(/:free$/, ''))).slice(0, 300);
    if (typed) {
        return { chat: [typed], vision: providerOf(provider).vision ? typed : '', all };
    }
    let chat = ranked(ids, prefs.chat);
    if (!chat.length && prefs.fallback.chat) chat = [prefs.fallback.chat];
    let visionIds = ids;
    if (list.vision && list.vision.size) visionIds = ids.filter((id) => list.vision!.has(id));
    const vision = providerOf(provider).vision ? ranked(visionIds, prefs.vision)[0] || prefs.fallback.vision || chat[0] || '' : '';
    return { chat: chat.slice(0, 4), vision, all };
}

/** a key without a model yet (saved by the earlier website, or checked while the service was slow):
 *  take the models from the service; keep them when the list came */
async function withModels(cfg: AiConfig): Promise<AiConfig> {
    if (cfg.model) {
        return cfg;
    }
    let list: ModelList | null = null;
    try {
        list = await listModels(cfg.provider, cfg.key, cfg.baseUrl);
    } catch (e) {
        const err = asAiError(e);
        if (err.kind === 'auth') throw err;
    }
    const chosen = chooseModels(cfg.provider, list || { ids: [] });
    const next: AiConfig = { ...cfg, model: chosen.chat[0] || '', visionModel: chosen.vision, models: chosen.all.length ? chosen.all : cfg.models };
    if (!next.model) {
        throw new AiError('no model', 0, 'NO_MODEL');
    }
    const current = getAiConfig();
    if (list && current && current.key === cfg.key) {
        setAiConfig(next); // only a real list is kept (a guessed model is tried this time only)
    }
    return next;
}

/* ---------- asking ---------- */

export interface AiMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface AskOptions {
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
}

/** neighbouring messages of the same side become one (some services require turns to alternate) */
function merged(messages: AiMessage[]): AiMessage[] {
    const out: AiMessage[] = [];
    for (const m of messages) {
        const last = out[out.length - 1];
        if (last && last.role === m.role) {
            last.content += `\n\n${m.content}`;
        } else {
            out.push({ ...m });
        }
    }
    return out;
}

/* Gemini */

const noThinking = new Set<string>();

function geminiThinking(model: string): Record<string, unknown> | null {
    if (noThinking.has(model)) return null;
    if (/^gemini-([3-9]|\d\d)/.test(model) || /^gemini-[a-z-]*latest$/.test(model)) return { thinkingLevel: 'low' };
    if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
    return null;
}

async function gemini(cfg: AiConfig, model: string, body: Record<string, unknown>, ms: number): Promise<string> {
    const url = `${baseOf(cfg)}/${model.includes('/') ? model : `models/${model}`}:generateContent`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const think = geminiThinking(model);
        const gen = { ...((body.generationConfig as Record<string, unknown>) || {}) };
        if (think) gen.thinkingConfig = think;
        const res = await http(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key }, body: JSON.stringify({ ...body, generationConfig: gen }) }, ms);
        if (res.status === 400 && think && /thinking/i.test(res.raw)) {
            noThinking.add(model); // this model does not take the setting: ask again without it
            continue;
        }
        if (!ok(res)) throw failure(res);
        const cand = res.data && res.data.candidates && res.data.candidates[0];
        const parts: Array<{ text?: string; thought?: boolean }> = (cand && cand.content && cand.content.parts) || [];
        const text = parts
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text as string)
            .join('')
            .trim();
        if (!text) {
            const why = (cand && cand.finishReason) || (res.data && res.data.promptFeedback && res.data.promptFeedback.blockReason) || 'EMPTY';
            throw new AiError('empty', 200, String(why));
        }
        return text;
    }
    throw new AiError('thinking', 400, 'BAD_REQUEST');
}

/* OpenAI and the services that answer the same way */

const refusedParams = new Map<string, Set<string>>();

async function openai(cfg: AiConfig, model: string, messages: unknown[], opts: { maxTokens: number; temperature: number; json?: boolean }, ms: number): Promise<string> {
    const isOpenAI = cfg.provider === 'openai';
    const reasoning = isOpenAI && /^(o\d|gpt-([5-9]|\d\d))/.test(model);
    const id = `${cfg.provider}:${model}`;
    const refused = refusedParams.get(id) || new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const body: Record<string, unknown> = { model, messages };
        const tokens = reasoning ? Math.max(opts.maxTokens, 4096) : opts.maxTokens; // thinking counts as output too
        let tokensKey = isOpenAI ? 'max_completion_tokens' : 'max_tokens';
        if (refused.has(tokensKey)) tokensKey = tokensKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
        body[tokensKey] = tokens;
        if (!reasoning && !refused.has('temperature')) body.temperature = opts.temperature;
        if (reasoning && !refused.has('reasoning_effort')) body.reasoning_effort = 'low';
        if (opts.json && cfg.provider !== 'openrouter' && !refused.has('response_format')) body.response_format = { type: 'json_object' };
        const res = await http(`${baseOf(cfg)}/chat/completions`, { method: 'POST', headers: bearer(cfg.key), body: JSON.stringify(body) }, ms);
        if ((res.status === 400 || res.status === 422) && !ok(res)) {
            // a setting this model does not take: ask again without it
            const param = ['temperature', 'reasoning_effort', 'response_format', 'max_completion_tokens', 'max_tokens'].find((p) => res.raw.includes(p) && p in body && !refused.has(p));
            if (param) {
                refused.add(param);
                refusedParams.set(id, refused);
                continue;
            }
        }
        if (!ok(res)) throw failure(res);
        const choice = res.data && res.data.choices && res.data.choices[0];
        let content: unknown = choice && choice.message && choice.message.content;
        if (Array.isArray(content)) content = content.map((c: { text?: string }) => (c && c.text) || '').join('');
        const text = String(content || '').trim();
        if (!text) throw new AiError('empty', 200, String((choice && choice.finish_reason) || 'EMPTY').toUpperCase());
        return text;
    }
    throw new AiError('bad request', 400, 'BAD_REQUEST');
}

/* Anthropic (Claude) */

async function anthropic(cfg: AiConfig, model: string, system: string, messages: unknown[], opts: { maxTokens: number; temperature: number }, ms: number): Promise<string> {
    let withTemp = !refusedParams.get(`anthropic:${model}`)?.has('temperature');
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const body: Record<string, unknown> = { model, max_tokens: opts.maxTokens, messages };
        if (system) body.system = system;
        if (withTemp) body.temperature = opts.temperature;
        const res = await http(`${baseOf(cfg)}/messages`, { method: 'POST', headers: anthropicHeaders(cfg.key), body: JSON.stringify(body) }, ms);
        if (res.status === 400 && withTemp && /temperature/i.test(res.raw)) {
            withTemp = false;
            refusedParams.set(`anthropic:${model}`, new Set(['temperature']));
            continue;
        }
        if (!ok(res)) throw failure(res);
        const blocks: Array<{ type?: string; text?: string }> = (res.data && res.data.content) || [];
        const text = blocks
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('')
            .trim();
        if (!text) throw new AiError('empty', 200, String((res.data && res.data.stop_reason) || 'EMPTY').toUpperCase());
        return text;
    }
    throw new AiError('bad request', 400, 'BAD_REQUEST');
}

/** An answer in text. `system` holds the instructions and the data. */
export async function askAi(config: AiConfig, system: string, messages: AiMessage[], opts: AskOptions = {}): Promise<string> {
    const cfg = await withModels(config);
    const p = providerOf(cfg.provider);
    const maxTokens = opts.maxTokens ?? 2048;
    const temperature = opts.temperature ?? 0.3;
    const ms = opts.timeout ?? 60_000;
    const list = merged(messages);
    if (p.wire === 'gemini') {
        const body: Record<string, unknown> = {
            contents: list.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig: { temperature, maxOutputTokens: maxTokens },
        };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        return gemini(cfg, cfg.model, body, ms);
    }
    if (p.wire === 'anthropic') {
        return anthropic(cfg, cfg.model, system, list, { maxTokens, temperature }, ms);
    }
    const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...list];
    return openai(cfg, cfg.model, msgs, { maxTokens, temperature }, ms);
}

function parseJson(text: string): unknown {
    const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
        return JSON.parse(t);
    } catch {
        const a = t.indexOf('{');
        const b = t.lastIndexOf('}');
        if (a >= 0 && b > a) {
            try {
                return JSON.parse(t.slice(a, b + 1));
            } catch {
                // fall through
            }
        }
        throw new AiError('bad json', 200, 'BAD_JSON');
    }
}

/**
 * A JSON answer (e.g. the stock written in a text, put in rows). Gemini gets `schema` (its own format);
 * the others are told the shape in `prompt`. Uses the careful model ("visionModel") when one was chosen.
 */
export async function askAiJson(config: AiConfig, prompt: string, schema: unknown, ms = 120_000): Promise<unknown> {
    const p = providerOf(config.provider);
    const cfg = await withModels(config);
    const model = cfg.visionModel || cfg.model;
    let text: string;
    if (p.wire === 'gemini') {
        text = await gemini(
            cfg,
            model,
            {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json', responseSchema: schema },
            },
            ms,
        );
    } else if (p.wire === 'anthropic') {
        text = await anthropic(cfg, model, '', [{ role: 'user', content: prompt }], { maxTokens: 8192, temperature: 0 }, ms);
    } else {
        // plain text content: every OpenAI-style service takes it (some refuse a list of parts)
        text = await openai(cfg, model, [{ role: 'user', content: prompt }], { maxTokens: 8192, temperature: 0, json: true }, ms);
    }
    return parseJson(text);
}

/* ---------- checking a key ---------- */

export interface ConnectResult {
    ok: boolean;
    config?: AiConfig;
    /** saved, but the test answer did not come (slow, or no quota now) */
    warn?: AiError;
    error?: AiError;
}

/** Checks a key with the service (its model list, then a one-word answer) and picks the models. */
export async function connectAi(provider: ProviderId, key: string, extra: { baseUrl?: string; model?: string } = {}): Promise<ConnectResult> {
    const baseUrl = provider === 'custom' ? (extra.baseUrl || '').trim().replace(/\/+$/, '') : undefined;
    if (provider === 'custom' && (!/^https:\/\/[^\s/]+/i.test(baseUrl || '') || !(extra.model || '').trim())) {
        return { ok: false, error: new AiError('custom service needs an address and a model', 0, 'NEED_URL_MODEL') };
    }
    let list: ModelList = { ids: [] };
    try {
        list = await listModels(provider, key, baseUrl);
    } catch (e) {
        const err = asAiError(e);
        if (err.kind === 'timeout' && provider !== 'custom') {
            // the service is slow right now: keep the key, the models are taken at the first question
            return { ok: true, config: { provider, key, model: '', visionModel: '' }, warn: err };
        }
        if (provider !== 'custom' || err.kind === 'auth' || err.kind === 'network' || err.kind === 'timeout') {
            return { ok: false, error: err };
        }
        // a service without a model list: the typed model is used
    }
    const chosen = chooseModels(provider, list, provider === 'custom' ? (extra.model || '').trim() : undefined);
    if (!chosen.chat.length) {
        return { ok: false, error: new AiError('no model', 0, 'NO_MODEL') };
    }
    let lastError: AiError | null = null;
    for (const model of chosen.chat) {
        const cfg: AiConfig = { provider, key, model, visionModel: chosen.vision || (providerOf(provider).vision ? model : ''), baseUrl, models: chosen.all };
        try {
            await askAi(cfg, '', [{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 64, temperature: 0, timeout: 30_000 });
            return { ok: true, config: cfg };
        } catch (e) {
            const err = asAiError(e);
            if (err.status === 200 || err.kind === 'timeout' || err.kind === 'quota') {
                // it answered (cut short), or the key works but is slow or out of quota right now
                return { ok: true, config: cfg, warn: err.status === 200 ? undefined : err };
            }
            lastError = err;
            if (err.kind !== 'model') {
                break; // a model that does not exist: try the next one; anything else: stop
            }
        }
    }
    return { ok: false, error: lastError || new AiError('no model', 0, 'NO_MODEL') };
}

/** The models offered for answers / for reading pictures (to choose from), the chosen one first. */
export function modelChoices(cfg: AiConfig): string[] {
    const list = cfg.models && cfg.models.length ? cfg.models : [];
    return [...new Set([cfg.model, cfg.visionModel, ...list].filter(Boolean))];
}
