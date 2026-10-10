declare module '*.jpg' {
    const src: string;
    export default src;
}


/** build time stamp, set by build.sh (the same as ?v= in index.html and in version.json) */
declare const __BUILD__: string;
