/**
 * The website is locked: only the people in access.json (at most 6) can log in, and everything stored is encrypted.
 * The edit password unlocks adding and editing. The data lives in this GitHub repository (branch "data"), each save
 * one commit, and changes can be undone from the history page.
 */
export const REPO_OWNER = 'xaisanatvtz25-ctrl';
export const REPO_NAME = '-';
export const DATA_BRANCH = 'data';
export const DATA_FILE = 'data.json';
/** the GitHub key for saving, encrypted with the edit password */
export const KEY_FILE = 'editor.json';
/** who added, changed or deleted what, and when */
export const HISTORY_FILE = 'history.json';
/** the warehouse check-in started this month; older runs are not counted as waiting */
export const WAREHOUSE_SINCE = '2026-10';

/** GitHub page that creates the saving key, filled in as far as GitHub allows */
export const TOKEN_URL =
    'https://github.com/settings/personal-access-tokens/new' +
    `?name=${encodeURIComponent('Milako website')}` +
    `&description=${encodeURIComponent('Lets the Milako production website save data to the repository "-".')}` +
    `&target_name=${encodeURIComponent(REPO_OWNER)}` +
    '&expires_in=none&contents=write';

/** how often an open page looks for changes made on other devices */
export const REFRESH_MS = 120_000;
