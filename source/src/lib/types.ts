export interface Product {
    id: string;
    name: string;
    sort: number;
    since: string;
    createdAt: number;
}

export interface Entry {
    id: string;
    productId: string;
    qty: number;
    date: string;
    note: string;
    createdAt: number;
    /** name of the person who recorded it */
    by?: string;
    /** last person who changed it, and when */
    editedBy?: string;
    editedAt?: number;
    /** ticked as received into the warehouse: by whom and when */
    received?: Received;
    /** the warehouse marked it ✗ "does not match": by whom, when, why (and the quantity they counted) */
    issue?: Issue;
}

export interface Received {
    by: string;
    at: number;
}

export interface Issue {
    by: string;
    at: number;
    reason: string;
    /** quantity the warehouse actually counted, when known */
    counted?: number;
}

export type MonthMap = Record<string, Entry[]>;

/** what a chat message is about: one production run (as it was when the message was written) */
export interface ChatRef {
    id: string;
    month: string;
    name: string;
    qty: number;
    date: string;
}

/**
 * A message in the production ↔ warehouse chat.
 * kind: undefined = written by a person; the others are added by the site when something happens to a run.
 */
export type ChatKind = 'flag' | 'fixed' | 'ok' | 'unflag' | 'deleted';

export interface ChatMsg {
    id: string;
    at: number;
    by: string;
    text: string;
    kind?: ChatKind;
    ref?: ChatRef;
    /** 'flag': the quantity counted by the warehouse */
    counted?: number;
    /** 'fixed': quantity before and after the change */
    from?: number;
    to?: number;
    /** id of the message this one answers */
    replyTo?: string;
}

/** one product to make, from the weekly stock analysis ("ສົ່ງໄປລາຍການຜະລິດ") */
export interface PlanItem {
    id: string;
    productId: string;
    qty: number;
    /** planned production day (YYYY-MM-DD) */
    date: string;
    /** position in the confirmed order (1, 2, 3…) */
    order: number;
    /** the analysis it came from */
    week: string;
    by: string;
    at: number;
    /** produced: when, by whom, and the production run that was recorded */
    done?: { at: number; by: string; entry?: string };
}

export interface EntryInput {
    productId: string;
    qty: number;
    date: string;
    month: string;
    note: string;
}

export interface AiAction {
    type: 'add_production' | 'add_product';
    productId?: string;
    productName?: string;
    qty?: number;
    date?: string;
    month?: string;
    note?: string;
    name?: string;
}
