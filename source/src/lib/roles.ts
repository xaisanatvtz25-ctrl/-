/**
 * Who does what. Every person who can log in has one role, kept in team.json on the "data" branch (encrypted
 * like the data, so old pages of the website never rewrite it). Someone not listed there, or while the list
 * cannot be read, can only look: summaries, PDF files and the AI.
 *
 *   production  records, changes and deletes production runs; the product list; the plan from the stock analysis
 *   warehouse   checks the runs against the warehouse: ✓ received, ✗ does not match
 *   viewer      looks only
 *
 * Production and warehouse write to each other in the chat. Everyone can download PDF files, ask the AI and
 * change their own password.
 */

export type Role = 'production' | 'warehouse' | 'viewer';

/** the kinds of change the website saves */
export type Duty =
    /** production runs: add, change, delete; plan items done */
    | 'record'
    /** the product list */
    | 'products'
    /** warehouse: ✓ received, ✗ does not match, take a mark away */
    | 'check'
    /** production ↔ warehouse messages */
    | 'chat'
    /** the stock analysis and the production plan ("ວັນນີ້ຄວນຜະລິດຫຍັງດີ") */
    | 'plan'
    /** a new password for someone who forgot theirs */
    | 'reset';

const DUTIES: Record<Role, readonly Duty[]> = {
    production: ['record', 'products', 'chat', 'plan', 'reset'],
    warehouse: ['check', 'chat'],
    viewer: [],
};

export const ROLES: readonly Role[] = ['production', 'warehouse', 'viewer'];

export function isRole(v: unknown): v is Role {
    return v === 'production' || v === 'warehouse' || v === 'viewer';
}

/** the role includes this duty */
export function may(role: Role, duty: Duty): boolean {
    return DUTIES[role].includes(duty);
}

/** the role changes anything at all (needs the edit password then) */
export function writes(role: Role): boolean {
    return DUTIES[role].some((d) => d !== 'reset');
}

/** the duty of a history record (who may undo it); null: cannot be undone */
export function dutyOfRecord(r: { kind: string; act: string }): Duty | null {
    if (r.act === 'undo' || r.act === 'password') {
        return null;
    }
    if (r.kind === 'product') {
        return 'products';
    }
    if (r.kind === 'entry') {
        return r.act === 'receive' || r.act === 'unreceive' || r.act === 'flag' || r.act === 'unflag' ? 'check' : 'record';
    }
    return null;
}

/* ---------- team.json ---------- */

export const TEAM_FILE = 'team.json';

export interface TeamDoc {
    milako: 'team';
    v: 1;
    /** person id (as in access.json) → role */
    roles: Record<string, Role>;
    updatedAt: number;
}

const ID_RE = /^u[0-9a-z]{1,12}$/;

/** team.json as it is on GitHub (anything odd is left out: that person only looks) */
export function parseTeam(text: string): TeamDoc {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        raw = null;
    }
    const o = raw as Partial<TeamDoc> | null;
    const roles: Record<string, Role> = {};
    if (o && o.milako === 'team' && o.roles && typeof o.roles === 'object') {
        for (const [id, role] of Object.entries(o.roles)) {
            if (ID_RE.test(id) && isRole(role)) {
                roles[id] = role;
            }
        }
    }
    return { milako: 'team', v: 1, roles, updatedAt: Number(o && o.updatedAt) || 0 };
}

export function serializeTeam(doc: TeamDoc): string {
    const ids = Object.keys(doc.roles).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const lines = ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(doc.roles[id])}`);
    return '{\n "milako": "team",\n "v": 1,\n "roles": {\n' + lines.join(',\n') + '\n },\n "updatedAt": ' + (Math.round(doc.updatedAt) || 0) + '\n}\n';
}

export function roleOf(team: TeamDoc | null, userId: string): Role {
    return (team && team.roles[userId]) || 'viewer';
}
