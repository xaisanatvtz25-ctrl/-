/** Errors from loading or saving data (GitHub), from the passwords and from the encryption. */
import { VaultError } from './vaultCore';

export class ApiError extends Error {
    status: number;
    code: string;

    constructor(code: string, status = 0) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

export function errorCode(e: unknown): string {
    return e instanceof ApiError || e instanceof VaultError ? e.code : 'network_error';
}
