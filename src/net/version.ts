import { SAVE_VERSION } from '../sim/save';

/** Set by Vite (`vite.config.ts`): the commit the page was built from; absent in tests and tools. */
declare const __BUILD_ID__: string | undefined;

/**
 * This build's id for the network lobby (docs/NETWORK.md section 4): the commit and the save format.
 * Browsers with different ids would play different simulations, so the host lets in only its own.
 */
export const BUILD_ID = `${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}.${SAVE_VERSION}`;
